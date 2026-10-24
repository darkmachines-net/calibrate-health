/** @file Regression coverage for confirm Action: confirmAction. */

import { Alert, Platform } from 'react-native';
import { confirmAction } from './confirmAction';

describe('confirmAction', () => {
    const originalPlatform = Platform.OS;
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        if (originalWindowDescriptor) {
            Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
        } else {
            delete (globalThis as { window?: unknown }).window;
        }
        jest.restoreAllMocks();
    });

    it('uses window.confirm with the full action copy on web', async () => {
        const confirm = jest.fn(() => true);
        const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { confirm }
        });

        await expect(confirmAction({
            title: 'Delete oatmeal?',
            message: 'Past logs keep their snapshots.',
            cancelLabel: 'Cancel',
            confirmLabel: 'Delete',
            destructive: true
        })).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledWith('Delete oatmeal?\n\nPast logs keep their snapshots.');
        expect(alert).not.toHaveBeenCalled();
    });
});
