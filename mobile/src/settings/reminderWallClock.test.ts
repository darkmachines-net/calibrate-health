/** @file Regression coverage for reminder Wall Clock: reminderWallClock. */

import {
    getReminderScheduleErrors,
    hasReminderScheduleErrors,
    isWallClockTime,
    toReminderSchedulePayload
} from './reminderWallClock';

describe('reminderWallClock', () => {
    it('accepts canonical local wall-clock values and overnight quiet hours', () => {
        const values = {
            foodTime: '09:00',
            weightTime: '18:30',
            quietStart: '22:00',
            quietEnd: '07:00'
        };

        const errors = getReminderScheduleErrors(values);
        expect(hasReminderScheduleErrors(errors)).toBe(false);
        expect(toReminderSchedulePayload(values)).toEqual({
            reminder_log_food_time: '09:00',
            reminder_log_weight_time: '18:30',
            reminder_quiet_hours_start: '22:00',
            reminder_quiet_hours_end: '07:00'
        });
    });

    it('disables quiet hours only when both values are blank', () => {
        expect(toReminderSchedulePayload({
            foodTime: '09:00',
            weightTime: '09:00',
            quietStart: ' ',
            quietEnd: ''
        })).toMatchObject({
            reminder_quiet_hours_start: null,
            reminder_quiet_hours_end: null
        });
    });

    it('rejects partial, equal, and non-canonical wall-clock values', () => {
        expect(isWallClockTime('9:00')).toBe(false);
        expect(getReminderScheduleErrors({
            foodTime: '9:00',
            weightTime: '24:00',
            quietStart: '22:00',
            quietEnd: ''
        })).toEqual({
            foodTime: 'Enter a food reminder time as HH:mm.',
            weightTime: 'Enter a weight reminder time as HH:mm.',
            quietEnd: 'Enter both quiet-hour times, or leave both blank.'
        });
        expect(getReminderScheduleErrors({
            foodTime: '09:00',
            weightTime: '09:00',
            quietStart: '07:00',
            quietEnd: '07:00'
        }).quietEnd).toBe('Quiet hours must start and end at different times.');
    });
});
