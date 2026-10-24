/** @file mcp OAuth: Database-backed OAuth 2.1 credential lifecycle for Calibrate's remote MCP server. */

import { verifyLocalPassword } from './credentialVerification';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import { ACCOUNT_ACCESS_SELECT, serializeAccountAccess } from './accountAccess';
import { normalizeEmailCredential, validateBcryptPasswordByteLength } from '../utils/authCredentials';

export const MCP_OAUTH_AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const MCP_OAUTH_AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const MCP_OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_OAUTH_UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

export type McpOAuthErrorReason =
  | 'expired'
  | 'invalid_credentials'
  | 'account_access_required'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'invalid_target'
  | 'not_found';

export class McpOAuthError extends Error {
  /** Expose a bounded OAuth failure reason without retaining credential or provider payload details. */
  constructor(public readonly reason: McpOAuthErrorReason) {
    super(reason);
    this.name = 'McpOAuthError';
  }
}

export interface StoredOAuthClient extends Record<string, unknown> {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
}

export type McpOAuthAuthorizationRequestInput = {
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource: string;
};

export type McpOAuthAuthorizationRequestView = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: string;
};

export type McpOAuthApprovalResult = {
  code: string;
  redirectUri: string;
  state?: string;
};

export type McpOAuthTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
};

export type McpOAuthAccessInfo = {
  clientId: string;
  userId: number;
  scopes: string[];
  expiresAt: number;
  resource: string;
};

export type McpOAuthConnection = {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  resource: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
};

type CredentialPurpose = 'request' | 'code' | 'access' | 'refresh';

const APPROVAL_USER_SELECT = {
  id: true,
  password_hash: true,
  credential_security_version: true,
  ...ACCOUNT_ACCESS_SELECT
} satisfies Prisma.UserSelect;

