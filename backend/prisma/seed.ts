/** @file Creates the deterministic local test account and profile through the configured Prisma datasource. */

import { disconnectDatabase } from '../src/config/database';
import { seedDevTestData } from '../src/services/devTestData';

/**
 * Prisma seed entrypoint.
 *
 * Note: this script is intentionally safe to re-run; it creates or updates the
 * deterministic dev user and backfills several months of sample metrics.
 */
const run = async (): Promise<void> => {
  await seedDevTestData({ logTimings: true });
};

run()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase();
  });
