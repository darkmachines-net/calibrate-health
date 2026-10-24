/** @file credential Verification: Local runtime verification; account lookup, authorization and session issuance remain caller-owned. */

import bcrypt from 'bcryptjs';
import { DUMMY_AUTH_PASSWORD_HASH, validateBcryptPasswordByteLength } from '../utils/authCredentials';

export type CredentialIdentity =
  | { provider: 'local'; userId: number; passwordHash: string }
  | { provider: 'firebase'; userId: number; projectId: string; uid: string; email: string };

export class CredentialProviderUnavailable extends Error {
  /** Represent provider infrastructure failure without exposing provider details or treating it as invalid credentials. */
  constructor() { super('Credential provider unavailable'); }
}

export interface FirebaseCredentialVerifier {
  projectId: string;
  /** Must use Admin SDK verifyIdToken(token, true), never decode-only JWT parsing. */
  verifyIdToken(token: string): Promise<{ uid: string; aud: string; auth_time: number }>;
}

/** Local runtime verification; account lookup, authorization and session issuance remain caller-owned. */
export async function verifyLocalPassword(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  // Callers retain their existing input policy, including legacy reauthentication.
  const matches = await bcrypt.compare(password, passwordHash || DUMMY_AUTH_PASSWORD_HASH);
  return Boolean(passwordHash) && matches;
}

/** Firebase remains an injected preparation adapter, not an enabled runtime authority. */
export class CredentialProvider {
  /** Bind optional injected Firebase verification dependencies; this preparation adapter does not activate runtime authority. */
  constructor(private readonly firebase?: {
    apiKey: string;
    verifier: FirebaseCredentialVerifier;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {}

  /** Check the selected credential authority without local fallback; sanitize unavailable-provider failures separately from rejection. */
  async verify(identity: CredentialIdentity, password: string): Promise<boolean> {
    if (identity.provider === 'local') {
      if (validateBcryptPasswordByteLength(password)) return false;
      return verifyLocalPassword(password, identity.passwordHash);
    }
    if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0 ||
        ![identity.projectId, identity.uid, identity.email].every(value => typeof value === 'string' && value.trim()) ||
        !this.firebase || !this.firebase.apiKey || identity.projectId !== this.firebase.verifier.projectId) {
      throw new CredentialProviderUnavailable();
    }
    const { apiKey, verifier } = this.firebase;
    const timeoutMs = this.firebase.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new CredentialProviderUnavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CredentialProviderUnavailable());
      }, timeoutMs);
    });
    try {
      return await Promise.race([timedOut, (async () => {
        const response = await (this.firebase!.fetch ?? fetch)(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: identity.email, password, returnSecureToken: true })
          }
        );
        const body = await response.json() as {
          idToken?: unknown; localId?: unknown; error?: { message?: unknown };
        };
        if (!response.ok) {
          const code = body?.error?.message;
          if (response.status === 400 && ['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'USER_DISABLED'].includes(String(code))) {
            return false;
          }
          throw new CredentialProviderUnavailable();
        }
        if (typeof body?.idToken !== 'string' || body.localId !== identity.uid) return false;
        const verified = await verifier.verifyIdToken(body.idToken);
        const now = Math.floor(Date.now() / 1000);
        return verified.uid === identity.uid && verified.aud === identity.projectId &&
          Number.isSafeInteger(verified.auth_time) && verified.auth_time <= now + 30 && verified.auth_time >= now - 60;
        // The REST response's refreshToken and ID token are never returned, persisted, or logged.
      })()]);
    } catch {
      // Do not expose request URLs, passwords, tokens, or raw provider error text.
      throw new CredentialProviderUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
