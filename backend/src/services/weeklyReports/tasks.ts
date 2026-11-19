/** @file Authenticated Cloud Tasks enqueueing and bounded Sunday fan-out, independent of the reminder scheduler. */

import { createHash } from 'node:crypto';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import prisma from '../../config/database';
import { CURRENT_ACCOUNT_ACCESS_WHERE } from '../../utils/accountAccessSerialization';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } from '../../utils/date';
import { getWeeklyReportConfiguration } from './openai';

const DISPATCH_BATCH_SIZE = 25; // Keep each fan-out comfortably inside Cloud Run's 60-second request limit.
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const verifier = new OAuth2Client();

/** Resolve queue/auth settings together; incomplete configuration disables task endpoints. */
export function getReportTaskConfiguration(env: NodeJS.ProcessEnv = process.env) {
    const queue = env.WEEKLY_REPORT_TASK_QUEUE?.trim();
    const origin = env.WEEKLY_REPORT_TASK_ORIGIN?.trim();
    const serviceAccount = env.WEEKLY_REPORT_TASK_SERVICE_ACCOUNT?.trim();
    if (!queue || !origin || !serviceAccount || !getWeeklyReportConfiguration(env)) return null;
    if (!/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/queues\/[a-zA-Z0-9_-]+$/.test(queue)) return null;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.origin !== origin) return null;
    } catch { return null; }
    return { queue, origin, serviceAccount };
}

/** Verify Google's signature, issuer/audience/expiry and the exact configured service identity before any job work. */
export async function isReportTaskAuthorized(authorization: string | undefined): Promise<boolean> {
    const config = getReportTaskConfiguration();
    if (!config || !authorization?.startsWith('Bearer ')) return false;
    try {
        const ticket = await verifier.verifyIdToken({ idToken: authorization.slice(7), audience: config.origin });
        const payload = ticket.getPayload();
        return payload?.email === config.serviceAccount && payload.email_verified === true;
    } catch { return false; }
}

/** Create one named task; ALREADY_EXISTS is successful deduplication, while other failures trigger scheduler retry. */
async function enqueueReportTask(kind: 'dispatch' | 'generate', identity: string, payload: Record<string, unknown>): Promise<void> {
    const config = getReportTaskConfiguration();
    if (!config) throw new Error('Weekly report task configuration is incomplete.');
    const client = await auth.getClient();
    const name = createHash('sha256').update(`${kind}:${identity}`).digest('hex');
    try {
        await client.request({
            url: `https://cloudtasks.googleapis.com/v2/${config.queue}/tasks`, method: 'POST', timeout: 15000,
            data: { task: {
                name: `${config.queue}/tasks/${name}`, dispatchDeadline: '180s',
                httpRequest: {
                    httpMethod: 'POST', url: `${config.origin}/internal/weekly-reports/${kind}`,
                    headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)).toString('base64'),
                    oidcToken: { serviceAccountEmail: config.serviceAccount, audience: config.origin }
                }
            } }
        });
    } catch (error) {
        if (typeof error === 'object' && error && 'response' in error &&
            (error.response as { status?: number } | undefined)?.status === 409) return;
        throw new Error('Unable to enqueue weekly reports; check Cloud Tasks connectivity and service-account permissions.', { cause: error });
    }
}

/** Scan one stable account-ID page, enqueue eligible local Sundays, then continue through another bounded task. */
export async function dispatchWeeklyReports(afterUserId = 0, now = new Date(), scanTime = now.toISOString()): Promise<void> {
    if (!getReportTaskConfiguration()) return;
    const users = await prisma.user.findMany({
        where: { id: { gt: afterUserId }, ...CURRENT_ACCOUNT_ACCESS_WHERE, onboarding_completed_at: { not: null } },
        orderBy: { id: 'asc' }, take: DISPATCH_BATCH_SIZE, select: { id: true, timezone: true }
    });
    for (const user of users) {
        const today = getSafeUtcTodayDateOnlyInTimeZone(user.timezone, new Date(scanTime));
        if (today.getUTCDay() !== 0) continue;
        const cutoff = addUtcDays(today, -7);
        const [weight, food, completeDay] = await Promise.all([
            prisma.bodyMetric.findFirst({ where: { user_id: user.id, date: { lte: cutoff } }, select: { id: true } }),
            prisma.foodLog.findFirst({ where: { user_id: user.id, local_date: { lte: cutoff } }, select: { id: true } }),
            prisma.foodLogDay.findFirst({ where: { user_id: user.id, local_date: { lte: cutoff }, status: 'COMPLETE' }, select: { id: true } })
        ]);
        if (!weight && !food && !completeDay) continue;
        const reportDate = today.toISOString().slice(0, 10);
        const ready = await prisma.weeklyProgressReport.findUnique({
            where: { user_id_report_date: { user_id: user.id, report_date: today } }, select: { status: true }
        });
        if (ready?.status === 'READY') continue;
        await enqueueReportTask('generate', `${user.id}:${reportDate}`, { userId: user.id, reportDate });
    }
    if (users.length === DISPATCH_BATCH_SIZE) {
        const cursor = users.at(-1)!.id;
        await enqueueReportTask('dispatch', `${scanTime}:${cursor}`, { afterUserId: cursor, scanTime });
    }
}
