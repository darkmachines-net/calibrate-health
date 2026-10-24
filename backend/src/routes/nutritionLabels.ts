/** @file Feature-gated, authenticated nutrition-label image upload and review-draft response. */

import express from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { MAX_LABEL_IMAGE_BYTES, scanNutritionLabel } from '../services/nutritionLabels/scan';
import { isHttpError } from './myFoodsUtils';
import { getServerFeatures } from '../services/serverSettings';

const router = express.Router();
const SCAN_RATE_WINDOW_MS = 60_000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LABEL_IMAGE_BYTES, files: 1, fields: 0, parts: 2 }
}).single('image');

router.use(requireAuthenticatedUser);
router.post('/scan', async (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  // Check before buffering an upload or starting OCR, including for older clients.
  if (!(await getServerFeatures()).nutrition_label_scanning) {
    res.status(403).json({ message: 'Nutrition label scanning is disabled on this server.', code: 'FEATURE_DISABLED' });
    return;
  }
  next();
}, rateLimit({
  windowMs: SCAN_RATE_WINDOW_MS,
  limit: 6,
  keyGenerator: (req) => String(getAuthenticatedUser(req).id),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many label scans. Try again in a minute.' }
}), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const controller = new AbortController();
  // The request body may already be complete when the client cancels OCR.
  const cancelDisconnectedScan = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', cancelDisconnectedScan);
  res.once('finish', () => res.off('close', cancelDisconnectedScan));
  upload(req, res, async (error: unknown) => {
    if (res.destroyed) return;
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ message: tooLarge
        ? 'Choose a label photo smaller than 8 MB.'
        : 'Upload one label photo in the image field.' });
    }
    if (!req.file) return res.status(400).json({ message: 'Choose a label photo.' });
    try {
      const draft = await scanNutritionLabel(req.file.buffer, controller.signal);
      if (!res.destroyed) return res.json(draft);
    } catch (err) {
      if (controller.signal.aborted || res.destroyed) return;
      if (isHttpError(err)) return res.status(err.statusCode).json({ message: err.message });
      return res.status(500).json({ message: 'The label could not be read. Try another photo or enter the details manually.' });
    }
  });
});

export default router;
