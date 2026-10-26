/** @file Rebuild the MCP App before each watched backend start without invoking a platform-specific shell. */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgressApp } from './build-mcp-app.mjs';

await buildProgressApp();
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/index.ts'], {
  cwd: backendRoot,
  stdio: 'inherit',
  windowsHide: true
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
