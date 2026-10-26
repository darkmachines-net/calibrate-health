/** @file Deterministic health snapshots and an MCP Apps postMessage host for browser acceptance tests. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { ProgressExplorerSnapshot } from '../../backend/src/mcp/progressTypes';

/** Construct representative, incomplete and missing-day evidence without using any account data. */
export function progressFixture(): ProgressExplorerSnapshot {
  const days = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 27 + index)).toISOString().slice(0, 10);
    const complete = index % 8 !== 0;
    const calories = complete ? 1900 + (index % 7) * 55 : 600;
    return { date, status: complete ? 'COMPLETE' as const : 'INCOMPLETE' as const, source: 'explicit', is_representative: complete,
      total_calories_kcal: calories, entry_count: complete ? 6 : 2,
      calorie_comparison: complete ? { consumed_kcal: calories, target_kcal: 2150, maintenance_kcal: 2650, captured_at: `${date}T20:00:00Z` } : null };
  });
  const points = days.filter((_, index) => index % 3 === 0).map((day, index) => {
    const trend = 89.5 - index * .12;
    return { date: day.date, raw_weight: trend + Math.sin(index) * .4, trend_weight: index > 3 ? trend : null,
      confidence_95: index > 3 ? { lower: trend - .4, upper: trend + .4 } : null, is_segment_start: index === 4 };
  });
  const group = (key: string, average: number) => ({ key, complete_day_count: 11, total_calories_kcal: average * 11, average_daily_calories_kcal: average });
  return {
    schema_version: 1, as_of_date: '2026-10-24', timezone: 'America/Los_Angeles',
    range: { start_date: '2026-07-27', end_date: '2026-10-24', day_count: 90 }, granted_sections: { food: true, weight: true },
    available_history: { food: { first_date: '2024-02-01', last_date: '2026-10-24' }, weight: { first_date: '2024-01-02', last_date: '2026-10-22' } },
    current_goal: { direction: 'weight_loss', start_weight: 92, target_weight: 80, current_weight: 85.9, current_weight_date: '2026-10-22', weight_unit: 'kg', progress_percent: 50.8, remaining_weight: 5.9, configured_daily_deficit_kcal: 500, projection_status: 'projected', projected_end_date: '2027-01-23' },
    current_calorie_plan: { as_of_date: '2026-10-24', plan_status: 'ready', plan_reason_code: null, profile_estimated_tdee_kcal: 2650, base_daily_target_kcal: 2150, current_daily_target_kcal: 2150, target_adjustment_kcal: 0, configured_daily_deficit_kcal: 500 },
    food: { days, summary: { complete_day_count: 78, open_day_count: 0, incomplete_day_count: 12, paused_day_count: 0, before_tracking_day_count: 0, total_calories_kcal: 160680, average_daily_calories_kcal: 2060, compared_day_count: 78, compared_consumed_total_kcal: 160680, compared_target_total_kcal: 167700, average_captured_target_kcal: 2150, average_target_difference_kcal: -90 }, patterns: { weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day, index) => group(day, 1980 + index * 30)), week_parts: [group('weekday', 2020), group('weekend', 2180)], meal_periods: [group('breakfast', 420), group('morning_snack', 120), group('lunch', 600), group('afternoon_snack', 140), group('dinner', 660), group('evening_snack', 120)] } },
    weight: { weight_unit: 'kg', points, period_summary: { observation_count: 30, first_observation: { date: '2026-07-27', weight: 89.5 }, last_observation: { date: '2026-10-22', weight: 85.9 }, observation_span_days: 87, raw_weight_change: -3.6 }, trend: { as_of_date: '2026-10-24', status: 'sufficient', evidence_status: 'sufficient', freshness: 'current', model_version: 2, latest_observation_date: '2026-10-22', days_since_latest_observation: 2, latest_trend: { weight: 86, lower: 85.6, upper: 86.4 }, weekly_rate: { estimate: -.28, lower: -.39, upper: -.17, unit: 'kg/week', status: 'sufficient', point_count: 30, span_days: 87 } } },
    interpretation_notes: ['Only complete food days are representative.', 'Current goals are context, not historical goal versions.']
  };
}

