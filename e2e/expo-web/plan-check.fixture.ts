/** @file Synthetic plan-check windows and saved reports for browser interaction and visual coverage. */
import { planCheckFixture } from '../../mobile/test/fixtures/planCheck';
export const PLAN_CHECK_STATUS = planCheckFixture();
PLAN_CHECK_STATUS.weeklyReports.push({ ...PLAN_CHECK_STATUS.weeklyReports[0], reportDate: '2026-11-01', summary: 'Previous weekly report.' });
