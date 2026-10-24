/** @file Regression coverage for haptics: preference-aware haptics. */

import * as Haptics from 'expo-haptics';
import { triggerHapticFeedback } from './haptics';

jest.mock('expo-haptics', () => ({
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
    notificationAsync: jest.fn(() => Promise.resolve()),
    selectionAsync: jest.fn(() => Promise.resolve())
}));

describe('preference-aware haptics', () => {
    beforeEach(() => jest.clearAllMocks());

    it('does nothing when the account preference is disabled', () => {
        triggerHapticFeedback(false, 'selection');
        triggerHapticFeedback(false, 'success');

        expect(Haptics.selectionAsync).not.toHaveBeenCalled();
        expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });

    it('maps selection and notification feedback without waiting on it', () => {
        triggerHapticFeedback(true, 'selection');
        triggerHapticFeedback(true, 'success');
        triggerHapticFeedback(true, 'warning');
        triggerHapticFeedback(true, 'error');

        expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
        expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(1, 'success');
        expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(2, 'warning');
        expect(Haptics.notificationAsync).toHaveBeenNthCalledWith(3, 'error');
    });

    it('swallows asynchronous and synchronous engine failures', async () => {
        (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error('Unavailable'));
        expect(() => triggerHapticFeedback(true, 'success')).not.toThrow();
        await Promise.resolve();

        (Haptics.notificationAsync as jest.Mock).mockImplementationOnce(() => {
            throw new Error('Missing engine');
        });
        expect(() => triggerHapticFeedback(true, 'success')).not.toThrow();
    });
});
