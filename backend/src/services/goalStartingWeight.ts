/** @file Goal baseline synchronization under the caller-owned account planning transaction. */

import type { Goal } from '@prisma/client';
import { recordSyncChange, type MutationDatabase } from './clientOperations';
import { getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';

/** Caller holds the planning guard and supplies its transaction-current day/timezone. */
export async function correctSameDayGoalStartingWeight(
    tx: MutationDatabase,
    input: { userId: number; metricDate: Date; weightGrams: number; timezone: string; today: Date; goal?: Goal | null }
): Promise<Goal | null> {
    if (input.metricDate.getTime() !== input.today.getTime()) return null;
    const goal = input.goal === undefined
        ? await tx.goal.findFirst({ where: { user_id: input.userId }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] })
        : input.goal;
    if (!goal || goal.start_weight_grams === input.weightGrams
        || getSafeUtcTodayDateOnlyInTimeZone(input.timezone, goal.created_at).getTime() !== input.today.getTime()) return null;
    return tx.goal.update({ where: { id: goal.id }, data: { start_weight_grams: input.weightGrams } });
}

/** Emit after plan safety evaluation so clients receive the final review state. */
export async function recordCorrectedGoalStartingWeight(
    tx: MutationDatabase, userId: number, goalId: number, operationId?: string
): Promise<void> {
    const goal = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
    await recordSyncChange({ tx, userId, entityType: 'goal', entityId: goalId, action: 'upsert', operationId, payload: goal });
}
