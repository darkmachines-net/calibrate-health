import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  McpOAuthError,
  McpOAuthService,
  mcpOAuthService,
  type StoredOAuthClient
} from '../services/mcpOAuth';
import { logSafeOperationalError } from '../observability';

export const MCP_FOOD_READ_SCOPE = 'calibrate:food:read';
export const MCP_WEIGHT_READ_SCOPE = 'calibrate:weight:read';
const MCP_OAUTH_SCOPES = [MCP_FOOD_READ_SCOPE, MCP_WEIGHT_READ_SCOPE] as const;
export const MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_MAX = 100;
export const MCP_OAUTH_REGISTRATION_RATE_LIMIT_MAX = 20;
const MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MCP_OAUTH_REGISTRATION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_DYNAMIC_CLIENT_METADATA_BYTES = 16 * 1024;

export type CalibrateOAuthSetup = {
  resourceUrl: URL;
  service?: McpOAuthService;
  approvalRateLimiter: RequestHandler;
};

export function installCalibrateOAuth(app: Express, setup: CalibrateOAuthSetup) {
  const resourceUrl = new URL(setup.resourceUrl.href);
  resourceUrl.hash = '';
  resourceUrl.search = '';
  const issuerUrl = new URL(resourceUrl.origin);
  const service = setup.service ?? mcpOAuthService;
  const provider = new CalibrateOAuthProvider(service, resourceUrl, issuerUrl);
  const metadata = createOAuthMetadata({
    provider,
    issuerUrl,
    scopesSupported: [...MCP_OAUTH_SCOPES],
    serviceDocumentationUrl: new URL('/privacy', issuerUrl)
  });
  metadata.token_endpoint_auth_methods_supported = ['none'];
  metadata.revocation_endpoint_auth_methods_supported = ['none'];

  const protectedResourceMetadata = {
    resource: resourceUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Calibrate progress data',
    resource_documentation: new URL('/privacy', issuerUrl).href
  };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const resourceMetadataPath = new URL(resourceMetadataUrl).pathname;
  const markNoStore: RequestHandler = (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  };
  const authorizationRateLimiter = rateLimit({
    windowMs: MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_WINDOW_MS,
    limit: MCP_OAUTH_AUTHORIZATION_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: 'too_many_requests',
      error_description: 'Too many OAuth authorization requests. Try again later.'
    }
  });
  const registrationRateLimiter = rateLimit({
    windowMs: MCP_OAUTH_REGISTRATION_RATE_LIMIT_WINDOW_MS,
    limit: MCP_OAUTH_REGISTRATION_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: 'too_many_requests',
      error_description: 'Too many OAuth client registration requests. Try again later.'
    }
  });

  app.get('/.well-known/oauth-authorization-server', (_request, response) => {
    response.set('Cache-Control', 'public, max-age=300').json(metadata);
  });
  app.get(['/.well-known/oauth-protected-resource', resourceMetadataPath], (_request, response) => {
    response.set('Cache-Control', 'public, max-age=300').json(protectedResourceMetadata);
  });
  // These routes create durable or short-lived database rows, so keep their IP ceilings
  // explicit here instead of relying on the MCP SDK's transitive defaults.
  app.use('/register', markNoStore, registrationRateLimiter);
  app.use('/authorize', markNoStore, authorizationRateLimiter);
  app.use(['/token', '/revoke'], markNoStore);
  app.post(
    '/oauth/approve',
    markNoStore,
    setup.approvalRateLimiter,
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (request, response) => {
      const origin = request.headers.origin;
      // Codex's isolated OAuth browser may serialize its document origin as "null".
      // The one-use, high-entropy request credential remains the CSRF binding.
      if (origin && origin !== 'null' && origin !== issuerUrl.origin) {
        response.status(403).send('Origin not allowed');
        return;
      }
      await provider.completeAuthorization(request, response);
    }
  );
  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: [...MCP_OAUTH_SCOPES],
    resourceName: 'Calibrate progress data',
    serviceDocumentationUrl: new URL('/privacy', issuerUrl),
    authorizationOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false }
  }));

  return { provider, resourceMetadataUrl };
}

class CalibrateOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly service: McpOAuthService,
    private readonly resourceUrl: URL,
    private readonly issuerUrl: URL
  ) {
    this.clientsStore = {
      getClient: async (clientId) =>
        this.service.getClient(clientId) as Promise<OAuthClientInformationFull | undefined>,
      registerClient: async (client) => {
        const requested = client as unknown as OAuthClientInformationFull;
        if (Buffer.byteLength(JSON.stringify(requested), 'utf8') > MAX_DYNAMIC_CLIENT_METADATA_BYTES) {
          throw new InvalidClientMetadataError('Dynamic client metadata must be at most 16 KiB');
        }
        if (!requested.client_id || !Array.isArray(requested.redirect_uris) ||
          requested.redirect_uris.length === 0 || requested.redirect_uris.length > 10) {
          throw new InvalidClientMetadataError('A client ID and one to ten redirect URIs are required');
        }
        if (requested.redirect_uris.some((uri) => !safeRedirectUri(uri))) {
          throw new InvalidClientMetadataError(
            'Redirect URIs must use HTTPS, except for exact loopback HTTP callbacks'
          );
        }
        if (requested.token_endpoint_auth_method !== 'none') {
          throw new InvalidClientMetadataError('Calibrate accepts public PKCE clients only');
        }
        const grantTypes = requested.grant_types ?? ['authorization_code', 'refresh_token'];
        const responseTypes = requested.response_types ?? ['code'];
        if (grantTypes.some((grant) => !['authorization_code', 'refresh_token'].includes(grant)) ||
          responseTypes.some((responseType) => responseType !== 'code')) {
          throw new InvalidClientMetadataError(
            'Only the authorization-code and refresh-token grants are supported'
          );
        }
        const normalized: OAuthClientInformationFull = {
          ...requested,
          client_name: sanitizeClientName(requested.client_name),
          token_endpoint_auth_method: 'none',
          grant_types: grantTypes,
          response_types: responseTypes,
          client_secret: undefined,
          client_secret_expires_at: undefined
        };
        if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_DYNAMIC_CLIENT_METADATA_BYTES) {
          throw new InvalidClientMetadataError('Dynamic client metadata must be at most 16 KiB');
        }
        return this.service.saveClient(normalized as StoredOAuthClient) as Promise<OAuthClientInformationFull>;
      }
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response
  ): Promise<void> {
    const resource = params.resource?.href;
    if (!resource || resource !== this.resourceUrl.href) {
      throw new InvalidTargetError('The OAuth resource must exactly match the Calibrate MCP endpoint');
    }
    const scopes = params.scopes?.length ? params.scopes : [...MCP_OAUTH_SCOPES];
    if (scopes.some((scope) => !MCP_OAUTH_SCOPES.includes(scope as typeof MCP_OAUTH_SCOPES[number]))) {
      throw new InvalidScopeError('Unsupported Calibrate OAuth scope');
    }
    const authorization = await this.service.beginAuthorization({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes,
      codeChallenge: params.codeChallenge,
      resource
    });
    renderAuthorizationPage(response, authorization);
  }

  async completeAuthorization(request: Request, response: Response): Promise<void> {
    const requestId = singleFormValue(request.body?.request_id);
    const decision = singleFormValue(request.body?.decision);
    if (!requestId) {
      renderExpiredPage(response);
      return;
    }
    let authorization;
    try {
      authorization = await this.service.authorizationRequest(requestId);
    } catch (error) {
      logSafeOperationalError('mcp.oauth.authorization-request', error, response.locals?.requestId);
      renderUnavailablePage(response);
      return;
    }
    if (!authorization) {
      renderExpiredPage(response);
      return;
    }

    if (decision === 'deny') {
      try {
        await this.service.cancelAuthorization(requestId);
      } catch (error) {
        if (error instanceof McpOAuthError) renderExpiredPage(response);
        else {
          logSafeOperationalError('mcp.oauth.cancel', error, response.locals?.requestId);
          renderUnavailablePage(response);
        }
        return;
      }
      const target = new URL(authorization.redirectUri);
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The user declined access to Calibrate progress data');
      target.searchParams.set('iss', this.issuerUrl.href);
      if (authorization.state) target.searchParams.set('state', authorization.state);
      response.redirect(302, target.href);
      return;
    }

    const email = singleFormValue(request.body?.email).slice(0, 320);
    const password = singleFormValue(request.body?.password).slice(0, 1000);
    try {
      const result = await this.service.approveAuthorization({ requestId, email, password });
      const target = new URL(result.redirectUri);
      target.searchParams.set('code', result.code);
      target.searchParams.set('iss', this.issuerUrl.href);
      if (result.state) target.searchParams.set('state', result.state);
      response.redirect(302, target.href);
    } catch (error) {
      if (error instanceof McpOAuthError && error.reason === 'invalid_credentials') {
        renderAuthorizationPage(response, authorization, 'That email or password was not recognized.');
        return;
      }
      if (error instanceof McpOAuthError && error.reason === 'account_access_required') {
        renderAuthorizationPage(
          response,
          authorization,
          'Verify your email and accept the current Terms and Privacy Policy before connecting.'
        );
        return;
      }
      if (error instanceof McpOAuthError) renderExpiredPage(response);
      else {
        logSafeOperationalError('mcp.oauth.approval', error, response.locals?.requestId);
        renderUnavailablePage(response);
      }
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    try {
      return await this.service.challengeForAuthorizationCode(client.client_id, authorizationCode);
    } catch (error) {
      if (error instanceof McpOAuthError) {
        throw new InvalidGrantError('The authorization code is invalid or expired');
      }
      logSafeOperationalError('mcp.oauth.code-challenge', error);
      throw error;
    }
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    try {
      const tokens = await this.service.exchangeAuthorizationCode(
        client.client_id,
        authorizationCode,
        redirectUri,
        resource?.href
      );
      return tokenResponse(tokens);
    } catch (error) {
      if (error instanceof McpOAuthError && error.reason === 'invalid_target') {
        throw new InvalidTargetError('The OAuth resource does not match');
      }
      if (error instanceof McpOAuthError) {
        throw new InvalidGrantError('The authorization code is invalid, expired, or already used');
      }
      logSafeOperationalError('mcp.oauth.code-exchange', error);
      throw error;
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    try {
      const tokens = await this.service.exchangeRefreshToken(
        client.client_id,
        refreshToken,
        scopes,
        resource?.href
      );
      return tokenResponse(tokens);
    } catch (error) {
      if (error instanceof McpOAuthError && error.reason === 'invalid_scope') {
        throw new InvalidScopeError('The requested scope exceeds the original grant');
      }
      if (error instanceof McpOAuthError && error.reason === 'invalid_target') {
        throw new InvalidTargetError('The OAuth resource does not match');
      }
      if (error instanceof McpOAuthError) {
        throw new InvalidGrantError('The refresh token is invalid, expired, revoked, or already used');
      }
      logSafeOperationalError('mcp.oauth.refresh', error);
      throw error;
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const info = await this.service.verifyAccessToken(token);
      return {
        token,
        clientId: info.clientId,
        scopes: info.scopes,
        expiresAt: info.expiresAt,
        resource: new URL(info.resource),
        extra: { userId: info.userId }
      };
    } catch (error) {
      if (error instanceof McpOAuthError) {
        throw new InvalidTokenError('The access token is invalid, expired, or revoked');
      }
      logSafeOperationalError('mcp.oauth.access-token', error);
      throw error;
    }
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    await this.service.revokeToken(client.client_id, request.token);
  }
}

function tokenResponse(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}): OAuthTokens {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    scope: tokens.scopes.join(' ')
  };
}

function safeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function sanitizeClientName(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- Strip control characters from the displayed client name.
  const normalized = value?.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return normalized || 'Codex';
}

function scopeDescription(scope: string): string {
  if (scope === MCP_FOOD_READ_SCOPE) {
    return 'Recent food logs, food-day status, calorie target, configured deficit, and profile-estimated TDEE';
  }
  if (scope === MCP_WEIGHT_READ_SCOPE) {
    return 'Recent weight measurements, trend uncertainty, goal, calorie target, configured deficit, and profile-estimated TDEE';
  }
  return scope;
}

function renderAuthorizationPage(
  response: Response,
  authorization: { id: string; clientName: string; scopes: string[] },
  error = ''
): void {
  secureHtml(response);
  const permissions = authorization.scopes
    .map((scope) => `<li>${escapeHtml(scopeDescription(scope))}</li>`)
    .join('');
  response.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Calibrate</title><style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17301c;background:#f6f8f4}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 15%,#dcefdc 0,transparent 38%),#f6f8f4}.card{width:min(500px,100%);padding:32px;background:#fff;border:1px solid #d7e2d5;border-radius:24px;box-shadow:0 24px 70px rgba(27,94,32,.12)}.mark{width:48px;height:48px;display:grid;place-items:center;margin-bottom:20px;border-radius:15px;background:#2e7d32;color:#fff;font-size:25px;font-weight:900}h1{margin:0 0 8px;font-size:28px}.copy{margin:0 0 22px;color:#506455;line-height:1.55}.permissions{padding:14px 16px;margin-bottom:22px;background:#eef6ed;border-radius:12px;font-size:14px;line-height:1.5}.permissions strong{display:block;margin-bottom:5px}.permissions ul{margin:0;padding-left:20px}.error{padding:11px 13px;margin-bottom:16px;color:#8a3527;background:#fff0ed;border:1px solid #e4beb5;border-radius:10px;font-size:14px}form{display:grid;gap:14px}label{display:grid;gap:6px;font-size:13px;font-weight:750}input{min-height:46px;padding:11px 12px;border:1px solid #b9cbb9;border-radius:10px;font:inherit}button{min-height:44px;border:0;border-radius:10px;font:inherit;font-weight:800;cursor:pointer}.approve{background:#2e7d32;color:#fff}.deny{background:#e8eee7;color:#36503a}.privacy{margin:18px 0 0;color:#68796b;font-size:12px;line-height:1.45}
</style></head><body><main class="card"><div class="mark">C</div><h1>Connect ${escapeHtml(authorization.clientName)}</h1>
<p class="copy">Sign in to let this assistant read selected progress data from your private Calibrate account.</p>
<div class="permissions"><strong>Read-only access</strong><ul>${permissions}</ul></div>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${escapeHtml(authorization.id)}">
<label>Email<input name="email" type="email" autocomplete="username" required autofocus maxlength="320"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="1000"></label>
<button class="approve" name="decision" value="approve" type="submit">Connect assistant</button>
<button class="deny" name="decision" value="deny" type="submit" formnovalidate>Cancel</button></form>
<p class="privacy">Your password is sent only to this Calibrate installation. The assistant receives revocable, read-only OAuth tokens - never your password.</p>
</main></body></html>`);
}

function renderExpiredPage(response: Response): void {
  secureHtml(response);
  response.status(400).send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection expired</title></head><body><main><h1>This connection request expired</h1><p>Return to Codex or ChatGPT and choose Authenticate again.</p></main></body></html>');
}

function renderUnavailablePage(response: Response): void {
  secureHtml(response);
  response.status(503).send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calibrate unavailable</title></head><body><main><h1>Calibrate is temporarily unavailable</h1><p>Return to Codex or ChatGPT and try Authenticate again shortly.</p></main></body></html>');
}

function secureHtml(response: Response): void {
  response.type('html');
  response.set('Cache-Control', 'no-store');
  response.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  response.set('Referrer-Policy', 'no-referrer');
  response.set('X-Content-Type-Options', 'nosniff');
}

function singleFormValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]!);
}
