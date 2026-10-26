/** @file Safe formatting, period selection, and host-chat context for the isolated progress explorer. */
import type { ProgressExplorerSnapshot, ProgressRange } from '../progressTypes';
import { MS_PER_DAY } from '../../utils/date';

/** Escape server-provided text before placing it in the App's HTML templates. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

/** Format missing or nonfinite measurements as unavailable rather than inventing a zero. */
export function number(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: digits })
    : 'Unavailable';
}

/** Shift a date-only calendar label without consulting the browser's timezone. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Validate the paired inclusive range supported by all exploration tools, including older historical periods. */
export function readRange(start: string, end: string, today: string): ProgressRange {
  for (const date of [start, end]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new Error('Choose valid start and end dates.');
    }
  }
  const dayCount = Math.round((Date.parse(end) - Date.parse(start)) / MS_PER_DAY) + 1;
  if (dayCount < 1 || dayCount > 365) throw new Error('Choose a period from 1 to 365 days, with the start before the end.');
  if (end > today) throw new Error('Choose an end date on or before your current local day.');
  return { start_date: start, end_date: end, day_count: dayCount };
}

/** Build a concrete chat question referring to the exact view, allowing the assistant to fetch its evidence. */
export function contextualQuestion(question: string, snapshot: ProgressExplorerSnapshot, comparison?: ProgressRange): string {
  const { range, timezone } = snapshot;
  const compare = comparison ? ` Compare with ${comparison.start_date} through ${comparison.end_date}.` : '';
  return `${question.trim()}\n\nUse my Calibrate data for ${range.start_date} through ${range.end_date} (${timezone}).${compare} Separate complete food days from partial or missing logging, and observed weights from modeled trends. Treat my current goal and calorie plan as current context.`;
}

/** Display machine enum labels as readable text without trusting them as markup. */
export function label(value: string): string {
  return value.toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
