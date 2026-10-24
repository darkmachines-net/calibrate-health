import session from 'express-session';
import { browserLoginSave, BrowserLoginRejected, type BrowserLoginSave } from './browserLoginCredentials';
import type { Pool } from 'pg';

export const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const POSTGRES_UNDEFINED_TABLE_CODE = '42P01';
const POSTGRES_UNDEFINED_COLUMN_CODE = '42703';

/**
 * Lightweight Postgres-backed session store to avoid in-memory session loss
 * when the server restarts. Data is serialized to JSONB alongside an
 * expiration timestamp so express-session can persist and prune sessions.
 */
export class PostgresSessionStore extends session.Store {
  private readonly pool: Pool;

  private readonly ttlMs: number;

  constructor(pool: Pool, ttlMs: number = DEFAULT_SESSION_TTL_MS) {
    super();
    this.pool = pool;
    this.ttlMs = ttlMs;
  }

  /**
   * Verify the backing session table exists so deployments fail fast with a clear
   * error message instead of a runtime SQL failure during the first request.
   *
   * Table creation belongs in migrations (see backend/prisma/migrations).
   */
  async initialize(): Promise<void> {
    await this.assertSessionStoreSchema();
  }

  async get(sid: string, callback: (err: any, session?: session.SessionData | null) => void): Promise<void> {
    try {
      const result = await this.pool.query('SELECT sess, expire FROM session_store WHERE sid = $1', [sid]);
      const row = result.rows[0];

      if (!row) {
        callback(null, null);
        return;
      }

      const expires = new Date(row.expire);
      if (expires.getTime() <= Date.now()) {
        await this.destroy(sid, () => undefined);
        callback(null, null);
        return;
      }

      const parsedSession = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
      callback(null, parsedSession as session.SessionData);
    } catch (err) {
      callback(err);
    }
  }

  async set(sid: string, sess: session.SessionData, callback?: (err?: any) => void): Promise<void> {
    const expire = this.calculateExpiry(sess);
    const sessionData = JSON.stringify(sess);
    const userId = this.resolvePassportUserId(sess);
    const guard = browserLoginSave(sess);
    try {
      if (guard) {
        // Serialize saves of this newly logged-in object, including response-end saves.
        const save = guard.queue.then(() => this.saveVerifiedLogin(sid, sessionData, expire, userId, guard));
        guard.queue = save.catch(() => undefined);
        await save;
      } else {
        await this.pool.query(
          `INSERT INTO session_store (sid, sess, expire, user_id, last_used_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (sid)
           DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire, user_id = EXCLUDED.user_id, last_used_at = CURRENT_TIMESTAMP`,
          [sid, sessionData, expire, userId]
        );
      }
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  private async saveVerifiedLogin(sid: string, data: string, expire: Date, userId: number | null, guard: BrowserLoginSave): Promise<void> {
    if (guard.state === 'rejected' || userId !== guard.userId) {
      guard.state = 'rejected';
      throw new BrowserLoginRejected();
    }
    try {
      if (guard.state === 'saved') {
        // Never recreate a newly issued session removed by reset/logout while this request ran.
        // Do not recheck the version: password change deliberately preserves its current session.
        const result = await this.pool.query(
          'UPDATE session_store SET sess = $2, expire = $3, last_used_at = CURRENT_TIMESTAMP WHERE sid = $1 AND user_id = $4',
          [sid, data, expire, userId]
        );
        if (result.rowCount !== 1) throw new BrowserLoginRejected();
        return;
      }
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          'UPDATE "User" SET credential_security_version = credential_security_version WHERE id = $1 AND credential_security_version = $2 RETURNING id',
          [userId, guard.version]
        );
        if (current.rowCount !== 1) throw new BrowserLoginRejected();
        await client.query(
          'INSERT INTO session_store (sid, sess, expire, user_id, last_used_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
          [sid, data, expire, userId]
        );
        await client.query('COMMIT');
        guard.state = 'saved';
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      guard.state = 'rejected';
      throw error;
    }
  }

  async destroy(sid: string, callback?: (err?: any) => void): Promise<void> {
    try {
      await this.pool.query('DELETE FROM session_store WHERE sid = $1', [sid]);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  async touch(sid: string, sess: session.SessionData, callback?: (err?: any) => void): Promise<void> {
    const expire = this.calculateExpiry(sess);
    const sessionData = JSON.stringify(sess);
    const userId = this.resolvePassportUserId(sess);

    try {
      await this.pool.query('UPDATE session_store SET expire = $2, sess = $3, user_id = $4, last_used_at = CURRENT_TIMESTAMP WHERE sid = $1', [
        sid,
        expire,
        sessionData,
        userId
      ]);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  private calculateExpiry(sess: session.SessionData): Date {
    if (sess.cookie?.expires) {
      return new Date(sess.cookie.expires);
    }

    const maxAge = sess.cookie?.maxAge ?? this.ttlMs;
    return new Date(Date.now() + maxAge);
  }

  /** Extract Passport's serialized integer user id without trusting arbitrary session JSON. */
  private resolvePassportUserId(sess: session.SessionData): number | null {
    const passport = (sess as session.SessionData & { passport?: { user?: unknown } }).passport;
    const value = passport?.user;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }

  /**
   * Confirm the session_store table exists; throws a human-friendly error when
   * migrations have not been applied.
   */
  private async assertSessionStoreSchema(): Promise<void> {
    try {
      await this.pool.query('SELECT public_id, created_at, last_used_at FROM session_store LIMIT 1');
    } catch (error) {
      if (this.isMissingSessionSchemaError(error)) {
        throw new Error(
          'Session store table is missing. Apply database migrations (npm run db:migrate) and restart the server.',
          { cause: error }
        );
      }

      throw error;
    }
  }

  /**
   * Detect the Postgres "undefined_table" error across pg driver versions.
   */
  private isMissingSessionSchemaError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const code = (error as { code?: unknown }).code;
    return code === POSTGRES_UNDEFINED_TABLE_CODE || code === POSTGRES_UNDEFINED_COLUMN_CODE;
  }
}
