/** @file Reminder wall-clock input validation, normalization, and display helpers. */

export type ReminderScheduleValues = {
    foodTime: string;
    weightTime: string;
    quietStart: string;
    quietEnd: string;
};

export type ReminderScheduleErrors = Partial<Record<keyof ReminderScheduleValues, string>>;

const WALL_CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Checks trimmed input against the supported 24-hour HH:mm wall-clock format. */
export function isWallClockTime(value: string): boolean {
    return WALL_CLOCK_PATTERN.test(value.trim());
}

/** Validates reminder times and the paired optional quiet-hours interval. */
export function getReminderScheduleErrors(values: ReminderScheduleValues): ReminderScheduleErrors {
    const errors: ReminderScheduleErrors = {};
    if (!isWallClockTime(values.foodTime)) errors.foodTime = 'Enter a food reminder time as HH:mm.';
    if (!isWallClockTime(values.weightTime)) errors.weightTime = 'Enter a weight reminder time as HH:mm.';

    const quietStart = values.quietStart.trim();
    const quietEnd = values.quietEnd.trim();
    if (Boolean(quietStart) !== Boolean(quietEnd)) {
        const message = 'Enter both quiet-hour times, or leave both blank.';
        if (!quietStart) errors.quietStart = message;
        if (!quietEnd) errors.quietEnd = message;
    } else if (quietStart && quietEnd) {
        if (!isWallClockTime(quietStart)) errors.quietStart = 'Enter quiet hours as HH:mm.';
        if (!isWallClockTime(quietEnd)) errors.quietEnd = 'Enter quiet hours as HH:mm.';
        if (!errors.quietStart && !errors.quietEnd && quietStart === quietEnd) {
            errors.quietEnd = 'Quiet hours must start and end at different times.';
        }
    }
    return errors;
}

/** Reports whether any reminder schedule field has a validation error. */
export function hasReminderScheduleErrors(errors: ReminderScheduleErrors): boolean {
    return Object.values(errors).some(Boolean);
}

/** Trims reminder times and represents absent quiet-hour bounds as null on the wire. */
export function toReminderSchedulePayload(values: ReminderScheduleValues) {
    const quietStart = values.quietStart.trim();
    const quietEnd = values.quietEnd.trim();
    return {
        reminder_log_food_time: values.foodTime.trim(),
        reminder_log_weight_time: values.weightTime.trim(),
        reminder_quiet_hours_start: quietStart || null,
        reminder_quiet_hours_end: quietEnd || null
    };
}
