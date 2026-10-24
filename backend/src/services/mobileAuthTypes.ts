/** @file Native session and phone/watch pairing wire types with internal credential details separated from responses. */

import type { MobileDevicePlatform as MobileDevicePlatformWire } from '../../../shared/domain';
import type { UserClientPayload } from '../utils/userSerialization';

export type MobileTokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

export type IssuedMobileSession = MobileTokenPair & { sessionId: number };

export type WearAuthPrincipal = Pick<
  UserClientPayload,
  'id' | 'timezone' | 'language' | 'weight_unit' | 'height_unit'
>;

type MobileAuthPrincipal = UserClientPayload | WearAuthPrincipal;

export type MobileAuthSessionPayload = MobileTokenPair & {
  user: MobileAuthPrincipal;
};

export type WearPairingCredentialPayload = {
  pairingToken: string;
  serverOrigin: string;
  watchDeviceId: string;
  protocolVersion: number;
  challenge: string;
  expiresAt: Date;
};

export type WearPairingErrorCode =
  | 'INVALID_PAIRING_REQUEST'
  | 'PAIRING_PHONE_SESSION_REQUIRED'
  | 'INVALID_PAIRING_CREDENTIAL'
  | 'PAIRING_CREDENTIAL_EXPIRED'
  | 'PAIRING_CREDENTIAL_USED'
  | 'PAIRING_RESPONSE_LOST'
  | 'PAIRING_BINDING_MISMATCH'
  | 'PAIRING_SIGNATURE_INVALID';

export type WearPairingFailure = {
  ok: false;
  status: 400 | 401 | 403 | 409 | 410;
  code: WearPairingErrorCode;
  message: string;
};

export type WearPairingIssueResult =
  | { ok: true; credential: WearPairingCredentialPayload }
  | WearPairingFailure;

export type WearPairingExchangeResult =
  | { ok: true; payload: MobileAuthSessionPayload }
  | WearPairingFailure;

export type MobileSessionSummary = {
  id: number;
  device_id: string;
  device_platform: MobileDevicePlatformWire;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
  refresh_expires_at: string;
  current: boolean;
};

export type AuthenticateAccessTokenResult =
  | {
      ok: true;
      user: MobileAuthPrincipal;
      sessionId: number;
      deviceId: string;
      devicePlatform: MobileDevicePlatformWire;
    }
  | { ok: false; status: number; message: string };