/** Database-backed OAuth 2.1 credential lifecycle for Calibrate's remote MCP server. */
export class McpOAuthService {
  /** Bind the persistent OAuth registry and injectable clock used for expiry and rotation checks. */
  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly clock: () => Date = () => new Date()
  ) {}

  /** Read validated public-client metadata, returning undefined for missing or malformed registrations. */
  async getClient(clientId: string): Promise<StoredOAuthClient | undefined> {
    const client = await this.database.mcpOAuthClient.findUnique({
      where: { client_id: clientId },
      select: { metadata_json: true }
    });
    return client ? parseStoredClient(client.metadata_json) : undefined;
  }

  /** Sanitize public registration metadata, prune abandoned clients and persist the normalized client. */
  async saveClient(client: StoredOAuthClient): Promise<StoredOAuthClient> {
    const sanitized = sanitizePublicClient(client);
    const abandonedBefore = new Date(this.clock().getTime() - MCP_OAUTH_UNUSED_CLIENT_TTL_MS);
    await this.database.mcpOAuthClient.deleteMany({
      where: {
        updated_at: { lt: abandonedBefore },
        authorization_requests: { none: {} },
        authorization_codes: { none: {} },
        grants: { none: {} }
      }
    });
    await this.database.mcpOAuthClient.upsert({
      where: { client_id: sanitized.client_id },
      create: {
        client_id: sanitized.client_id,
        metadata_json: sanitized as Prisma.InputJsonObject
      },
      update: { metadata_json: sanitized as Prisma.InputJsonObject }
    });
    return sanitized;
  }

  /** Validate client, redirect, PKCE, scopes and resource before persisting a short-lived consent request. */
  async beginAuthorization(
    input: McpOAuthAuthorizationRequestInput
  ): Promise<McpOAuthAuthorizationRequestView> {
    const now = this.clock();
    await this.purgeExpired(now);
    const client = await this.getClient(input.clientId);
    if (!client || !client.redirect_uris.includes(input.redirectUri)) {
      throw new McpOAuthError('invalid_grant');
    }
    if (!isValidCodeChallenge(input.codeChallenge) || !isValidScopeSet(input.scopes)) {
      throw new McpOAuthError('invalid_grant');
    }
    if (!isAbsoluteUrl(input.resource)) throw new McpOAuthError('invalid_target');

    const requestCredential = newCredential('request');
    const expiresAt = new Date(now.getTime() + MCP_OAUTH_AUTHORIZATION_REQUEST_TTL_MS);
    await this.database.mcpOAuthAuthorizationRequest.create({
      data: {
        request_hash: hashCredential('request', requestCredential),
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        state: input.state,
        scopes: input.scopes,
        code_challenge: input.codeChallenge,
        resource: input.resource,
        expires_at: expiresAt
      }
    });
    return authorizationView(requestCredential, client, {
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state ?? null,
      scopes: input.scopes,
      resource: input.resource,
      expires_at: expiresAt
    });
  }

  /** Resolve a hashed consent credential only while its request and registered client remain valid. */
  async authorizationRequest(requestId: string): Promise<McpOAuthAuthorizationRequestView | null> {
    const row = await this.database.mcpOAuthAuthorizationRequest.findUnique({
      where: { request_hash: hashCredential('request', requestId) },
      include: { client: { select: { metadata_json: true } } }
    });
    if (!row || row.expires_at <= this.clock()) return null;
    const client = parseStoredClient(row.client.metadata_json);
    return client ? authorizationView(requestId, client, row) : null;
  }

  /** Consume an active consent request and return its bound redirect context; expired or raced requests fail. */
  async cancelAuthorization(requestId: string): Promise<McpOAuthAuthorizationRequestView> {
    const request = await this.authorizationRequest(requestId);
    if (!request) throw new McpOAuthError('expired');
    const removed = await this.database.mcpOAuthAuthorizationRequest.deleteMany({
      where: {
        request_hash: hashCredential('request', requestId),
        expires_at: { gt: this.clock() }
      }
    });
    if (removed.count !== 1) throw new McpOAuthError('expired');
    return request;
  }

  /** Reauthenticate and check account access/security version transactionally before minting a one-use authorization code. */
  async approveAuthorization(input: {
    requestId: string;
    email: string;
    password: string;
  }): Promise<McpOAuthApprovalResult> {
    const now = this.clock();
    const requestHash = hashCredential('request', input.requestId);
    const request = await this.database.mcpOAuthAuthorizationRequest.findUnique({
      where: { request_hash: requestHash }
    });
    if (!request || request.expires_at <= now) {
      if (request) {
        await this.database.mcpOAuthAuthorizationRequest.deleteMany({ where: { request_hash: requestHash } });
      }
      throw new McpOAuthError('expired');
    }

    const email = normalizeEmailCredential(input.email);
    const user = email ? await this.database.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: APPROVAL_USER_SELECT
    }) : null;
    const passwordWithinLimit = validateBcryptPasswordByteLength(input.password) === null;
    const passwordMatches = await verifyLocalPassword(passwordWithinLimit ? input.password : '', user?.password_hash);
    if (!user || !passwordWithinLimit || !passwordMatches) {
      await this.recordFailedApproval(requestHash, now);
      throw new McpOAuthError('invalid_credentials');
    }
    if (serializeAccountAccess(user).state !== 'full') {
      throw new McpOAuthError('account_access_required');
    }

    const code = newCredential('code');
    const codeExpiresAt = new Date(now.getTime() + MCP_OAUTH_AUTHORIZATION_CODE_TTL_MS);
    const approved = await this.database.$transaction(async (tx) => {
      // Serialize approval against password change/reset. Whichever transaction commits second
      // observes or deletes the other's authorization code, so an old password cannot mint access.
      const credentialStillCurrent = await tx.user.updateMany({
        where: { id: user.id, credential_security_version: user.credential_security_version },
        data: { credential_security_version: user.credential_security_version }
      });
      if (credentialStillCurrent.count !== 1) {
        await tx.mcpOAuthAuthorizationRequest.deleteMany({ where: { request_hash: requestHash } });
        return false;
      }
      const claimed = await tx.mcpOAuthAuthorizationRequest.deleteMany({
        where: { request_hash: requestHash, expires_at: { gt: now } }
      });
      if (claimed.count !== 1) return false;
      await tx.mcpOAuthAuthorizationCode.create({
        data: {
          code_hash: hashCredential('code', code),
          client_id: request.client_id,
          user_id: user.id,
          redirect_uri: request.redirect_uri,
          scopes: request.scopes,
          code_challenge: request.code_challenge,
          resource: request.resource,
          expires_at: codeExpiresAt
        }
      });
      return true;
    });
    if (!approved) throw new McpOAuthError('expired');
    return { code, redirectUri: request.redirect_uri, state: request.state ?? undefined };
  }

  /** Read the PKCE challenge only for an unexpired code bound to the requesting client. */
  async challengeForAuthorizationCode(clientId: string, authorizationCode: string): Promise<string> {
    const code = await this.database.mcpOAuthAuthorizationCode.findFirst({
      where: {
        code_hash: hashCredential('code', authorizationCode),
        client_id: clientId,
        expires_at: { gt: this.clock() }
      },
      select: { code_challenge: true }
    });
    if (!code) throw new McpOAuthError('invalid_grant');
    return code.code_challenge;
  }

  /** Consume a code bound to client, redirect and resource, creating the grant and opaque token pair atomically. */
  async exchangeAuthorizationCode(
    clientId: string,
    authorizationCode: string,
    redirectUri?: string,
    resource?: string
  ): Promise<McpOAuthTokenSet> {
    const now = this.clock();
    const codeHash = hashCredential('code', authorizationCode);
    const code = await this.database.mcpOAuthAuthorizationCode.findUnique({ where: { code_hash: codeHash } });
    if (!code || code.client_id !== clientId || code.expires_at <= now) throw new McpOAuthError('invalid_grant');
    if (!redirectUri || redirectUri !== code.redirect_uri) throw new McpOAuthError('invalid_grant');
    if (!resource || resource !== code.resource) throw new McpOAuthError('invalid_target');

    const tokens = await this.database.$transaction(async (tx) => {
      const claimed = await tx.mcpOAuthAuthorizationCode.deleteMany({
        where: {
          code_hash: codeHash,
          client_id: clientId,
          redirect_uri: redirectUri,
          resource,
          expires_at: { gt: now }
        }
      });
      if (claimed.count !== 1) return null;
      const grant = await tx.mcpOAuthGrant.create({
        data: { client_id: clientId, user_id: code.user_id, scopes: code.scopes, resource },
        select: { id: true }
      });
      return this.issueTokenPair(tx, grant.id, code.scopes, now);
    });
    if (!tokens) throw new McpOAuthError('invalid_grant');
    return tokens;
  }

  /** Rotate an unexpired resource/client-bound refresh token; replay revokes the grant instead of issuing another successor. */
  async exchangeRefreshToken(
    clientId: string,
    refreshToken: string,
    requestedScopes?: string[],
    resource?: string
  ): Promise<McpOAuthTokenSet> {
    const now = this.clock();
    const tokenHash = hashCredential('refresh', refreshToken);
    const stored = await this.database.mcpOAuthRefreshToken.findUnique({
      where: { token_hash: tokenHash },
      include: { grant: true }
    });
    if (!stored || stored.grant.client_id !== clientId || stored.expires_at <= now || stored.grant.revoked_at) {
      throw new McpOAuthError('invalid_grant');
    }
    if (!resource || resource !== stored.grant.resource) throw new McpOAuthError('invalid_target');
    const scopes = requestedScopes?.length ? uniqueScopes(requestedScopes) : stored.scopes;
    if (scopes.some((scope) => !stored.scopes.includes(scope))) throw new McpOAuthError('invalid_scope');
    if (stored.used_at) {
      await this.revokeGrant(stored.grant_id, now);
      throw new McpOAuthError('invalid_grant');
    }

    const rotation = await this.database.$transaction(async (tx) => {
      // Preserve unexpired used refresh hashes for replay detection while bounding an active grant's rows.
      await Promise.all([
        tx.mcpOAuthAccessToken.deleteMany({
          where: { grant_id: stored.grant_id, expires_at: { lte: now } }
        }),
        tx.mcpOAuthRefreshToken.deleteMany({
          where: { grant_id: stored.grant_id, expires_at: { lte: now } }
        })
      ]);
      const claimed = await tx.mcpOAuthRefreshToken.updateMany({
        where: { token_hash: tokenHash, used_at: null, expires_at: { gt: now } },
        data: { used_at: now }
      });
      if (claimed.count !== 1) {
        await tx.mcpOAuthGrant.updateMany({
          where: { id: stored.grant_id, client_id: clientId, revoked_at: null },
          data: { revoked_at: now }
        });
        return { kind: 'replay' as const };
      }
      const active = await tx.mcpOAuthGrant.updateMany({
        where: { id: stored.grant_id, client_id: clientId, resource, revoked_at: null },
        data: { last_used_at: now }
      });
      if (active.count !== 1) return { kind: 'invalid' as const };
      const tokens = await this.issueTokenPair(tx, stored.grant_id, scopes, now);
      return { kind: 'tokens' as const, tokens };
    });
    if (rotation.kind !== 'tokens') throw new McpOAuthError('invalid_grant');
    return rotation.tokens;
  }

  /** Resolve account/scopes from an unexpired unrevoked grant and recheck current account-access eligibility. */
  async verifyAccessToken(token: string): Promise<McpOAuthAccessInfo> {
    const now = this.clock();
    const stored = await this.database.mcpOAuthAccessToken.findUnique({
      where: { token_hash: hashCredential('access', token) },
      include: { grant: { include: { user: { select: ACCOUNT_ACCESS_SELECT } } } }
    });
    if (!stored || stored.expires_at <= now || stored.grant.revoked_at ||
      serializeAccountAccess(stored.grant.user).state !== 'full') {
      throw new McpOAuthError('invalid_grant');
    }
    const touched = await this.database.mcpOAuthGrant.updateMany({
      where: { id: stored.grant_id, revoked_at: null },
      data: { last_used_at: now }
    });
    if (touched.count !== 1) throw new McpOAuthError('invalid_grant');
    return {
      clientId: stored.grant.client_id,
      userId: stored.grant.user_id,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expires_at.getTime() / 1000),
      resource: stored.grant.resource
    };
  }

  /** Revoke the matching client's entire grant for either token type without disclosing unknown-token state. */
  async revokeToken(clientId: string, token: string): Promise<void> {
    const [access, refresh] = await Promise.all([
      this.database.mcpOAuthAccessToken.findUnique({
        where: { token_hash: hashCredential('access', token) },
        select: { grant_id: true, grant: { select: { client_id: true } } }
      }),
      this.database.mcpOAuthRefreshToken.findUnique({
        where: { token_hash: hashCredential('refresh', token) },
        select: { grant_id: true, grant: { select: { client_id: true } } }
      })
    ]);
    const match = [access, refresh].find((candidate) => candidate?.grant.client_id === clientId);
    if (match) await this.revokeGrant(match.grant_id, this.clock());
  }

  /** List only this account's active grants with an unused unexpired refresh credential. */
  async listConnectionsForUser(userId: number): Promise<McpOAuthConnection[]> {
    const now = this.clock();
    const grants = await this.database.mcpOAuthGrant.findMany({
      where: {
        user_id: userId,
        revoked_at: null,
        refresh_tokens: { some: { used_at: null, expires_at: { gt: now } } }
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: {
        client: { select: { metadata_json: true } },
        refresh_tokens: {
          where: { used_at: null, expires_at: { gt: now } },
          orderBy: { expires_at: 'desc' },
          take: 1,
          select: { expires_at: true }
        }
      }
    });
    return grants.map((grant) => {
      const client = parseStoredClient(grant.client.metadata_json);
      return {
        id: grant.id,
        clientId: grant.client_id,
        clientName: clientName(client),
        scopes: grant.scopes,
        resource: grant.resource,
        createdAt: grant.created_at.toISOString(),
        lastUsedAt: grant.last_used_at?.toISOString() ?? null,
        expiresAt: grant.refresh_tokens[0]!.expires_at.toISOString()
      };
    });
  }

  /** Revoke a valid connection ID only under its owning account; return false for missing or already revoked grants. */
  async revokeConnectionForUser(userId: number, connectionId: string): Promise<boolean> {
    if (!isUuid(connectionId)) return false;
    const revoked = await this.database.mcpOAuthGrant.updateMany({
      where: { id: connectionId, user_id: userId, revoked_at: null },
      data: { revoked_at: this.clock() }
    });
    return revoked.count === 1;
  }

  private async recordFailedApproval(requestHash: string, now: Date): Promise<void> {
    const retryable = await this.database.mcpOAuthAuthorizationRequest.updateMany({
      where: { request_hash: requestHash, expires_at: { gt: now }, failed_attempts: { lt: MAX_LOGIN_ATTEMPTS - 1 } },
      data: { failed_attempts: { increment: 1 } }
    });
    if (retryable.count === 1) return;
    await this.database.mcpOAuthAuthorizationRequest.deleteMany({ where: { request_hash: requestHash } });
    throw new McpOAuthError('expired');
  }

  private async issueTokenPair(
    tx: Prisma.TransactionClient,
    grantId: string,
    scopes: string[],
    now: Date
  ): Promise<McpOAuthTokenSet> {
    const accessToken = newCredential('access');
    const refreshToken = newCredential('refresh');
    await tx.mcpOAuthAccessToken.create({
      data: {
        token_hash: hashCredential('access', accessToken),
        grant_id: grantId,
        scopes,
        expires_at: new Date(now.getTime() + MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000)
      }
    });
    await tx.mcpOAuthRefreshToken.create({
      data: {
        token_hash: hashCredential('refresh', refreshToken),
        grant_id: grantId,
        scopes,
        expires_at: new Date(now.getTime() + MCP_OAUTH_REFRESH_TOKEN_TTL_MS)
      }
    });
    return { accessToken, refreshToken, expiresIn: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS, scopes };
  }

  private async revokeGrant(grantId: string, now: Date): Promise<void> {
    await this.database.mcpOAuthGrant.updateMany({ where: { id: grantId, revoked_at: null }, data: { revoked_at: now } });
  }

  private async purgeExpired(now: Date): Promise<void> {
    await this.database.$transaction([
      this.database.mcpOAuthAuthorizationRequest.deleteMany({ where: { expires_at: { lte: now } } }),
      this.database.mcpOAuthAuthorizationCode.deleteMany({ where: { expires_at: { lte: now } } }),
      this.database.mcpOAuthAccessToken.deleteMany({ where: { expires_at: { lte: now } } }),
      this.database.mcpOAuthRefreshToken.deleteMany({ where: { expires_at: { lte: now } } })
    ]);
  }
}

