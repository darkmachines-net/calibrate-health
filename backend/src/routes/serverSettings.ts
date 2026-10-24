/** @file Current server capability reads and administrator-only feature updates. */

import express from 'express';
import { z } from 'zod';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { getServerFeatures, isServerAdmin, updateServerFeatures } from '../services/serverSettings';

const router = express.Router();
const settingsInput = z.strictObject({
  features: z.strictObject({ nutrition_label_scanning: z.boolean() })
});

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(requireAuthenticatedUser);

router.get('/', async (req, res) => {
  const [features, isAdmin] = await Promise.all([
    getServerFeatures(), isServerAdmin(getAuthenticatedUser(req).id)
  ]);
  res.json({ features, is_admin: isAdmin });
});

router.patch('/', async (req, res) => {
  if (!await isServerAdmin(getAuthenticatedUser(req).id)) {
    res.status(403).json({ message: 'Server administrator access is required.' });
    return;
  }
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Provide a boolean nutrition_label_scanning feature setting.' });
    return;
  }
  const features = await updateServerFeatures(parsed.data.features.nutrition_label_scanning);
  res.json({ features, is_admin: true });
});

export default router;
