/** @file Required legal document status and explicit versioned account acceptance endpoints. */

import express from 'express';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION
} from '../../../shared/legalVersions';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import {
  acceptCurrentLegalDocuments,
  getLegalStatus
} from '../services/accountAccess';
import { logSafeOperationalError } from '../observability';
import { isHostedServiceDeployment } from '../config/emailDelivery';

const router = express.Router();
router.use((_req, res, next) => {
  if (isHostedServiceDeployment()) return next();
  return res.status(404).json({
    message: 'Hosted legal consent is not required by this server.',
    code: 'LEGAL_CONSENT_NOT_REQUIRED',
    retryable: false
  });
});
router.use(requireAuthenticatedUser);

router.get('/status', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const status = await getLegalStatus(user.id);
    if (!status) return res.status(401).json({ message: 'Not authenticated' });
    return res.json(status);
  } catch (error) {
    logSafeOperationalError('legal.status', error, res.locals?.requestId);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/acceptance', async (req, res) => {
  if (req.body?.accept_terms !== true || req.body?.accept_privacy !== true) {
    return res.status(400).json({
      message: 'Terms and Privacy acceptance is required.',
      code: 'INVALID_LEGAL_ACCEPTANCE',
      retryable: false
    });
  }

  const termsVersion = typeof req.body?.terms_version === 'string' ? req.body.terms_version.trim() : '';
  const privacyVersion = typeof req.body?.privacy_version === 'string' ? req.body.privacy_version.trim() : '';
  if (termsVersion !== CURRENT_TERMS_VERSION || privacyVersion !== CURRENT_PRIVACY_VERSION) {
    return res.status(400).json({
      message: 'Accept the current Terms and Privacy Policy versions.',
      code: 'INVALID_LEGAL_VERSION',
      retryable: false
    });
  }

  const user = getAuthenticatedUser(req);
  try {
    const status = await acceptCurrentLegalDocuments(user.id);
    if (!status) return res.status(401).json({ message: 'Not authenticated' });
    return res.json(status);
  } catch (error) {
    logSafeOperationalError('legal.acceptance', error, res.locals?.requestId);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
