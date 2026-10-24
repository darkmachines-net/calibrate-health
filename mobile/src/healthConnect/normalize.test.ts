/** @file Regression coverage for normalize: Health Connect normalization. */

import {
    buildDaySummary,
    buildLocalDayRanges,
    normalizeAggregateValue,
    normalizeHealthConnectRecord
} from './normalize';

const metadata = {
    id: 'record-1',
    dataOrigin: 'com.sec.android.app.shealth',
    lastModifiedTime: '2026-07-11T18:00:00.000Z',
    clientRecordId: 'client-1',
    clientRecordVersion: 4,
    recordingMethod: 2,
    device: { type: 6, manufacturer: 'Samsung', model: 'Galaxy Watch Ultra' }
};

describe('Health Connect normalization', () => {
    it('preserves source metadata while converting record-specific units', () => {
        expect(normalizeHealthConnectRecord('ActiveCaloriesBurned', {
            metadata,
            startTime: '2026-07-11T17:00:00.000Z',
            endTime: '2026-07-11T18:00:00.000Z',
            startZoneOffset: { totalSeconds: -25_200 },
            endZoneOffset: { totalSeconds: -25_200 },
            energy: { inKilocalories: 123.4 }
        })).toEqual(expect.objectContaining({
            record_id: 'record-1',
            data_origin: 'com.sec.android.app.shealth',
            client_record_version: '4',
            energy_kcal: 123.4,
            device_model: 'Galaxy Watch Ultra',
            start_zone_offset_seconds: -25_200
        }));
    });

    it('treats the native negative client-version sentinel as absent', () => {
        expect(normalizeHealthConnectRecord('Steps', {
            metadata: { ...metadata, clientRecordId: '', clientRecordVersion: -1 },
            startTime: '2026-07-11T17:00:00.000Z',
            endTime: '2026-07-11T18:00:00.000Z',
            count: 1_000
        })).toEqual(expect.objectContaining({
            client_record_id: null,
            client_record_version: null
        }));
    });

    it('uses true IANA-local day boundaries across DST transitions', () => {
        const spring = buildLocalDayRanges(
            'America/Los_Angeles',
            new Date('2026-03-08T18:00:00.000Z'),
            1
        )[0];
        const fall = buildLocalDayRanges(
            'America/Los_Angeles',
            new Date('2026-11-01T18:00:00.000Z'),
            1
        )[0];

        expect(spring).toEqual({
            localDate: '2026-03-08',
            startTime: '2026-03-08T08:00:00.000Z',
            endTime: '2026-03-09T07:00:00.000Z'
        });
        expect(fall).toEqual({
            localDate: '2026-11-01',
            startTime: '2026-11-01T07:00:00.000Z',
            endTime: '2026-11-02T08:00:00.000Z'
        });
    });

    it('preserves the instantaneous zone offset on weight records', () => {
        expect(normalizeHealthConnectRecord('Weight', {
            metadata,
            time: '2026-07-11T18:00:00.000Z',
            zoneOffset: { totalSeconds: -25_200 },
            weight: { inGrams: 83_914.6 }
        })).toEqual(expect.objectContaining({
            start_time: '2026-07-11T18:00:00.000Z',
            start_zone_offset_seconds: -25_200,
            weight_grams: 83_915
        }));
    });

    it('normalizes aggregate units into one complete observed-day payload', () => {
        const summary = buildDaySummary('2026-07-11', '2026-07-11T20:00:00.000Z', {
            steps: normalizeAggregateValue('Steps', { COUNT_TOTAL: 8_000 }),
            activeCaloriesKcal: normalizeAggregateValue('ActiveCaloriesBurned', {
                ACTIVE_CALORIES_TOTAL: { inKilocalories: 450 }
            }),
            totalCaloriesKcal: normalizeAggregateValue('TotalCaloriesBurned', {
                ENERGY_TOTAL: { inKilocalories: 2_300 }
            }),
            exerciseMinutes: normalizeAggregateValue('ExerciseSession', {
                EXERCISE_DURATION_TOTAL: { inSeconds: 2_700 }
            })
        });

        expect(summary).toEqual({
            local_date: '2026-07-11',
            steps: 8_000,
            active_calories_kcal: 450,
            total_calories_kcal: 2_300,
            exercise_minutes: 45,
            observed_at: '2026-07-11T20:00:00.000Z'
        });
    });
});
