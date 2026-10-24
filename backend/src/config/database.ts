/** @file Shared Prisma client and PostgreSQL adapter pool, including coordinated shutdown ownership. */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { resolveDatabaseConnection } from './databaseUtils';

const connection = resolveDatabaseConnection();
export const pgPool = new Pool(connection.poolConfig);
// pg removes the failed idle client. Do not log driver errors containing connection details.
pgPool.on('error', () => console.error('Idle database connection failed; check database availability. The pool will replace it on demand.'));
const adapter = new PrismaPg(pgPool, { schema: connection.schema });

const prisma = new PrismaClient({ adapter });

/**
 * Close both Prisma and the owned node-postgres pool used by the Prisma adapter.
 *
 * Prisma does not own the pg Pool lifecycle when a driver adapter is supplied, so
 * short-lived CLI scripts must close both handles or Node waits for the pool idle timeout.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
  } finally {
    await pgPool.end();
  }
}

export default prisma;
