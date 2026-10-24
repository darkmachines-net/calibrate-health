/** @file Starts the local preview server for the generated Expo web distribution. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createExpoWebStaticServer } from './expo-web-static-server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(repoRoot, 'scripts', 'expo-web-build.mjs');
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? process.argv[portIndex + 1] : '4174';

if (!/^\d+$/.test(port || '')) {
  throw new Error(`Invalid Expo web preview port: ${String(port)}`);
}

const build = spawnSync(process.execPath, [buildScript], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const server = createExpoWebStaticServer({ distDir: path.join(repoRoot, 'mobile', 'dist') });
server.listen(Number(port), '127.0.0.1', () => {
  console.log(`Expo web static preview listening at http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  });
}