type HostOptions = { theme?: 'light' | 'dark'; messaging?: boolean; rejectMessage?: boolean; messageDelay?: number; expand?: boolean; failTools?: boolean; snapshot?: ProgressExplorerSnapshot };

/** Install a real iframe and minimal protocol host; all tool and message traffic remains in the page. */
export async function installHost(page: Page, options: HostOptions = {}) {
  const html = readFileSync(resolve('backend/dist/mcp-app/progress.html'), 'utf8');
  await page.setContent('<!doctype html><html lang="en"><head><title>MCP App test host</title></head><body style="margin:0"><iframe title="Calibrate progress" style="display:block;width:100%;height:600px;border:0"></iframe></body></html>');
  await page.evaluate(({ html, options, fixture }) => {
    const frame = document.querySelector('iframe')!;
    const state = { calls: [] as Record<string, unknown>[], messages: [] as Record<string, unknown>[], contexts: [] as Record<string, unknown>[], displayModes: [] as string[] };
    Object.assign(window, { hostState: state });
    const send = (value: unknown) => frame.contentWindow!.postMessage(value, '*');
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || !event.data?.method) return;
      const message = event.data;
      const respond = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
      if (message.method === 'ui/initialize') {
        respond({ protocolVersion: message.params.protocolVersion, hostInfo: { name: 'Calibrate test host', version: '1' }, hostCapabilities: { serverTools: {}, updateModelContext: { text: {} }, ...(options.messaging === false ? {} : { message: { text: {} } }) }, hostContext: { theme: options.theme ?? 'light', displayMode: 'inline', availableDisplayModes: options.expand ? ['inline', 'fullscreen'] : ['inline'] } });
      } else if (message.method === 'ui/notifications/initialized') {
        send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Progress snapshot' }], structuredContent: fixture } });
      } else if (message.method === 'tools/call') {
        state.calls.push(message.params);
        if (options.failTools) { respond({ isError: true, content: [{ type: 'text', text: 'unavailable' }] }); return; }
        const args = message.params.arguments;
        if (message.params.name === 'compare_progress_periods') {
          respond({ content: [], structuredContent: { ...fixture, first: { range: { ...args.first, day_count: fixture.range.day_count }, food: fixture.food, weight: fixture.weight }, second: { range: { ...args.second, day_count: fixture.range.day_count }, food: fixture.food, weight: fixture.weight }, differences: { average_daily_calories_kcal: 0, average_target_difference_kcal: 0, raw_weight_change: 0 } } });
        } else {
          const days = Math.round((Date.parse(args.end_date) - Date.parse(args.start_date)) / 86_400_000) + 1;
          const inRange = (point: { date: string }) => point.date >= args.start_date && point.date <= args.end_date;
          respond({ content: [], structuredContent: { ...fixture, range: { ...args, day_count: days },
            food: fixture.food ? { ...fixture.food, days: fixture.food.days.filter(inRange) } : null,
            weight: fixture.weight ? { ...fixture.weight, points: fixture.weight.points.filter(inRange) } : null } });
        }
      } else if (message.method === 'ui/message') {
        state.messages.push(message.params);
        setTimeout(() => respond(options.rejectMessage ? { isError: true } : {}), options.messageDelay ?? 0);
      } else if (message.method === 'ui/update-model-context') {
        state.contexts.push(message.params); respond({});
      } else if (message.method === 'ui/request-display-mode') {
        state.displayModes.push(message.params.mode); respond({ mode: message.params.mode });
        send({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: message.params.mode } });
      } else if (message.method === 'ui/notifications/size-changed') {
        frame.style.height = `${Math.max(600, message.params.height ?? 600)}px`;
      }
    });
    frame.srcdoc = html;
  }, { html, options, fixture: options.snapshot ?? progressFixture() });
  return page.frameLocator('iframe');
}

/** Read host-observed traffic to assert intent, exact date ranges, and absence of automatic chat messages. */
export async function hostTraffic(page: Page) {
  return page.evaluate(() => (window as unknown as { hostState: { calls: { name: string; arguments: Record<string, unknown> }[]; messages: { role: string; content: { type: string; text: string }[] }[]; contexts: unknown[]; displayModes: string[] } }).hostState);
}
