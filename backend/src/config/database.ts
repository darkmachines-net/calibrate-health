/** @file Owns the application and readiness pools and their PostgreSQL connection settings. */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { resolveDatabaseConnection } from './databaseUtils';
import { createDatabaseReadinessCheck, DATABASE_READINESS_TIMEOUT_MS } from '../services/readiness';

const connection = resolveDatabaseConnection();
export const pgPool = new Pool(connection.poolConfig);
// pg removes the failed idle client. Do not log driver errors containing connection details.
pgPool.on('error', () => console.error('Idle database connection failed; check database availability. The pool will replace it on demand.'));
const adapter = new PrismaPg(pgPool, { schema: connection.schema });

// A probe must acquire within its own budget even when the application pool is busy.
const readinessPool = new Pool({
    ...connection.poolConfig,
    max: 1,
    connectionTimeoutMillis: DATABASE_READINESS_TIMEOUT_MS,
    statement_timeout: DATABASE_READINESS_TIMEOUT_MS,
    allowExitOnIdle: true
});
readinessPool.on('error', () => console.error('Idle readiness connection failed; the pool will replace it on demand.'));

/** Check database connectivity within the HTTP probe budget and return only availability. */
export const checkDatabaseReadiness = createDatabaseReadinessCheck(readinessPool);

const prisma = new PrismaClient({ adapter });

/**
 * Close Prisma and both owned node-postgres pools.
 *
 * Prisma does not own the pg Pool lifecycle when a driver adapter is supplied, so
 * short-lived CLI scripts must close the pools to release any live connections.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } finally {
    await Promise.all([pgPool.end(), readinessPool.end()]);
  }
}

export default prisma;
