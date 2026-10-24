/** @file Regression coverage for expo Project: resolveExpoProjectId. */

import { resolveExpoProjectId } from './expoProject';

describe('resolveExpoProjectId', () => {
    it('prefers the project identity embedded in an EAS build', () => {
        expect(resolveExpoProjectId({
            easConfig: { projectId: ' eas-build-project ' },
            expoConfig: { extra: { eas: { projectId: 'app-config-project' } } }
        }, 'environment-project')).toBe('eas-build-project');
    });

    it('uses app config when EAS runtime metadata is unavailable', () => {
        expect(resolveExpoProjectId({
            expoConfig: { extra: { eas: { projectId: ' app-config-project ' } } }
        }, undefined)).toBe('app-config-project');
    });

    it('supports a local-build environment override', () => {
        expect(resolveExpoProjectId({}, ' local-project ')).toBe('local-project');
    });

    it('rejects missing and blank project identities', () => {
        expect(resolveExpoProjectId({
            easConfig: { projectId: ' ' },
            expoConfig: { extra: { eas: { projectId: '' } } }
        }, '  ')).toBeNull();
    });
});
