/** @file Production Expo web serving, asset cache policy, SPA fallbacks, and service-worker freshness. */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const HASHED_ASSET_PATTERN = /[.-][a-f0-9]{8,}[.-]/i;
const REVALIDATED_ASSET_NAMES = new Set(['sw.js', 'manifest.webmanifest']);

/** Keep documents and the service-worker lifecycle fresh while caching content-addressed assets permanently. */
export function frontendAssetCacheControl(filePath: string): string {
  const fileName = path.basename(filePath);
  if (fileName.endsWith('.html') || REVALIDATED_ASSET_NAMES.has(fileName)) return 'no-cache';
  if (HASHED_ASSET_PATTERN.test(fileName)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/** Serve the Expo static export without allowing its fallback to mask API, auth, or dev endpoints. */
export function configureFrontendStaticAssets(
  app: express.Express,
  isProductionOrStaging: boolean,
  distDir = process.env.FRONTEND_DIST_DIR
): void {
  if (!isProductionOrStaging) return;

  if (!distDir) {
    console.warn(
      'FRONTEND_DIST_DIR is not set; backend will not serve the built web client. ' +
      'Set it only for a single-origin deployment; omit it when the web client is hosted separately.'
    );
    return;
  }

  const indexHtmlPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    console.warn(
      `FRONTEND_DIST_DIR does not contain index.html (${indexHtmlPath}); backend will not serve the built web client.`
    );
    return;
  }

  app.use(express.static(distDir, {
    extensions: ['html'],
    setHeaders: (response, filePath) => {
      response.setHeader('Cache-Control', frontendAssetCacheControl(filePath));
    }
  }));

  const frontendFallbackRoute = /^\/(?!api(?:\/|$)|auth(?:\/|$)|dev(?:\/|$)).*/;
  app.get(frontendFallbackRoute, (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Calibrate-SPA-Fallback', '1');
    response.sendFile(indexHtmlPath);
  });
}
