/** @file Select exactly one password authority while retaining the security generation used by guarded session issuance. */
import { verifyLocalPassword } from './credentialVerification';
import { firebaseAuthority } from './firebaseAuthority';

/** Return the verified generation or null for rejection; provider outages throw and never use a local fallback. */
export async function verifyAccountPassword(password: string, user: { id: number; password_hash: string; credential_security_version?: number } | null | undefined): Promise<number | null> {
  const authority = firebaseAuthority();
  if (authority) return user ? authority.verify(user.id, password) : null;
  return await verifyLocalPassword(password, user?.password_hash) && user ? user.credential_security_version ?? 0 : null;
}
