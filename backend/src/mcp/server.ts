/** @file server: Compose a stateless MCP resource with host checks, OAuth and account-derived read-only progress tools. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { McpConfiguration } from '../config/mcp';
import { logSafeOperationalError } from '../observability';
import {
  McpOAuthError,
  McpOAuthService,
  mcpOAuthService,
  type McpOAuthAccessInfo
} from '../services/mcpOAuth';
import { getRecentFoodLogs, getWeightTrend } from '../services/mcpProgress';
import {
  installCalibrateOAuth,
  MCP_FOOD_READ_SCOPE,
  MCP_WEIGHT_READ_SCOPE
} from './oauth';

const MCP_SERVER_INSTRUCTIONS = [
  'Use Calibrate data only for informational progress discussion, not diagnosis or treatment.',
  'Only COMPLETE food days are representative; open, incomplete, paused, and pre-tracking days are context, not true low-intake days.',
  'Treat raw weights as observations and the trend as a model estimate with uncertainty and freshness.',
  'Positive configured daily deficit means weight loss; negative means weight gain.',
  'Profile-estimated TDEE remains Calibrate calories-out and must not be replaced by an intake/weight-derived estimate.'
].join(' ');

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export type CalibrateMcpHttpOptions = Pick<McpConfiguration, 'publicUrl' | 'allowedHosts'> & {
  /** Calibrate's hosted proxy topology is one hop; direct and local connections use zero. */
  trustedProxyHops: 0 | 1;
  oauthApprovalRateLimiter: RequestHandler;
  oauthService?: McpOAuthService;
  progressReaders?: {
    getRecentFoodLogs: typeof getRecentFoodLogs;
    getWeightTrend: typeof getWeightTrend;
  };
};

/** Compose a stateless MCP resource with host checks, OAuth and account-derived read-only progress tools. */
export function createCalibrateMcpHttpApp(options: CalibrateMcpHttpOptions) {
  const app = createMcpExpressApp({ allowedHosts: options.allowedHosts });
  if (options.trustedProxyHops > 0) {
    app.set('trust proxy', options.trustedProxyHops);
  }
  const resourceUrl = new URL(options.publicUrl.href);
  const oauthService = options.oauthService ?? mcpOAuthService;
  const progressReaders = options.progressReaders ?? { getRecentFoodLogs, getWeightTrend };
  const oauth = installCalibrateOAuth(app, {
    resourceUrl,
    approvalRateLimiter: options.oauthApprovalRateLimiter,
    service: oauthService
  });
  const mcpRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many MCP requests; try again shortly' },
      id: null
    }
  });

  app.use('/mcp', (_request: Request, response: Response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });
  app.post('/mcp', mcpRateLimiter, async (request: Request, response: Response) => {
    const token = bearerToken(request.headers.authorization);
    let access: McpOAuthAccessInfo | null;
    try {
      access = token ? await resolveAccessToken(token, resourceUrl.href, oauthService) : null;
    } catch (error) {
      logSafeOperationalError('mcp.access-token', error, response.locals?.requestId);
      response.status(503).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Calibrate MCP is temporarily unavailable' },
        id: null
      });
      return;
    }
    if (!access) {
      response.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${oauth.resourceMetadataUrl}", scope="${MCP_FOOD_READ_SCOPE} ${MCP_WEIGHT_READ_SCOPE}"`
      );
      response.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Calibrate authentication is required' },
        id: null
      });
      return;
    }

    const server = buildCalibrateMcpServer(access, progressReaders);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      void transport.close();
      void server.close();
    };
    try {
      await server.connect(transport);
      response.once('close', close);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      close();
      logSafeOperationalError('mcp.request', error, response.locals?.requestId);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Calibrate MCP request failed' },
          id: null
        });
      }
    }
  });
  app.get('/mcp', (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Use POST for stateless MCP requests' },
      id: null
    });
  });
  app.delete('/mcp', (_request: Request, response: Response) => {
    response.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Stateless MCP sessions do not require deletion' },
      id: null
    });
  });
  return app;
}

/** Identify MCP/OAuth-owned paths so the main server preserves their authentication and routing boundaries. */
export function isCalibrateMcpPath(path: string): boolean {
  return path === '/mcp' ||
    path === '/authorize' ||
    path === '/token' ||
    path === '/register' ||
    path === '/revoke' ||
    path === '/oauth/approve' ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/mcp';
}

async function resolveAccessToken(
  token: string,
  resource: string,
  service: McpOAuthService
): Promise<McpOAuthAccessInfo | null> {
  try {
    const access = await service.verifyAccessToken(token);
    return access.resource === resource ? access : null;
  } catch (error) {
    if (error instanceof McpOAuthError) return null;
    throw error;
  }
}

function buildCalibrateMcpServer(
  access: McpOAuthAccessInfo,
  progressReaders: NonNullable<CalibrateMcpHttpOptions['progressReaders']>
): McpServer {
  const server = new McpServer(
    { name: 'calibrate-health', version: '1.0.0' },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  );

  server.registerResource(
    'progress-analysis-guidance',
    'calibrate://guidance/progress-analysis',
    {
      mimeType: 'text/markdown',
      description: 'Interpretation rules for discussing Calibrate food and weight progress safely.'
    },
    async () => ({
      contents: [{
        uri: 'calibrate://guidance/progress-analysis',
        mimeType: 'text/markdown',
        text: MCP_SERVER_INSTRUCTIONS
      }]
    })
  );

  if (access.scopes.includes(MCP_FOOD_READ_SCOPE)) {
    const securitySchemes = [{ type: 'oauth2', scopes: [MCP_FOOD_READ_SCOPE] }];
    server.registerTool(
      'get_recent_food_logs',
      {
        title: 'Get recent food logs',
        description: 'Read 1-31 recent local calendar days of sanitized food entries, canonical tracking status, COMPLETE-day totals, and current target context. No account or provider identifiers are returned.',
        inputSchema: z.object({
          days: z.number().int().min(1).max(31).default(14)
            .describe('Number of recent local calendar days to return, including today.')
        }),
        annotations: readOnlyAnnotations,
        _meta: { securitySchemes }
      },
      async ({ days }) => resultOrNotFound(await progressReaders.getRecentFoodLogs(access.userId, { days }))
    );
  }

  if (access.scopes.includes(MCP_WEIGHT_READ_SCOPE)) {
    const securitySchemes = [{ type: 'oauth2', scopes: [MCP_WEIGHT_READ_SCOPE] }];
    server.registerTool(
      'get_weight_trend',
      {
        title: 'Get weight trend',
        description: 'Read 7-365 recent local calendar days of raw scale observations and Calibrate\'s bounded trend, confidence interval, evidence status, freshness, current goal, and target context.',
        inputSchema: z.object({
          days: z.number().int().min(7).max(365).default(90)
            .describe('Number of recent local calendar days to return, including today.')
        }),
        annotations: readOnlyAnnotations,
        _meta: { securitySchemes }
      },
      async ({ days }) => resultOrNotFound(await progressReaders.getWeightTrend(access.userId, { days }))
    );
  }

  return server;
}

function resultOrNotFound(value: Record<string, unknown> | null) {
  if (!value) {
    return {
      content: [{ type: 'text' as const, text: 'The authenticated Calibrate account was not found.' }],
      structuredContent: { error: 'account_not_found' },
      isError: true
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}
