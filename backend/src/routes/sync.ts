/** @file Cursor-paginated account synchronization changes for offline clients. */

import express from 'express';
import prisma from '../config/database';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';

const router = express.Router();
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

/** Return an ordered, resumable change page with JSON-safe string cursors. */
router.use(requireAuthenticatedUser);

function parseCursor(value: unknown): bigint | null {
  if (value === undefined) return 0n;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/** Return an ordered, resumable change page with JSON-safe string cursors. */
router.get('/changes', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const after = parseCursor(req.query.after);
  const limit = parseLimit(req.query.limit);
  if (after === null || limit === null) {
    return res.status(400).json({ message: 'Invalid sync cursor or limit' });
  }

  try {
    const rows = await prisma.syncChange.findMany({
      where: { user_id: user.id, id: { gt: after } },
      orderBy: { id: 'asc' },
      take: limit + 1
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = page.length > 0 ? page[page.length - 1].id : after;

    return res.json({
      changes: page.map((row) => ({
        cursor: row.id.toString(),
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        operation_id: row.operation_id,
        payload: row.payload,
        created_at: row.created_at.toISOString()
      })),
      next_cursor: nextCursor.toString(),
      has_more: hasMore
    });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
