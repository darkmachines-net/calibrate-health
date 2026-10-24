/** @file Trusted public origin, resource identity, and enablement configuration for the remote MCP service. */

import { CALIBRATE_HOSTED_ORIGIN } from '../../../shared/product';
import { isHostedServiceDeployment } from './emailDelivery';
import { isProductionOrStagingEnv } from './environment';

const LOCAL_MCP_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;

export type McpConfiguration = {
  enabled: boolean;
  publicUrl: URL;
  allowedHosts: string[];
};

const parseBoolean = (value: string | undefined): boolean | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
};

const parseOrigin = (value: string | undefined): URL | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return new URL(parsed.origin);
  } catch {
    return null;
  }
};

const parsePublicUrl = (value: string | undefined): URL | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
      return null;
    }
    parsed.pathname = '/mcp';
    return parsed;
  } catch {
    return null;
  }
};

const isLoopbackHost = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/** Resolve the stable public MCP resource without trusting request Host or forwarding headers. */
export function resolveMcpConfiguration(env: NodeJS.ProcessEnv = process.env): McpConfiguration {
  const hosted = isHostedServiceDeployment(env);
  const deployed = isProductionOrStagingEnv(env.NODE_ENV);
  const explicitUrl = parsePublicUrl(env.MCP_PUBLIC_URL);
  const publicOrigin = parseOrigin(env.PUBLIC_APP_ORIGIN) ??
    (hosted ? new URL(CALIBRATE_HOSTED_ORIGIN) : null);
  const fallbackPort = env.PORT?.trim() || '3000';
  const publicUrl = explicitUrl ??
    (publicOrigin ? new URL('/mcp', publicOrigin) : new URL(`http://127.0.0.1:${fallbackPort}/mcp`));
  const explicitEnabled = parseBoolean(env.MCP_ENABLED);
  const enabled = explicitEnabled ?? hosted;

  if (enabled && deployed && publicUrl.protocol !== 'https:' && !isLoopbackHost(publicUrl.hostname)) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS in production/staging.');
  }
  if (enabled && deployed && !explicitUrl && !publicOrigin) {
    throw new Error('MCP_PUBLIC_URL or PUBLIC_APP_ORIGIN is required when MCP is enabled in production/staging.');
  }

  const configuredHosts = env.MCP_ALLOWED_HOSTS?.split(',')
    .map((host) => host.trim())
    .filter(Boolean) ?? [];
  const allowedHosts = [...new Set([...LOCAL_MCP_HOSTS, publicUrl.hostname, ...configuredHosts])];

  return { enabled, publicUrl, allowedHosts };
}
