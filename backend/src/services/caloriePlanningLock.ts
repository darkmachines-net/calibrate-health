/** @file Account-scoped transaction guards that serialize planning decisions with their input mutations. */

import { Prisma } from '@prisma/client';

/** Serialize planning checks with input writes inside the same transaction. */
export async function lockCaloriePlanningInputs(
    tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
    userId: number
): Promise<void> {
    // A non-key no-op write both locks this account and invalidates older repeatable/
    // serializable snapshots. A SELECT lock alone would leave a waited-on snapshot stale.
    try {
        await tx.$executeRaw`UPDATE "User" SET "timezone" = "timezone" WHERE "id" = ${userId}`;
    } catch (error) {
        // Prisma wraps raw SQL serialization/deadlock errors in P2010.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
            const adapterError = error.meta?.driverAdapterError as { cause?: { originalCode?: unknown } } | undefined;
            const databaseCode = error.meta?.code ?? adapterError?.cause?.originalCode;
            if (['40001', '40P01'].includes(String(databaseCode))) {
                throw new Prisma.PrismaClientKnownRequestError('Planning inputs changed while saving.', {
                    code: 'P2034', clientVersion: error.clientVersion
                });
            }
        }
        throw error;
    }
}