export const mcpOAuthService = new McpOAuthService();

function newCredential(purpose: CredentialPurpose): string {
  return `calibrate_mcp_${purpose}_${randomBytes(32).toString('base64url')}`;
}

function hashCredential(purpose: CredentialPurpose, credential: string): string {
  return createHash('sha256')
    .update(`calibrate:mcp-oauth:${purpose}:`, 'utf8')
    .update(credential, 'utf8')
    .digest('hex');
}

function sanitizePublicClient(client: StoredOAuthClient): StoredOAuthClient {
  const cloned = JSON.parse(JSON.stringify(client)) as StoredOAuthClient;
  delete cloned.client_secret;
  delete cloned.client_secret_expires_at;
  cloned.token_endpoint_auth_method = 'none';
  return cloned;
}

function parseStoredClient(value: Prisma.JsonValue): StoredOAuthClient | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, Prisma.JsonValue>;
  if (typeof candidate.client_id !== 'string' || !Array.isArray(candidate.redirect_uris)) return undefined;
  if (candidate.redirect_uris.some((uri) => typeof uri !== 'string')) return undefined;
  return JSON.parse(JSON.stringify(candidate)) as StoredOAuthClient;
}

function authorizationView(
  requestId: string,
  client: StoredOAuthClient,
  row: {
    client_id: string;
    redirect_uri: string;
    state: string | null;
    scopes: string[];
    resource: string;
    expires_at: Date;
  }
): McpOAuthAuthorizationRequestView {
  return {
    id: requestId,
    clientId: row.client_id,
    clientName: clientName(client),
    redirectUri: row.redirect_uri,
    state: row.state ?? undefined,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: row.expires_at.toISOString()
  };
}

function clientName(client: StoredOAuthClient | undefined): string {
  return typeof client?.client_name === 'string' && client.client_name.trim()
    ? client.client_name.trim().slice(0, 120)
    : 'Codex';
}

function isValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function isValidScopeSet(scopes: string[]): boolean {
  return scopes.length > 0 && scopes.length === new Set(scopes).size && scopes.every((scope) => /^\S+$/.test(scope));
}

function uniqueScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
