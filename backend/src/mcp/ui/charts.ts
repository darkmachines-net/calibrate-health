/** @file Compact SVG charts preserving observed/model distinctions and food-day completeness in a single-view explorer. */
import type { ProgressFood, ProgressRange, ProgressWeight, ProgressWeightPoint } from '../progressTypes';
import { MS_PER_DAY } from '../../utils/date';
import { escapeHtml, number } from './presentation';

// Shared viewBox geometry keeps labels legible and charts responsive in narrow host panels.
const CHART = { width: 680, height: 200, left: 48, right: 20, top: 16, bottom: 32 };
// Match the panel gutters and chart border/padding so SVG labels retain readable size on phones.
const NARROW_BREAKPOINT = 520;
const NARROW_PANEL_GUTTERS = 32;
const WIDE_PANEL_GUTTERS = 48;
const CHART_FRAME_GUTTERS = 26;
// A slightly shorter phone plot leaves the goal and chat actions within the initial overview.
const NARROW_CHART_HEIGHT = 180;

function geometry() {
  const panelGutters = window.innerWidth <= NARROW_BREAKPOINT ? NARROW_PANEL_GUTTERS : WIDE_PANEL_GUTTERS;
  return { ...CHART, height: window.innerWidth <= NARROW_BREAKPOINT ? NARROW_CHART_HEIGHT : CHART.height, width: Math.max(200, Math.min(CHART.width, window.innerWidth - panelGutters - CHART_FRAME_GUTTERS)) };
}

function scales(range: ProgressRange, minimum: number, maximum: number) {
  const chart = geometry();
  const start = Date.parse(range.start_date);
  const span = Math.max(MS_PER_DAY, Date.parse(range.end_date) - start);
  const spread = Math.max(1, maximum - minimum);
  return {
    x: (date: string) => chart.left + (Date.parse(date) - start) / span * (chart.width - chart.left - chart.right),
    y: (value: number) => chart.height - chart.bottom - (value - minimum) / spread * (chart.height - chart.top - chart.bottom)
  };
}

function frame(range: ProgressRange, minimum: number, maximum: number, unit: string, content: string): string {
  const chart = geometry();
  const { y } = scales(range, minimum, maximum);
  const ticks = [minimum, (minimum + maximum) / 2, maximum];
  return `<svg viewBox="0 0 ${chart.width} ${chart.height}" role="img" aria-label="${escapeHtml(unit)} history from ${range.start_date} to ${range.end_date}">
    ${ticks.map((value) => `<line class="grid" x1="${chart.left}" x2="${chart.width - chart.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${chart.left - 8}" y="${y(value) + 4}" text-anchor="end">${number(value, 1)}</text>`).join('')}
    ${content}
    <text x="${chart.left}" y="${chart.height - 5}">${range.start_date}</text>
    <text x="${chart.width - chart.right}" y="${chart.height - 5}" text-anchor="end">${range.end_date}</text>
  </svg>`;
}

/** Draw raw observations, separate model segments and confidence bands; never connect gaps without modeled data. */
export function weightChart(weight: ProgressWeight, range: ProgressRange): string {
  if (!weight.points.length) return '<p class="notice">No weight observations in this period. Choose another period or ask about the available history.</p>';
  const values = weight.points.flatMap((point) => [point.raw_weight, point.confidence_95?.lower ?? point.raw_weight, point.confidence_95?.upper ?? point.raw_weight]);
  const padding = Math.max(.5, (Math.max(...values) - Math.min(...values)) * .12);
  const min = Math.min(...values) - padding;
  const max = Math.max(...values) + padding;
  const { x, y } = scales(range, min, max);
  const segments: ProgressWeightPoint[][] = [];
  let segment: ProgressWeightPoint[] = [];
  for (const point of weight.points) {
    if (point.trend_weight === null || point.is_segment_start) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point.trend_weight !== null) segment.push(point);
  }
  if (segment.length) segments.push(segment);
  const trend = segments.map((points) => {
    const band = points.filter((point) => point.confidence_95 !== null);
    const polygon = [...band.map((point) => `${x(point.date)},${y(point.confidence_95!.upper)}`), ...[...band].reverse().map((point) => `${x(point.date)},${y(point.confidence_95!.lower)}`)].join(' ');
    return `<polygon class="confidence" points="${polygon}"/><polyline class="trend" points="${points.map((point) => `${x(point.date)},${y(point.trend_weight!)}`).join(' ')}"/>`;
  }).join('');
  const dots = weight.points.map((point) => `<circle class="raw" cx="${x(point.date)}" cy="${y(point.raw_weight)}" r="3"><title>${point.date}: ${number(point.raw_weight, 2)} ${weight.weight_unit} observed</title></circle>`).join('');
  return `<div class="chart">${frame(range, min, max, weight.weight_unit, trend + dots)}<div class="legend"><span>Observed weight</span><span class="trend-key">Modeled trend</span><span class="band-key">95% interval</span></div></div>`;
}

/** Draw daily logged calories with muted incomplete days and only genuinely captured historical targets. */
export function foodChart(food: ProgressFood, range: ProgressRange): string {
  const chart = geometry();
  if (!food.days.some((day) => day.entry_count > 0)) return '<p class="notice">No food entries in this period. Empty days are not evidence of low intake.</p>';
  const max = Math.max(1, ...food.days.flatMap((day) => [day.total_calories_kcal, day.calorie_comparison?.target_kcal ?? 0])) * 1.08;
  const { x, y } = scales(range, 0, max);
  const width = Math.max(1, Math.min(12, (chart.width - chart.left - chart.right) / range.day_count * .7));
  const bars = food.days.map((day) => {
    const bar = `<rect class="${day.is_representative ? 'food-bar' : 'partial-bar'}" x="${x(day.date) - width / 2}" y="${y(day.total_calories_kcal)}" width="${width}" height="${y(0) - y(day.total_calories_kcal)}"><title>${day.date}: ${number(day.total_calories_kcal)} kcal logged | ${escapeHtml(day.status)}</title></rect>`;
    const target = day.calorie_comparison?.target_kcal;
    return bar + (target === undefined ? '' : `<circle class="target" cx="${x(day.date)}" cy="${y(target)}" r="1.6"><title>${day.date}: captured target ${number(target)} kcal</title></circle>`);
  }).join('');
  return `<div class="chart">${frame(range, 0, max, 'Calories', bars)}<div class="legend"><span class="trend-key">Complete day</span><span class="partial-key">Other logged day</span><span class="target-key">Captured daily target</span></div></div>`;
}
