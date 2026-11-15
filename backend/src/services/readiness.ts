/** @file Bounds database readiness checks and discards timed-out probe connections. */

import type { Pool, PoolClient } from 'pg';

// Leave time for the HTTP response before the three-second Cloud Run startup probe expires.
export const DATABASE_READINESS_TIMEOUT_MS = 2_000;

/** Share one probe among concurrent callers. The supplied pool must also bound connection acquisition. */
export function createDatabaseReadinessCheck(
  pool: Pick<Pool, 'connect'>,
  timeoutMs = DATABASE_READINESS_TIMEOUT_MS
): () => Promise<boolean> {
  let active: Promise<boolean> | undefined;

  return () => {
    if (active) return active;

    let expired = false;
    let client: PoolClient | undefined;
    const release = (discard: boolean) => {
      const leased = client;
      client = undefined;
      leased?.release(discard);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve(false);
        release(true);
      }, timeoutMs);
    });

    // Keep the single-flight slot until the driver settles, even if HTTP has already returned.
    const probe = (async () => {
      try {
        client = await pool.connect();
        if (expired) return false;
        await client.query('SELECT 1');
        release(false);
        return !expired;
      } catch {
        return false;
      } finally {
        release(true);
        clearTimeout(timer);
      }
    })();
    active = Promise.race([probe, deadline]);
    void probe.then(() => { active = undefined; });
    return active;
  };
}
