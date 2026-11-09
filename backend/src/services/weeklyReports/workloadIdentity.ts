/** @file Google metadata identity exchange for OpenAI; credentials stay in memory and refresh before absolute expiry. */

import { z } from 'zod';
import { MS_PER_MINUTE } from '../../utils/time';

const GOOGLE_IDENTITY_ENDPOINT = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const OPENAI_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const DEFAULT_AUDIENCE = 'https://api.openai.com/v1';
const AUTH_REQUEST_TIMEOUT_MS = 5_000; // Bound each authentication hop inside the report's overall deadline.
const REFRESH_MARGIN_MS = MS_PER_MINUTE; // Leave room for clock skew and a full report request before token expiry.

export type OpenAIWorkloadIdentityConfiguration = {
    identityProviderId: string;
    serviceAccountId: string;
    audience: string;
};

const credentialSchema = z.object({
    access_token: z.string().min(1).regex(/^\S+$/),
    token_type: z.literal('Bearer'),
    expires_at: z.number().int().positive(),
    expires_in: z.number().int().positive()
});
type Credential = { token: string; expiresAt: number };
let cached: { key: string; credential: Credential } | undefined;
let inFlight: { key: string; promise: Promise<Credential> } | undefined;

/** Require both OpenAI mapping identifiers; an API key never enables or substitutes for federation. */
export function getOpenAIWorkloadIdentityConfiguration(env: NodeJS.ProcessEnv = process.env): OpenAIWorkloadIdentityConfiguration | null {
    const identityProviderId = env.OPENAI_IDENTITY_PROVIDER_ID?.trim();
    const serviceAccountId = env.OPENAI_SERVICE_ACCOUNT_ID?.trim();
    const audience = env.OPENAI_WIF_AUDIENCE?.trim() || DEFAULT_AUDIENCE;
    return identityProviderId && serviceAccountId ? { identityProviderId, serviceAccountId, audience } : null;
}

function configurationKey(config: OpenAIWorkloadIdentityConfiguration): string {
    return JSON.stringify([config.identityProviderId, config.serviceAccountId, config.audience]);
}

/** Never follow credential-bearing redirects or expose metadata/provider bodies in failure messages. */
async function exchangeIdentity(config: OpenAIWorkloadIdentityConfiguration, signal: AbortSignal): Promise<Credential> {
    try {
        const url = new URL(GOOGLE_IDENTITY_ENDPOINT);
        url.searchParams.set('audience', config.audience);
        url.searchParams.set('format', 'full');
        const identity = await fetch(url, {
            headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)])
        });
        if (!identity.ok) throw new Error();
        const subjectToken = (await identity.text()).trim();
        if (!subjectToken || /\s/.test(subjectToken)) throw new Error();
        const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
            method: 'POST', redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)]),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
                subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
                subject_token: subjectToken,
                identity_provider_id: config.identityProviderId,
                service_account_id: config.serviceAccountId
            })
        });
        if (!response.ok) throw new Error();
        const parsed = credentialSchema.safeParse(await response.json());
        // Absolute expiry includes time already spent delivering the token; expires_in cannot extend it.
        if (!parsed.success || parsed.data.expires_at * 1000 <= Date.now() + REFRESH_MARGIN_MS) throw new Error();
        return { token: parsed.data.access_token, expiresAt: parsed.data.expires_at * 1000 };
    } catch {
        throw new Error('OpenAI workload identity exchange failed. Check Cloud Run metadata access and the OpenAI provider, audience, service-account mapping and permissions.');
    }
}

/** Reuse a valid mapping-scoped token; coalesce concurrent refreshes and retry failed exchanges on the next call. */
export async function getOpenAIWorkloadAccessToken(config: OpenAIWorkloadIdentityConfiguration, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = configurationKey(config);
    if (cached?.key === key && cached.credential.expiresAt > Date.now() + REFRESH_MARGIN_MS) return cached.credential.token;
    if (inFlight?.key === key) return (await inFlight.promise).token;
    const promise = exchangeIdentity(config, signal);
    inFlight = { key, promise };
    try {
        const credential = await promise;
        cached = { key, credential };
        return credential.token;
    } finally {
        if (inFlight?.promise === promise) inFlight = undefined;
    }
}

/** Discard a rejected token without clearing a newer credential acquired by another request. */
export function invalidateOpenAIWorkloadAccessToken(config: OpenAIWorkloadIdentityConfiguration, token: string): void {
    if (cached?.key === configurationKey(config) && cached.credential.token === token) cached = undefined;
}
