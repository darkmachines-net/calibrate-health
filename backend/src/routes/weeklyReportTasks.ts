/** @file Internal weekly-report endpoints authenticated with Google OIDC, never browser sessions or queue headers. */

import express from 'express';
import { z } from 'zod';
import { parseLocalDateOnly } from '../utils/date';
import { MS_PER_DAY } from '../utils/time';
import { generateWeeklyReport } from '../services/weeklyReports/reports';
import { dispatchWeeklyReports, getReportTaskConfiguration, isReportTaskAuthorized } from '../services/weeklyReports/tasks';

const router = express.Router();
router.use(async (req, res, next) => {
    if (!getReportTaskConfiguration()) return res.sendStatus(503);
    if (!await isReportTaskAuthorized(req.get('authorization'))) return res.sendStatus(401);
    return next();
});
router.use(express.json({ limit: '4kb' }));

const dispatchSchema = z.object({ afterUserId: z.number().int().nonnegative().optional(), scanTime: z.iso.datetime().optional() }).strict();
router.post('/dispatch', async (req, res) => {
    const parsed = dispatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.sendStatus(400);
    const now = new Date();
    if (parsed.data.scanTime && Math.abs(+new Date(parsed.data.scanTime) - +now) > MS_PER_DAY) return res.sendStatus(400);
    try {
        await dispatchWeeklyReports(parsed.data.afterUserId, now, parsed.data.scanTime);
        return res.sendStatus(204);
    } catch {
        console.error('Weekly report dispatch failed; Cloud Tasks or Cloud Scheduler will retry. Check queue permissions and database connectivity.');
        return res.sendStatus(503);
    }
});

const generateSchema = z.object({ userId: z.number().int().positive(), reportDate: z.iso.date() }).strict();
router.post('/generate', async (req, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return res.sendStatus(400);
    try {
        await generateWeeklyReport(parsed.data.userId, parseLocalDateOnly(parsed.data.reportDate));
        return res.sendStatus(204);
    } catch {
        console.error('Weekly report generation failed; Cloud Tasks will retry. Check OpenAI workload identity mapping, model access, quota and database connectivity.');
        return res.sendStatus(503);
    }
});

export default router;
