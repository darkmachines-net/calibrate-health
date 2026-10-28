/** @file Serve the credential-free bundled progress App through authenticated MCP resource reads. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PROGRESS_APP_URI = 'ui://calibrate/progress-explorer.html';
const PROGRESS_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Read the built offline App resource; reject if the bundle is missing or unreadable. No account data is embedded. */
export async function readProgressAppResource() {
  // tsc nests server files under dist/backend/src; ts-node executes the source tree directly.
  const candidates = [
    resolve(__dirname, '../../../mcp-app/progress.html'),
    resolve(__dirname, '../../dist/mcp-app/progress.html')
  ];
  let html: string | undefined;
  for (const candidate of candidates) {
    try {
      html = await readFile(candidate, 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!html) throw new Error('The MCP App is missing. Run npm --prefix backend run build.');
  return {
    contents: [{
      uri: PROGRESS_APP_URI,
      mimeType: PROGRESS_APP_MIME_TYPE,
      text: html,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
    }]
  };
}
