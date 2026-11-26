/** @file Regression coverage for Lose It archive import orchestration in Settings. */

import { WEIGHT_UNITS } from '@calibrate/shared';
import { importLoseItArchive } from './loseItImport';

describe('importLoseItArchive', () => {
    it('previews the archive and passes the inferred weight unit with non-destructive conflict modes', async () => {
        const file = {
            uri: 'file:///tmp/loseit-export.zip',
            name: 'loseit-export.zip',
            type: 'application/zip'
        };
        const summary = {
            food_logs: { total: 10, valid: 9, invalid: 1 },
            weights: { total: 4, valid: 4, invalid: 0 },
            warnings: []
        };
        const api = {
            previewLoseItImport: jest.fn(async () => ({
                summary: {
                    foodLogs: 10,
                    foodLogDays: 3,
                    weights: 4,
                    bodyFat: 2,
                    startDate: '2026-01-01',
                    endDate: '2026-01-03'
                },
                conflicts: { foodLogDays: 0, weightDays: 0 },
                warnings: [],
                weightUnitGuess: WEIGHT_UNITS.LB,
                weightUnitGuessSource: 'profile' as const
            })),
            executeLoseItImport: jest.fn(async () => summary)
        };

        await expect(importLoseItArchive(api, file, WEIGHT_UNITS.KG)).resolves.toEqual(summary);
        expect(api.previewLoseItImport).toHaveBeenCalledWith(file);
        expect(api.executeLoseItImport).toHaveBeenCalledWith(file, {
            weight_unit: WEIGHT_UNITS.LB,
            food_conflict_mode: 'MERGE',
            weight_conflict_mode: 'KEEP',
            include_body_fat: true
        });
    });
});
