/** @file Regression coverage for presentation: weight save recognition presentation. */

import type { MetricProgressUpdate } from '@calibrate/api-client';
import { getWeightRecognitionPresentation } from './presentation';

const BASE_UPDATE: MetricProgressUpdate = {
    save_kind: 'created',
    local_date: '2026-08-03',
    is_current_day: true,
    current_weight_grams: 75000,
    goal: {
        id: 1,
        mode: 'lose',
        previous_progress_percent: 49,
        current_progress_percent: 51,
        remaining_weight_grams: 5000,
        is_complete: false,
        reached_local_date: null
    },
    recognitions: []
};

describe('weight save recognition presentation', () => {
    it('gives goal completion priority over every other recognition', () => {
        const presentation = getWeightRecognitionPresentation({
            ...BASE_UPDATE,
            goal: { ...BASE_UPDATE.goal!, is_complete: true, remaining_weight_grams: 0 },
            recognitions: [
                { type: 'goal_weight', threshold_grams: 4536 },
                { type: 'goal_percent', threshold_percent: 75 },
                { type: 'goal_reached' }
            ]
        }, 'LB');

        expect(presentation.title).toBe('Goal reached!');
        expect(presentation.goalReached).toBe(true);
    });

    it('chooses only the highest crossed percentage milestone', () => {
        const presentation = getWeightRecognitionPresentation({
            ...BASE_UPDATE,
            recognitions: [
                { type: 'goal_percent', threshold_percent: 25 },
                { type: 'goal_percent', threshold_percent: 75 },
                { type: 'goal_weight', threshold_grams: 4536 }
            ]
        }, 'LB');

        expect(presentation.title).toBe('Three quarters of the way there');
        expect(presentation.goalReached).toBe(false);
    });

    it('recognizes gain-goal bests without loss-centric language', () => {
        const presentation = getWeightRecognitionPresentation({
            ...BASE_UPDATE,
            goal: { ...BASE_UPDATE.goal!, mode: 'gain' },
            recognitions: [{ type: 'meaningful_best', improvement_grams: 500 }]
        }, 'KG');

        expect(presentation.title).toBe('A new high for this goal');
    });

    it('keeps historical saves neutral even if a receipt contains a milestone', () => {
        const presentation = getWeightRecognitionPresentation({
            ...BASE_UPDATE,
            is_current_day: false,
            recognitions: [{ type: 'goal_reached' }]
        }, 'LB');

        expect(presentation.title).toBe('Added to your history');
        expect(presentation.goalReached).toBe(false);
    });

    it('degrades safely for an older server without a progress receipt', () => {
        expect(getWeightRecognitionPresentation(undefined, 'LB')).toEqual(expect.objectContaining({
            title: 'Weight logged',
            goalReached: false
        }));
    });
});
