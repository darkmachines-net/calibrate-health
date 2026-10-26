/** @file Build the isolated MCP progress view into one offline HTML resource for development and production. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild-wasm';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bundle browser-only dependencies and inline assets; never embeds account data or runtime credentials. */
export async function buildProgressApp() {
  const source = resolve(backendRoot, 'src/mcp/ui');
  const result = await build({
    absWorkingDir: backendRoot,
    entryPoints: [resolve(source, 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    // SDK transport diagnostics include message payloads; health data must not enter browser logs.
    drop: ['console'],
    legalComments: 'inline',
    logLevel: 'silent'
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = await readFile(resolve(source, 'styles.css'), 'utf8');
  const template = await readFile(resolve(source, 'index.html'), 'utf8');
  const html = template.replace('/* APP_STYLES */', () => css).replace('/* APP_SCRIPT */', () => script);
  const output = resolve(backendRoot, 'dist/mcp-app/progress.html');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildProgressApp();
}
