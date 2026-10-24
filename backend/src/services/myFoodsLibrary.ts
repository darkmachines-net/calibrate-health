/** @file Stable saved-food library filtering, pagination, cursor identity, and immutable serving snapshots. */

import { Prisma } from '@prisma/client';
import type { MyFoodType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { MY_FOOD_NAME_MAX_LENGTH } from '../routes/myFoodsUtils';

const DEFAULT_MY_FOODS_LIBRARY_LIMIT = 30;
const MAX_MY_FOODS_LIBRARY_LIMIT = 100;
const MAX_MY_FOODS_LIBRARY_QUERY_LENGTH = MY_FOOD_NAME_MAX_LENGTH;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MULTI_SPACE_PATTERN = /\s+/g;

type MyFoodsLibraryCursor = {
  v: typeof CURSOR_VERSION;
  p: boolean;
  n: string;
  i: number;
  m: number;
  q: string;
  t: MyFoodType | null;
};

export type MyFoodsLibraryQuery = {
  q: string;
  type: MyFoodType | null;
  cursor: MyFoodsLibraryCursor | null;
  limit: number;
};

type MyFoodsLibraryItem = {
  id: number;
  type: MyFoodType;
  name: string;
  serving_size_quantity: number;
  serving_unit_label: string;
  calories_per_serving: number;
  is_pinned: boolean;
  recipe_total_calories: number | null;
  yield_servings: number | null;
};

export type MyFoodsLibraryResponse = {
  items: MyFoodsLibraryItem[];
  next_cursor: string | null;
};

type MyFoodsLibraryRow = MyFoodsLibraryItem & {
  normalized_name: string;
  snapshot_max_id: number;
};

type MyFoodsLibraryDatabase = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
};

export class MyFoodsLibraryRequestError extends Error {}

function invalidRequest(message: string): never {
  throw new MyFoodsLibraryRequestError(message);
}

function normalizeQuery(value: string): string {
  return value.trim().replace(MULTI_SPACE_PATTERN, ' ');
}

function cursorQueryKey(value: string): string {
  return createHash('sha256').update(value.toLowerCase(), 'utf8').digest('base64url');
}

function parseSingleQueryValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidRequest(`${field} must be a single string`);
  return value;
}

function parseType(value: unknown): MyFoodType | null {
  const raw = parseSingleQueryValue(value, 'type');
  if (raw === undefined) return null;
  const normalized = raw.trim().toUpperCase();
  if (normalized !== 'FOOD' && normalized !== 'RECIPE') {
    invalidRequest('type must be FOOD or RECIPE');
  }
  return normalized;
}

function parseLimit(value: unknown): number {
  const raw = parseSingleQueryValue(value, 'limit');
  if (raw === undefined) return DEFAULT_MY_FOODS_LIBRARY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MY_FOODS_LIBRARY_LIMIT) {
    invalidRequest(`limit must be an integer from 1 to ${MAX_MY_FOODS_LIBRARY_LIMIT}`);
  }
  return parsed;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodeCursor(value: string, q: string, type: MyFoodType | null): MyFoodsLibraryCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
    invalidRequest('Invalid cursor');
  }

  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalidRequest('Invalid cursor');
    const json = bytes.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(bytes)) invalidRequest('Invalid cursor');
    const decoded = JSON.parse(json) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) invalidRequest('Invalid cursor');
    const parsed = decoded as Partial<MyFoodsLibraryCursor>;
    const hasExactKeys = Object.keys(parsed).sort().join(',') === 'i,m,n,p,q,t,v';
    const validType = parsed.t === null || parsed.t === 'FOOD' || parsed.t === 'RECIPE';
    if (
      !hasExactKeys ||
      parsed.v !== CURSOR_VERSION ||
      typeof parsed.p !== 'boolean' ||
      typeof parsed.n !== 'string' ||
      parsed.n.length === 0 ||
      parsed.n.length > MY_FOOD_NAME_MAX_LENGTH * 2 ||
      !isPositiveInteger(parsed.i) ||
      !isPositiveInteger(parsed.m) ||
      parsed.i > parsed.m ||
      typeof parsed.q !== 'string' ||
      parsed.q.length !== 43 ||
      !BASE64URL_PATTERN.test(parsed.q) ||
      !validType ||
      parsed.q !== cursorQueryKey(q) ||
      parsed.t !== type
    ) {
      invalidRequest('Invalid cursor');
    }
    return parsed as MyFoodsLibraryCursor;
  } catch (error) {
    if (error instanceof MyFoodsLibraryRequestError) throw error;
    invalidRequest('Invalid cursor');
  }
}

