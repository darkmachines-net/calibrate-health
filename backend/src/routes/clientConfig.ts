/** @file Public no-store client compatibility and capability configuration endpoint. */

import express from 'express';
import { CALIBRATE_HOSTED_ORIGIN } from '../../../shared/product';
import release from '../../../shared/release.json';
import { NATIVE_PUSH_MODES, resolveNativePushMode } from '../config/nativePush';
import { getWebPushPublicKey } from '../services/webPush';

const router = express.Router();

const CLIENT_API_VERSION = 1;
const CURRENT_API_VERSION = release.server.api.current;

/**
 * Lightweight capability document for native clients and self-hosted deployments.
 */
router.get('/', (_req, res) => {
  const nativePushMode = resolveNativePushMode();
  const webPushEnabled = Boolean(getWebPushPublicKey().publicKey);
  /**
 * Lightweight capability document for native clients and self-hosted deployments.
 */
  res.set('Cache-Control', 'no-store');
  /**
 * Lightweight capability document for native clients and self-hosted deployments.
 */
  res.json({
    api_version: CLIENT_API_VERSION,
    api_versions: {
      current: CURRENT_API_VERSION,
      supported: release.server.api.supported,
      legacy_alias: release.server.api.legacy_alias,
      legacy_deprecation: 'Supported until released clients have migrated to /api/v1.'
    },
    server_version: release.server.version,
    hosted_origin: CALIBRATE_HOSTED_ORIGIN,
    min_supported_mobile_version: release.android.mobile.minimum_supported_version,
    min_supported_wear_version: release.android.wear.minimum_supported_version,
    capabilities: {
      self_hosted_server_url: true,
      native_push: nativePushMode === NATIVE_PUSH_MODES.EXPO,
      web_push: webPushEnabled,
      health_connect_activity: true,
      wear_os_ready: true
    }
  });
});

export default router;
