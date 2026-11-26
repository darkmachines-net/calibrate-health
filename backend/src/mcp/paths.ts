/** @file Pure path matcher for Calibrate MCP and OAuth 2.1 protocol endpoints without database dependencies. */

/** Identify protocol requests while leaving GET/HEAD /register to the browser's account-registration page. */
export function isCalibrateMcpRequest(path: string, method: string): boolean {
  if (path === '/register' && (method === 'GET' || method === 'HEAD')) return false;
  return (
    path === '/mcp' ||
    path === '/authorize' ||
    path === '/token' ||
    path === '/register' ||
    path === '/revoke' ||
    path === '/oauth/approve' ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/mcp'
  );
}
