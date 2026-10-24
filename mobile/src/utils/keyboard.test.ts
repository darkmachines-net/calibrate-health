/** @file Regression coverage for keyboard: keyboard avoidance. */

import { getKeyboardAvoidingBehavior } from './keyboard';

describe('keyboard avoidance', () => {
    it('shrinks Android layouts and pads iOS layouts around the system keyboard', () => {
        expect(getKeyboardAvoidingBehavior('android')).toBe('height');
        expect(getKeyboardAvoidingBehavior('ios')).toBe('padding');
        expect(getKeyboardAvoidingBehavior('web')).toBeUndefined();
    });
});
