/** @file Restricted watch snapshot and idempotent mutation endpoints with watch-scoped authentication. */

import express from 'express';
import {
  diagnosticOperationOutcomeForStatus,
  diagnosticsRegistry,
  safeErrorType
} from '../observability';
import {
  ClientOperationConflictError,
  parseClientOperationId
} from '../services/clientOperations';
import {
  buildWatchSnapshot,
  executeWatchMutation,
  parseWatchMutation,
  watchSnapshotEtag,
  WatchTimezoneInvalidError
} from '../services/watch';
import { getAuthenticatedUser } from '../middleware/authenticatedUser';

const router = express.Router();

const etagMatches = (header: string | undefined, current: string): boolean => {
  if (!header) return false;
  const normalizedCurrent = current.replace(/^W\//, '');
  return header.split(',').some((entry) => {
    const candidate = entry.trim();
    return candidate === '*' || candidate === current || candidate.replace(/^W\//, '') === normalizedCurrent;
  });
};

router.use((req, res, next) => {
  if (
    res.locals.mobileDevicePlatform !== 'wear_os' ||
    typeof res.locals.mobileAuthSessionId !== 'number' ||
    !req.isAuthenticated()
  ) {
    return res.status(403).json({
      message: 'A Wear OS session is required',
      code: 'WATCH_SESSION_REQUIRED',
      retryable: false
    });
  }
  return next();
});

router.get('/', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const snapshot = await buildWatchSnapshot({
      userId: user.id,
      mobileAuthSessionId: res.locals.mobileAuthSessionId
    });
    if (!snapshot) return res.status(404).json({ message: 'Account not found' });
    const etag = watchSnapshotEtag(snapshot.revision);
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    if (etagMatches(req.get('if-none-match'), etag)) return res.status(304).send();
    return res.json(snapshot);
  } catch (error) {
    if (error instanceof WatchTimezoneInvalidError) {
      return res.status(409).json({ message: error.message, code: 'TIMEZONE_INVALID', retryable: false });
    }
    const errorType = safeErrorType(error);
    console.error(`Watch snapshot failed (request_id=${res.locals?.requestId ?? 'unavailable'}, error_type=${errorType}).`);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/mutations', async (req, res) => {
  const startedAt = Date.now();
  const recordOutcome = (statusCode: number) => diagnosticsRegistry.recordOperation(
    'watch_mutation_reconciliation',
    diagnosticOperationOutcomeForStatus(statusCode),
    Date.now() - startedAt
  );
  const user = getAuthenticatedUser(req);
  const operationId = parseClientOperationId(req.get('x-client-operation-id'));
  if (operationId === undefined) {
    recordOutcome(400);
    return res.status(400).json({ message: 'x-client-operation-id is required' });
  }
  if (operationId === null) {
    recordOutcome(400);
    return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  }
  const mutation = parseWatchMutation(req.body, { timezone: user.timezone ?? '' });
  if (!mutation.ok) {
    recordOutcome(mutation.status);
    return res.status(mutation.status).json({ message: mutation.message, ...(mutation.code ? { code: mutation.code, retryable: false } : {}) });
  }

  try {
    const result = await executeWatchMutation({
      userId: user.id,
      mobileAuthSessionId: res.locals.mobileAuthSessionId,
      operationId,
      mutation
    });
    recordOutcome(result.status);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ClientOperationConflictError) {
      recordOutcome(409);
      return res.status(409).json({
        message: error.message,
        code: error.code,
        retryable: error.code === 'OPERATION_IN_PROGRESS'
      });
    }
    recordOutcome(500);
    const errorType = safeErrorType(error);
    console.error(`Watch mutation failed (request_id=${res.locals?.requestId ?? 'unavailable'}, error_type=${errorType}).`);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
