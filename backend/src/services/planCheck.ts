/** @file Read-only, account-local tracking summaries; missing food days never become zero intake or gate weight trends. */

import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import type { PlanCheckSummary } from '../../../shared/planCheck';
import { summarizeTracking } from './planCheckSummary';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';

/** Read one consistent evidence snapshot; an explicit local date freezes a scheduled report's calendar boundary. */
export async function getPlanCheckSummary(userId: number, now = new Date(), reportDate?: Date): Promise<PlanCheckSummary> {
    return prisma.$transaction(async tx => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true, weight_unit: true } });
        const today = reportDate ?? getSafeUtcTodayDateOnlyInTimeZone(user.timezone, now);
        const start = addUtcDays(today, -28);
        const [firstWeight, firstFood, firstCompleteDay, weights, food, days, latestWeight] = await Promise.all([
            tx.bodyMetric.findFirst({ where: { user_id: userId, date: { lte: today } }, orderBy: { date: 'asc' }, select: { date: true } }),
            tx.foodLog.findFirst({ where: { user_id: userId, local_date: { lte: today } }, orderBy: { local_date: 'asc' }, select: { local_date: true } }),
            tx.foodLogDay.findFirst({ where: { user_id: userId, local_date: { lte: today }, status: 'COMPLETE' }, orderBy: { local_date: 'asc' }, select: { local_date: true } }),
            tx.bodyMetric.findMany({ where: { user_id: userId, date: { gte: start, lte: today } }, select: { date: true, weight_grams: true } }),
            tx.foodLog.findMany({ where: { user_id: userId, local_date: { gte: start, lt: today } }, select: { local_date: true, calories: true } }),
            tx.foodLogDay.findMany({ where: { user_id: userId, local_date: { gte: start, lt: today } }, select: { local_date: true, status: true } }),
            tx.bodyMetric.findFirst({ where: { user_id: userId, date: { lte: today } }, orderBy: { date: 'desc' }, select: { date: true } })
        ]);
        const dates = [firstWeight?.date, firstFood?.local_date, firstCompleteDay?.local_date]
            .filter((date): date is Date => date !== undefined).sort((a, b) => +a - +b);
        const summary = summarizeTracking({ localDate: today, trackingSince: dates[0] ?? null, weightUnit: user.weight_unit, weights, food, days });
        return { ...summary, latestWeighInDate: latestWeight?.date.toISOString().slice(0, 10) ?? null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
