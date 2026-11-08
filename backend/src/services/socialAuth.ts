/** @file Validate native provider exchange requests and advertise explicitly enabled Firebase providers. */
import { isSocialAuthProvider, SOCIAL_AUTH_PROVIDERS, type SocialAuthProvider } from '../../../shared/socialAuth';
import { usesFirebaseAuthentication } from '../config/credentialProvider';

export type SocialCredential = { provider: SocialAuthProvider; idToken: string; nonce?: string };

/** Return only explicitly enabled providers; portable local-password deployments expose none. */
export function enabledSocialProviders(env: NodeJS.ProcessEnv = process.env): SocialAuthProvider[] {
    if (!usesFirebaseAuthentication(env)) return [];
    return [...new Set((env.FIREBASE_SOCIAL_PROVIDERS ?? '').split(',').map(value => value.trim()).filter(isSocialAuthProvider))];
}

/** Bound credential sizes and require Apple's raw nonce before any external provider request. */
export function parseSocialCredential(body: unknown): SocialCredential | null {
    if (!body || typeof body !== 'object') return null;
    const { provider, id_token: idToken, nonce } = body as Record<string, unknown>;
    if (!isSocialAuthProvider(provider) || typeof idToken !== 'string' || !idToken.trim() || idToken.length > 16384) return null;
    if (provider === SOCIAL_AUTH_PROVIDERS.APPLE && (typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(nonce))) return null;
    return { provider, idToken, ...(provider === SOCIAL_AUTH_PROVIDERS.APPLE ? { nonce: nonce as string } : {}) };
}

/** Safe, bounded exchange failures that may be shown without forwarding provider response text. */
export class SocialAuthRejected extends Error {
    /** Record a public recovery code; no provider credentials or account details are retained. */
    constructor(public readonly code: 'SOCIAL_AUTH_REJECTED' | 'SOCIAL_REGISTRATION_REQUIRED' | 'SOCIAL_ACCOUNT_CONFLICT' = 'SOCIAL_AUTH_REJECTED') {
        super(code);
    }
}
