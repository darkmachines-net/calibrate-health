/** @file Timezone-aware reminder schedule parsing and next eligible local-day occurrence calculations. */

const DEFAULT_REMINDER_LOCAL_MINUTE = 9 * 60;
const MINUTES_PER_DAY = 24 * 60;

export type LocalWallClock = {
  localDate: string;
  minuteOfDay: number;
};

/** Parse the canonical API HH:mm form into a local wall-clock minute. */
export const parseLocalWallClockTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Format a valid minute-of-day as HH:MM, using the default reminder time for invalid input. */
export const formatLocalWallClockMinute = (minute: number): string => {
  const safeMinute = Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY
    ? minute
    : DEFAULT_REMINDER_LOCAL_MINUTE;
  return `${String(Math.floor(safeMinute / 60)).padStart(2, '0')}:${String(safeMinute % 60).padStart(2, '0')}`;
};

/** Resolve the user's current local date/minute directly from their current IANA timezone. */
export const getLocalWallClock = (timeZone: string, now: Date): LocalWallClock => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    const hour = Number(value('hour'));
    const minute = Number(value('minute'));
    if (year && month && day && Number.isInteger(hour) && Number.isInteger(minute)) {
      return { localDate: `${year}-${month}-${day}`, minuteOfDay: hour * 60 + minute };
    }
  } catch {
    // Invalid stored zones fail closed to UTC, matching existing local-day behavior.
  }

  return {
    localDate: now.toISOString().slice(0, 10),
    minuteOfDay: now.getUTCHours() * 60 + now.getUTCMinutes()
  };
};

/** Quiet ranges are start-inclusive/end-exclusive and may cross midnight. */
export const isWithinQuietHours = (
  minuteOfDay: number,
  startMinute: number | null,
  endMinute: number | null
): boolean => {
  if (startMinute === null || endMinute === null || startMinute === endMinute) return false;
  if (startMinute < endMinute) return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
};

/** Treat a wall-clock reminder as due from its configured minute onward within the selected local day. */
export const isReminderDue = (minuteOfDay: number, reminderMinute: number): boolean =>
  minuteOfDay >= reminderMinute;
