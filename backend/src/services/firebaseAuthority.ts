/** @file Firebase password and native provider credentials with immutable SQL binding and fail-closed session reconciliation. */
import { randomUUID } from 'node:crypto';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth, type UserRecord } from 'firebase-admin/auth';
import prisma from '../config/database';
import { usesFirebaseAuthentication, validateCredentialProviderConfiguration } from '../config/credentialProvider';
import { CredentialProviderUnavailable } from './credentialVerification';
import { revokeAccountCredentials } from './accountRevocation';
import { USER_CLIENT_SELECT } from '../utils/userSerialization';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '../../../shared/legalVersions';
import { MS_PER_MINUTE } from '../utils/time';
import { normalizeEmailCredential } from '../utils/authCredentials';
import { SocialAuthRejected, type SocialCredential } from './socialAuth';

type Settings = { projectId: string; apiKey: string; origin: string; emulatorHost?: string };
type RestResponse = { idToken?: string; localId?: string; email?: string; needConfirmation?: boolean; error?: { message?: string } };
const REJECTED_CODES = new Set(['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'USER_DISABLED', 'INVALID_OOB_CODE', 'EXPIRED_OOB_CODE']);

/** Read only provider error codes; provider messages and response bodies must never enter application logs. */
function providerCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** One configured Firebase project owns passwords; SQL continues to own profiles, authorization and opaque application sessions. */
export class FirebaseAuthority {
  /** Inject SDK, database and HTTP boundaries for emulator and failure testing without a second runtime authority. */
  constructor(private readonly auth: Auth, private readonly database: typeof prisma, private readonly settings: Settings, private readonly fetcher: typeof fetch = fetch) {}

  /** Use the selected Firebase endpoint with bounded transport, returning null only for expected credential rejection. */
  private async request(method: string, body: Record<string, unknown>): Promise<RestResponse | null> {
    const host = this.settings.emulatorHost
      ? `http://${this.settings.emulatorHost}/identitytoolkit.googleapis.com`
      : 'https://identitytoolkit.googleapis.com';
    try {
      const response = await this.fetcher(`${host}/v1/accounts:${method}?key=${encodeURIComponent(this.settings.apiKey)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await response.json() as RestResponse;
      if (!response.ok) {
        if (method === 'signInWithIdp' && response.status === 400) {
          const code = data.error?.message?.split(' : ')[0];
          if (['EMAIL_EXISTS', 'FEDERATED_USER_ID_ALREADY_LINKED'].includes(code ?? '')) throw new SocialAuthRejected('SOCIAL_ACCOUNT_CONFLICT');
          if (['INVALID_IDP_RESPONSE', 'INVALID_ID_TOKEN', 'MISSING_OR_INVALID_NONCE', 'USER_DISABLED'].includes(code ?? '')) throw new SocialAuthRejected();
        }
        if (response.status === 400 && REJECTED_CODES.has(data.error?.message ?? '')) return null;
        throw new CredentialProviderUnavailable();
      }
      return data;
    } catch (error) {
      if (error instanceof SocialAuthRejected) throw error;
      throw new CredentialProviderUnavailable();
    }
  }

  /** Fetch only the immutable mapped UID in this project; never link an account by matching its email. */
  private async identity(userId: number) {
    const identity = await this.database.firebaseIdentity.findUnique({ where: { user_id: userId } });
    if (!identity || identity.project_id !== this.settings.projectId) return null;
    return identity;
  }

  /** Reconcile external password reset, revocation, disablement and deletion before granting local session access. */
  async reconcile(userId: number): Promise<{ allowed: boolean; changed: boolean; version: number }> {
    const identity = await this.identity(userId);
    if (!identity) return { allowed: false, changed: false, version: -1 };
    return this.database.$transaction(async tx => {
      // Fetch under the account lock so an older concurrent provider snapshot cannot restore revoked authority.
      const user = await tx.user.update({ where: { id: userId }, data: { credential_security_version: { increment: 0 } } });
      const current = await tx.firebaseIdentity.findUniqueOrThrow({ where: { user_id: userId } });
      let remote: UserRecord | null;
      try { remote = await this.auth.getUser(identity.uid); }
      catch (error) {
        if (providerCode(error) !== 'auth/user-not-found') throw new CredentialProviderUnavailable();
        remote = null;
      }
      const stamp = JSON.stringify([remote?.tokensValidAfterTime ?? null, remote?.email?.toLowerCase() ?? null, remote?.disabled ?? true, remote?.emailVerified ?? false]);
      const allowed = Boolean(remote && !remote.disabled && !current.deletion_pending_at && remote.email?.toLowerCase() === user.email.toLowerCase());
      const changed = current.security_stamp !== stamp;
      if (changed || !allowed) {
        await revokeAccountCredentials(tx, userId);
        if (changed) await tx.user.update({ where: { id: userId }, data: { credential_security_version: { increment: 1 } } });
        await tx.firebaseIdentity.update({ where: { user_id: userId }, data: { security_stamp: stamp } });
      }
      const verified = allowed && remote?.emailVerified;
      if (Boolean(user.email_verified_at) !== Boolean(verified)) {
        await tx.user.update({ where: { id: userId }, data: { email_verified_at: verified ? new Date() : null } });
      }
      return { allowed, changed, version: user.credential_security_version + (changed ? 1 : 0) };
    }, { timeout: 15000 });
  }

  /** Verify a password with Firebase and revoked-token checking, then return the reconciled SQL security generation. */
  async verify(userId: number, password: string): Promise<number | null> {
    const identity = await this.identity(userId);
    const user = await this.database.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!identity || !user) return null;
    const before = await this.reconcile(userId);
    if (!before.allowed) return null;
    const signed = await this.request('signInWithPassword', { email: user.email, password, returnSecureToken: true });
    if (!signed?.idToken || signed.localId !== identity.uid) return null;
    try {
      const token = await this.auth.verifyIdToken(signed.idToken, true);
      const now = Math.floor(Date.now() / 1000);
      if (token.uid !== identity.uid || token.aud !== this.settings.projectId || token.auth_time < now - 60 || token.auth_time > now + 30) return null;
    } catch (error) {
      if (['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes(providerCode(error) ?? '')) return null;
      throw new CredentialProviderUnavailable();
    }
    const state = await this.reconcile(userId);
    return state.allowed && state.version === before.version ? state.version : null;
  }

  /** Create a new provider identity and matching SQL account; never adopt an existing Firebase email or UID. */
  async register(email: string, password: string, hosted: boolean) {
    const uid = `cal_new_${randomUUID()}`;
    let createdUserId: number | undefined;
    try { await this.auth.createUser({ uid, email, password, emailVerified: false }); }
    catch { throw new CredentialProviderUnavailable(); }
    try {
      const user = await this.database.user.create({ data: {
        email, password_hash: `!firebase:${randomUUID()}`, email_verified_at: null,
        firebase_identity: { create: { installation_id: this.settings.projectId, source_id: 'native-registration', project_id: this.settings.projectId, uid } },
        legal_acceptances: hosted ? { create: { terms_version: CURRENT_TERMS_VERSION, privacy_version: CURRENT_PRIVACY_VERSION } } : undefined
      }, select: USER_CLIENT_SELECT });
      createdUserId = user.id;
      await this.reconcile(user.id);
      return user;
    } catch {
      if (createdUserId) {
        await this.deleteAccount(createdUserId).catch(() => {});
        throw new CredentialProviderUnavailable();
      }
      // This UID was allocated by this attempt. Cleanup never targets an email-matched existing user.
      await this.auth.deleteUser(uid).catch(() => {});
      throw new CredentialProviderUnavailable();
    }
  }

  /**
   * Exchange a native Google/Apple credential through Firebase, then resolve only its verified project/UID.
   * New SQL accounts require explicit registration consent; email collisions never link local accounts.
   * Provider credentials remain ephemeral and the returned security generation guards session issuance.
   */
  async authenticateSocial(credential: SocialCredential, registration: boolean, hosted: boolean): Promise<{ userId: number; version: number }> {
    const postBody = new URLSearchParams({ providerId: credential.provider, id_token: credential.idToken });
    if (credential.nonce) postBody.set('nonce', credential.nonce);
    const signed = await this.request('signInWithIdp', {
      requestUri: this.settings.origin, postBody: postBody.toString(), returnSecureToken: true
    });
    if (signed?.needConfirmation) throw new SocialAuthRejected('SOCIAL_ACCOUNT_CONFLICT');
    if (!signed?.idToken || !signed.localId) throw new SocialAuthRejected();
    let token;
    try { token = await this.auth.verifyIdToken(signed.idToken, true); }
    catch (error) {
      if (['auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-disabled', 'auth/user-not-found'].includes(providerCode(error) ?? '')) throw new SocialAuthRejected();
      throw new CredentialProviderUnavailable();
    }
    const now = Math.floor(Date.now() / 1000);
    const email = normalizeEmailCredential(token.email);
    if (token.uid !== signed.localId || token.aud !== this.settings.projectId ||
        token.firebase?.sign_in_provider !== credential.provider || token.firebase?.tenant ||
        !Number.isFinite(token.auth_time) || token.auth_time < now - 60 || token.auth_time > now + 30 ||
        !email || token.email_verified !== true) throw new SocialAuthRejected();
    const key = { project_id_uid: { project_id: this.settings.projectId, uid: token.uid } };
    let identity = await this.database.firebaseIdentity.findUnique({ where: key });
    if (!identity) {
      if (!registration) throw new SocialAuthRejected('SOCIAL_REGISTRATION_REQUIRED');
      const collision = await this.database.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
      if (collision) throw new SocialAuthRejected('SOCIAL_ACCOUNT_CONFLICT');
      try {
        await this.database.user.create({ data: {
          email, password_hash: `!firebase:${randomUUID()}`, email_verified_at: new Date(),
          firebase_identity: { create: { installation_id: this.settings.projectId, source_id: 'social-registration', project_id: this.settings.projectId, uid: token.uid } },
          legal_acceptances: hosted ? { create: { terms_version: CURRENT_TERMS_VERSION, privacy_version: CURRENT_PRIVACY_VERSION } } : undefined
        } });
      } catch (error) {
        // Concurrent attempts may create this same immutable binding; never adopt a different email-matched UID.
        if (providerCode(error) !== 'P2002') throw error;
      }
      identity = await this.database.firebaseIdentity.findUnique({ where: key });
      if (!identity) throw new SocialAuthRejected('SOCIAL_ACCOUNT_CONFLICT');
    }
    const before = await this.reconcile(identity.user_id);
    if (!before.allowed) throw new SocialAuthRejected();
    // Recheck revocation after reconciliation; a provider reset between exchange and lookup must not mint a fresh local session.
    try { await this.auth.verifyIdToken(signed.idToken, true); }
    catch (error) {
      if (['auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token', 'auth/argument-error', 'auth/user-disabled', 'auth/user-not-found'].includes(providerCode(error) ?? '')) throw new SocialAuthRejected();
      throw new CredentialProviderUnavailable();
    }
    const after = await this.reconcile(identity.user_id);
    if (!after.allowed || after.version !== before.version) throw new SocialAuthRejected();
    return { userId: identity.user_id, version: after.version };
  }

  /** Send Firebase's hosted verification or reset email; ephemeral provider tokens never leave this method. */
  async sendEmail(userId: number, kind: 'VERIFY_EMAIL' | 'PASSWORD_RESET'): Promise<boolean> {
    const identity = await this.identity(userId);
    if (!identity) return false;
    try {
      const remote = await this.auth.getUser(identity.uid);
      const local = await this.database.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (remote.disabled || !local || remote.email?.toLowerCase() !== local.email.toLowerCase()) return false;
      if (kind === 'VERIFY_EMAIL' && remote.emailVerified) { await this.reconcile(userId); return true; }
      let idToken: string | undefined;
      if (kind === 'VERIFY_EMAIL') {
        const custom = await this.auth.createCustomToken(identity.uid);
        const signed = await this.request('signInWithCustomToken', { token: custom, returnSecureToken: true });
        if (!signed?.idToken) return false;
        const verified = await this.auth.verifyIdToken(signed.idToken, true);
        if (verified.uid !== identity.uid || verified.aud !== this.settings.projectId) return false;
        idToken = signed.idToken;
      }
      return Boolean(await this.request('sendOobCode', {
        requestType: kind, email: remote.email, ...(idToken ? { idToken } : {}),
        continueUrl: `${this.settings.origin}/login`, canHandleCodeInApp: false
      }));
    } catch { return false; }
  }

  /** Apply a Firebase verification code, resolving the account exclusively by immutable project/UID. */
  async confirmEmail(code: string): Promise<number | null> {
    const result = await this.request('update', { oobCode: code });
    if (!result?.localId) return null;
    const identity = await this.database.firebaseIdentity.findUnique({ where: { project_id_uid: { project_id: this.settings.projectId, uid: result.localId } } });
    if (!identity) return null;
    const state = await this.reconcile(identity.user_id);
    return state.allowed ? identity.user_id : null;
  }

  /** Let Firebase validate a recovery code and replace the password; reconcile local revocation before returning success. */
  async resetPassword(code: string, password: string): Promise<boolean> {
    const result = await this.request('resetPassword', { oobCode: code, newPassword: password });
    if (!result?.email) return false;
    const user = await this.database.user.findFirst({ where: { email: { equals: result.email, mode: 'insensitive' } }, select: { id: true } });
    if (!user) return false;
    const state = await this.reconcile(user.id);
    if (!state.allowed) return false;
    await this.revokeLocalCredentials(user.id);
    return true;
  }

  /** Revoke even when provider operations share a timestamp second; order writes against all verified session issuers. */
  private async revokeLocalCredentials(userId: number): Promise<void> {
    await this.database.$transaction(async tx => {
      await tx.user.update({ where: { id: userId }, data: { credential_security_version: { increment: 1 } } });
      await revokeAccountCredentials(tx, userId);
    });
  }

  /** Replace a reauthenticated user's Firebase password and revoke every local session, including the caller. */
  async changePassword(userId: number, password: string): Promise<void> {
    const identity = await this.identity(userId);
    if (!identity) throw new CredentialProviderUnavailable();
    try {
      await this.auth.updateUser(identity.uid, { password });
      await this.auth.revokeRefreshTokens(identity.uid);
      await this.reconcile(userId);
      // Explicit revocation also covers two provider changes inside the same timestamp second.
      await this.revokeLocalCredentials(userId);
    } catch { throw new CredentialProviderUnavailable(); }
  }

  /** Remove the mapped Firebase identity first; a retry can finish SQL deletion after a lost acknowledgement. */
  async deleteIdentity(userId: number): Promise<void> {
    const identity = await this.identity(userId);
    if (!identity) throw new CredentialProviderUnavailable();
    try { await this.auth.deleteUser(identity.uid); }
    catch (error) { if (providerCode(error) !== 'auth/user-not-found') throw new CredentialProviderUnavailable(); }
  }

  /** Persist deletion intent and revoke access before remote deletion; maintenance completes uncertain provider operations. */
  async deleteAccount(userId: number): Promise<boolean> {
    if (!await this.identity(userId)) throw new CredentialProviderUnavailable();
    await this.database.$transaction(async tx => {
      await tx.user.update({ where: { id: userId }, data: { credential_security_version: { increment: 1 } } });
      await tx.firebaseIdentity.update({ where: { user_id: userId }, data: { deletion_pending_at: new Date() } });
      await revokeAccountCredentials(tx, userId);
    });
    await this.finishDeletion(userId);
    return true;
  }

  /** Complete only an already authorized deletion, accepting provider-not-found on retry. */
  private async finishDeletion(userId: number): Promise<void> {
    const identity = await this.identity(userId);
    if (!identity?.deletion_pending_at) return;
    await this.deleteIdentity(userId);
    await this.database.user.deleteMany({ where: { id: userId } });
  }

  /** Retry a bounded batch of durable deletion intents; errors stay private and leave intent available for the next pass. */
  async retryDeletions(): Promise<void> {
    const pending = await this.database.firebaseIdentity.findMany({
      where: { project_id: this.settings.projectId, deletion_pending_at: { not: null } }, take: 20, orderBy: { deletion_pending_at: 'asc' }, select: { user_id: true }
    });
    for (const identity of pending) await this.finishDeletion(identity.user_id).catch(() => {});
  }
}

let instance: FirebaseAuthority | undefined;
/** Lazily initialize keyless Admin access only in Firebase deployments; local installations never call Google. */
export function firebaseAuthority(): FirebaseAuthority | null {
  if (!usesFirebaseAuthentication()) return null;
  validateCredentialProviderConfiguration();
  if (!instance) {
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    const app = getApps().find(app => app.name === 'calibrate-auth') ?? initializeApp({
      projectId, credential: applicationDefault(), serviceAccountId: process.env.FIREBASE_SERVICE_ACCOUNT
    }, 'calibrate-auth');
    instance = new FirebaseAuthority(getAuth(app), prisma, {
      projectId, apiKey: process.env.FIREBASE_API_KEY!, origin: process.env.PUBLIC_APP_ORIGIN || 'https://calibratehealth.app',
      emulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST
    });
  }
  return instance;
}

/** Recheck provider security before using existing local credentials; changed authority invalidates this request. */
export async function firebaseSessionAllowed(userId: number): Promise<boolean> {
  const authority = firebaseAuthority();
  if (!authority) return true;
  const state = await authority.reconcile(userId);
  return state.allowed && !state.changed;
}

/** Resume durable provider deletions at startup and once per minute without overlapping maintenance runs. */
export function startFirebaseAccountMaintenance(): void {
  const authority = firebaseAuthority();
  if (!authority) return;
  let running = false;
  /** Keep transient provider/database failures retryable without logging account or provider data. */
  const retry = async () => {
    if (running) return;
    running = true;
    try { await authority.retryDeletions(); } catch { console.warn('Firebase account cleanup will retry; check provider connectivity if deletion remains pending.'); }
    finally { running = false; }
  };
  void retry();
  const interval = setInterval(() => { void retry(); }, MS_PER_MINUTE);
  interval.unref();
}
