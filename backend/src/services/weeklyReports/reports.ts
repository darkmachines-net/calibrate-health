/** @file Sunday report persistence, account eligibility, and expiring worker claims; successful reports are immutable. */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { CURRENT_ACCOUNT_ACCESS_WHERE } from '../../utils/accountAccessSerialization';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } from '../../utils/date';
import { MS_PER_MINUTE } from '../../utils/time';
import { firebaseSessionAllowed } from '../firebaseAuthority';
import { getPlanCheckSummary } from '../planCheck';
import { analyzeWeeklyProgress, getWeeklyReportConfiguration, type ReportEvidence } from './openai';
import type { WeeklyProgressReport } from '../../../../shared/planCheck';

const REPORT_LEASE_MS = 5 * MS_PER_MINUTE; // Outlives a bounded provider request and recovers interrupted workers.
const REPORT_HISTORY_LIMIT = 12; // Keep the in-app history bounded; account export retains every saved report.

/** Return the newest completed reports for this account only; partially generated rows are never exposed. */
export async function listWeeklyReports(userId: number): Promise<WeeklyProgressReport[]> {
    const rows = await prisma.weeklyProgressReport.findMany({
        where: { user_id: userId, status: 'READY' }, orderBy: { report_date: 'desc' }, take: REPORT_HISTORY_LIMIT
    });
    return rows.map(row => ({
        reportDate: row.report_date.toISOString().slice(0, 10), generatedAt: row.generated_at!.toISOString(),
        summary: row.summary!, highlights: row.highlights as string[], nextStep: row.next_step!
    }));
}

/** Generate one account/Sunday report, or safely skip duplicates/ineligible accounts; provider failures remain retryable. */
export async function generateWeeklyReport(userId: number, reportDate: Date, now = new Date()): Promise<void> {
    const configuration = getWeeklyReportConfiguration();
    if (!configuration) return;
    const user = await prisma.user.findFirst({
        where: { id: userId, ...CURRENT_ACCOUNT_ACCESS_WHERE, onboarding_completed_at: { not: null } },
        select: { timezone: true, language: true }
    });
    if (!user || !await firebaseSessionAllowed(userId)) return;
    const today = getSafeUtcTodayDateOnlyInTimeZone(user.timezone, now);
    // Tasks may retry into the following week, but cannot generate future or arbitrary historical reports.
    if (reportDate.getUTCDay() !== 0 || reportDate > today || reportDate < addUtcDays(today, -7)) return;
    const existing = await prisma.weeklyProgressReport.upsert({
        where: { user_id_report_date: { user_id: userId, report_date: reportDate } },
        create: { user_id: userId, report_date: reportDate, timezone: user.timezone }, update: {}
    });
    if (existing.status === 'READY') return;
    const token = randomUUID();
    const claim = await prisma.weeklyProgressReport.updateMany({
        where: { id: existing.id, status: { not: 'READY' }, OR: [{ lease_expires_at: null }, { lease_expires_at: { lte: now } }] },
        data: { status: 'RUNNING', lease_token: token, lease_expires_at: new Date(+now + REPORT_LEASE_MS) }
    });
    if (!claim.count) throw new Error('Weekly report is already being generated; retry after the worker lease.');
    try {
        const tracking = await getPlanCheckSummary(userId, now, reportDate);
        if (tracking.trackingDays < 7) return;
        const goals = await prisma.goal.findMany({
            where: { user_id: userId, created_at: { lte: now } },
            orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
            select: { start_weight_grams: true, target_weight_grams: true, created_at: true }
        });
        // A delayed retry must not describe a goal created after this report's local Sunday.
        const goal = goals.find(candidate => getSafeUtcTodayDateOnlyInTimeZone(user.timezone, candidate.created_at) <= reportDate);
        const evidence: ReportEvidence = {
            tracking, language: user.language,
            goal: goal ? { startWeightKg: goal.start_weight_grams / 1000, targetWeightKg: goal.target_weight_grams / 1000 } : null
        };
        const analysis = await analyzeWeeklyProgress(evidence);
        await prisma.weeklyProgressReport.updateMany({
            where: { id: existing.id, lease_token: token },
            data: {
                status: 'READY', summary: analysis.summary, highlights: analysis.highlights,
                next_step: analysis.nextStep, evidence: evidence as unknown as Prisma.InputJsonValue,
                generated_at: new Date(), model: configuration.model, lease_token: null, lease_expires_at: null
            }
        });
    } finally {
        // Token matching prevents an expired worker from releasing a replacement worker's claim.
        await prisma.weeklyProgressReport.updateMany({
            where: { id: existing.id, lease_token: token },
            data: { status: 'PENDING', lease_token: null, lease_expires_at: null }
        });
    }
}
