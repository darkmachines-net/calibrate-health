/** @file Validated atomic onboarding completion with profile and initial-goal persistence. */

import express from 'express';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import {
  ClientOperationConflictError,
  executeIdempotentMutation,
  parseClientOperationId
} from '../services/clientOperations';
import {
  completeOnboardingInTransaction,
  parseCompleteOnboardingBody
} from '../services/onboarding';
import { logSafeOperationalError } from '../observability';

const router = express.Router();
router.use(requireAuthenticatedUser);

router.post('/complete', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const operationId = parseClientOperationId(
    req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
  );
  if (!operationId) {
    return res.status(400).json({
      message: 'A valid x-client-operation-id is required.',
      code: 'INVALID_CLIENT_OPERATION_ID',
      retryable: false
    });
  }

  const parsed = parseCompleteOnboardingBody(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      message: parsed.message,
      code: parsed.code,
      retryable: false,
      ...(parsed.fieldErrors ? { field_errors: parsed.fieldErrors } : {})
    });
  }

  try {
    const result = await executeIdempotentMutation<unknown>({
      userId: user.id,
      operationId,
      operationKind: 'onboarding.complete',
      requestPayload: req.body,
      mutate: (tx) => completeOnboardingInTransaction(tx, user.id, operationId, parsed.value)
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ClientOperationConflictError) {
      return res.status(409).json({
        message: error.message,
        code: error.code,
        retryable: error.code === 'OPERATION_IN_PROGRESS'
      });
    }
    logSafeOperationalError('onboarding.complete', error, res.locals?.requestId);
    return res.status(500).json({
      message: 'Unable to complete onboarding.',
      code: 'ONBOARDING_COMPLETION_FAILED',
      retryable: true
    });
  }
});

export default router;