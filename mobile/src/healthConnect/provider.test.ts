/** @file Regression coverage for provider: Health Connect stored preferences. */

import {
    DEFAULT_HEALTH_CONNECT_SELECTION,
    HEALTH_CONNECT_FEATURES
} from './types';
import { parseStoredHealthConnectPreferences } from './preferences';

describe('Health Connect stored preferences', () => {
    it('uses least-privilege defaults for missing and invalid state', () => {
        expect(parseStoredHealthConnectPreferences(null)).toEqual({
            connected: false,
            paused: false,
            selection: DEFAULT_HEALTH_CONNECT_SELECTION
        });
        expect(parseStoredHealthConnectPreferences('{bad json')).toEqual({
            connected: false,
            paused: false,
            selection: DEFAULT_HEALTH_CONNECT_SELECTION
        });
    });

    it('preserves known booleans and ignores malformed feature values', () => {
        expect(parseStoredHealthConnectPreferences(JSON.stringify({
            connected: true,
            paused: true,
            selection: {
                [HEALTH_CONNECT_FEATURES.STEPS]: false,
                [HEALTH_CONNECT_FEATURES.ACTIVE_CALORIES]: 'yes',
                [HEALTH_CONNECT_FEATURES.WEIGHT]: true
            }
        }))).toEqual({
            connected: true,
            paused: true,
            selection: {
                ...DEFAULT_HEALTH_CONNECT_SELECTION,
                steps: false,
                weight: true
            }
        });
    });
});
