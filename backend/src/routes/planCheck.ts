/** @file Authenticated read-only plan summaries and saved weekly reports, scoped exclusively to the session owner. */

import express from 'express';
import { getPlanCheckSummary } from '../services/planCheck';
import { listWeeklyReports } from '../services/weeklyReports/reports';
import { getReportTaskConfiguration } from '../services/weeklyReports/tasks';
import type { PlanCheckResponse } from '../../../shared/planCheck';

const router = express.Router();
router.get('/', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ message: 'Not authenticated' });
    const user = req.user as { id: number };
    try {
        const [summary, reports] = await Promise.all([getPlanCheckSummary(user.id), listWeeklyReports(user.id)]);
        const response: PlanCheckResponse = { ...summary, weeklyReportsEnabled: Boolean(getReportTaskConfiguration()), weeklyReports: reports };
        res.setHeader('Cache-Control', 'no-store');
        return res.json(response);
    } catch { return res.status(500).json({ message: 'Unable to load your progress summary.' }); }
});
export default router;
