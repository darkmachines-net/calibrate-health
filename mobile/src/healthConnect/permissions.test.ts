/** @file Regression coverage for permissions: Health Connect permission mapping. */

import type { Permission } from 'react-native-health-connect';
import { grantedFeaturesForPermissions, permissionsForSelection } from './permissions';
import { DEFAULT_HEALTH_CONNECT_SELECTION } from './types';

describe('Health Connect permission mapping', () => {
    it('requests activity reads without weight by default', () => {
        expect(permissionsForSelection()).toEqual([
            { accessType: 'read', recordType: 'Steps' },
            { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
            { accessType: 'read', recordType: 'TotalCaloriesBurned' },
            { accessType: 'read', recordType: 'ExerciseSession' }
        ]);
    });

    it('requests weight only after explicit opt-in', () => {
        expect(permissionsForSelection({ ...DEFAULT_HEALTH_CONNECT_SELECTION, weight: true }))
            .toContainEqual({ accessType: 'read', recordType: 'Weight' });
    });

    it('ignores unrelated and write permissions when deriving granted features', () => {
        const permissions = [
            { accessType: 'read', recordType: 'Steps' },
            { accessType: 'write', recordType: 'Weight' },
            { accessType: 'read', recordType: 'HeartRate' }
        ] as Permission[];

        expect(grantedFeaturesForPermissions(permissions)).toEqual(['steps']);
    });
});
