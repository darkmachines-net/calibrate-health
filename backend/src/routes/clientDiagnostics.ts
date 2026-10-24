/** @file client Diagnostics: Validate bounded client diagnostics and separate anonymous support reports from authenticated alert-driving aggregates. */

import express, { type RequestHandler } from 'express';
import { NATIVE_CLIENT_HEADERS, isMobileDevicePlatform } from '../../../shared/clientCompatibility';
import type { ClientDiagnosticResponse } from '../../../shared/clientDiagnostics';
import {
  diagnosticsRegistry,
  resolveObservabilityConfig,
  safeRequestId,
  type DiagnosticsRegistry,
  type ObservabilityConfig
} from '../observability';
import { emitClientDiagnostic, parseClientDiagnosticInput } from '../services/clientDiagnostics';
import { isAuthenticatedUser } from '../middleware/authenticatedUser';

type ClientDiagnosticsHandlerOptions = {
  config?: ObservabilityConfig;
  registry?: DiagnosticsRegistry;
  write?: (line: string) => void;
};

/** Validate bounded client diagnostics and separate anonymous support reports from authenticated alert-driving aggregates. */
export function createClientDiagnosticsHandler(options: ClientDiagnosticsHandlerOptions = {}): RequestHandler {
  const config = options.config ?? resolveObservabilityConfig();
  const registry = options.registry ?? diagnosticsRegistry;
  return (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const parsed = parseClientDiagnosticInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ message: 'Invalid client diagnostic payload' });
      return;
    }

    const requestId = safeRequestId(res.locals.requestId);
    res.setHeader('x-request-id', requestId);
    const isAnonymousRootFailure = parsed.value.event === 'client_failure'
      && parsed.value.operation === 'root_render';
    if (!isAnonymousRootFailure && !isAuthenticatedUser(req.user)) {
      res.status(401).json({ message: 'Not authenticated' });
      return;
    }

    const bearerPlatform = isMobileDevicePlatform(res.locals.mobileDevicePlatform)
      ? res.locals.mobileDevicePlatform
      : null;
    if (!isAnonymousRootFailure) {
      if (bearerPlatform) {
        if (parsed.value.platform !== bearerPlatform
          || typeof res.locals.nativeClientVersion !== 'string'
          || parsed.value.version !== res.locals.nativeClientVersion) {
          res.status(400).json({ message: 'Invalid client diagnostic payload' });
          return;
        }
      } else if (parsed.value.platform !== 'web') {
        res.status(400).json({ message: 'Invalid client diagnostic payload' });
        return;
      }
    } else {
      const suppliedPlatform = req.get(NATIVE_CLIENT_HEADERS.PLATFORM)?.trim();
      const presentedPlatform = bearerPlatform
        ?? (isMobileDevicePlatform(suppliedPlatform) ? suppliedPlatform : null);
      const suppliedVersion = req.get(NATIVE_CLIENT_HEADERS.VERSION)?.trim();
      const presentedVersion = typeof res.locals.nativeClientVersion === 'string'
        ? res.locals.nativeClientVersion
        : suppliedVersion;
      if ((presentedPlatform && presentedPlatform !== parsed.value.platform)
        || (presentedVersion && presentedVersion !== parsed.value.version)) {
        res.status(400).json({ message: 'Invalid client diagnostic payload' });
        return;
      }
    }
    registry.recordClientDiagnostic(parsed.value);
    emitClientDiagnostic(config, parsed.value, requestId, options.write);
    const response: ClientDiagnosticResponse = { ok: true, request_id: requestId };
    res.status(202).json(response);
  };
}

const router = express.Router();
router.post('/', createClientDiagnosticsHandler());

export default router;