function encodeCursor(cursor: MyFoodsLibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Validate bounded search/type/page inputs and require cursor identity to match the normalized query. */
export function parseMyFoodsLibraryQuery(query: Record<string, unknown>): MyFoodsLibraryQuery {
  const rawQuery = parseSingleQueryValue(query.q, 'q');
  const q = normalizeQuery(rawQuery ?? '');
  if (q.length > MAX_MY_FOODS_LIBRARY_QUERY_LENGTH) {
    invalidRequest(`q must be at most ${MAX_MY_FOODS_LIBRARY_QUERY_LENGTH} characters`);
  }

  const type = parseType(query.type);
  const limit = parseLimit(query.limit);
  const rawCursor = parseSingleQueryValue(query.cursor, 'cursor');
  const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor, q, type);
  return { q, type, cursor, limit };
}

function buildCursorClause(cursor: MyFoodsLibraryCursor): Prisma.Sql {
  const samePinStateAfterCursor = Prisma.sql`
    "is_pinned" = ${cursor.p}
    AND (
      LOWER("name") > ${cursor.n}
      OR (LOWER("name") = ${cursor.n} AND "id" > ${cursor.i})
    )
  `;
  if (!cursor.p) return Prisma.sql`(${samePinStateAfterCursor})`;
  return Prisma.sql`((${samePinStateAfterCursor}) OR "is_pinned" = false)`;
}

/** Page an account's saved foods using stable cursor bounds and literal search text, never SQL wildcard interpretation. */
export async function listMyFoodsLibrary(
  database: MyFoodsLibraryDatabase,
  userId: number,
  query: MyFoodsLibraryQuery
): Promise<MyFoodsLibraryResponse> {
  const where = [Prisma.sql`"user_id" = ${userId}`];
  if (query.q) {
    // POSITION treats %, _, and backslashes as ordinary search text instead of LIKE wildcards.
    where.push(Prisma.sql`POSITION(LOWER(${query.q}) IN LOWER("name")) > 0`);
  }
  if (query.type) {
    where.push(Prisma.sql`"type" = ${query.type}::"MyFoodType"`);
  }
  if (query.cursor) {
    where.push(Prisma.sql`"id" <= ${query.cursor.m}`);
    where.push(buildCursorClause(query.cursor));
  }

  const rows = await database.$queryRaw<MyFoodsLibraryRow[]>(Prisma.sql`
    SELECT
      "id",
      "type",
      "name",
      "serving_size_quantity",
      "serving_unit_label",
      "calories_per_serving",
      "is_pinned",
      "recipe_total_calories",
      "yield_servings",
      LOWER("name") AS "normalized_name",
      MAX("id") OVER () AS "snapshot_max_id"
    FROM "MyFood"
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY "is_pinned" DESC, LOWER("name") ASC, "id" ASC
    LIMIT ${query.limit + 1}
  `);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const items = pageRows.map(({ normalized_name: _normalizedName, snapshot_max_id: _snapshotMaxId, ...item }) => item);
  const lastRow = pageRows[pageRows.length - 1];
  const snapshotMaxId = query.cursor?.m ?? rows[0]?.snapshot_max_id;
  const nextCursor = hasMore && lastRow && snapshotMaxId
    ? encodeCursor({
        v: CURSOR_VERSION,
        p: lastRow.is_pinned,
        n: lastRow.normalized_name,
        i: lastRow.id,
        m: snapshotMaxId,
        q: cursorQueryKey(query.q),
        t: query.type
      })
    : null;

  return { items, next_cursor: nextCursor };
}
