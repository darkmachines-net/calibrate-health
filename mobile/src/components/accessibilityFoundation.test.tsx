/** @file Regression coverage for accessibility Foundation: shared accessibility foundation. */

import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import Svg from 'react-native-svg';
import { CalibrateLogo } from './CalibrateLogo';
import { ProgressBar } from './ProgressBar';
import { WEB_ACCESSIBILITY_STYLES } from '../accessibility/webAccessibilityStyles';

describe('shared accessibility foundation', () => {
    it('keeps the native brand mark decorative by default with an accessible opt-in', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'ios');
        try {
            const decorative = render(<CalibrateLogo />);
            const decorativeProps = decorative.UNSAFE_getByType(Svg).props;
            expect(decorativeProps.accessible).toBe(false);
            expect(decorativeProps.accessibilityElementsHidden).toBe(true);
            expect(decorativeProps.importantForAccessibility).toBe('no-hide-descendants');

            const named = render(<CalibrateLogo accessibilityLabel="Calibrate" />);
            expect(named.getByRole('image', { name: 'Calibrate' })).toBeTruthy();
        } finally {
            platform.restore();
        }
    });

    it('uses DOM-safe accessibility props for the web brand mark', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web');
        try {
            const decorative = render(<CalibrateLogo />);
            const decorativeProps = decorative.UNSAFE_getByType(Svg).props;
            expect(decorativeProps).toEqual(expect.objectContaining({ 'aria-hidden': true }));
            expect(decorativeProps).not.toHaveProperty('accessible');
            expect(decorativeProps).not.toHaveProperty('accessibilityElementsHidden');
            expect(decorativeProps).not.toHaveProperty('importantForAccessibility');

            const named = render(<CalibrateLogo accessibilityLabel="Calibrate" />);
            const namedProps = named.UNSAFE_getByType(Svg).props;
            expect(namedProps).toEqual(expect.objectContaining({
                'aria-label': 'Calibrate',
                role: 'img'
            }));
            expect(namedProps).not.toHaveProperty('accessibilityLabel');
            expect(namedProps).not.toHaveProperty('accessibilityRole');
        } finally {
            platform.restore();
        }
    });

    it('exposes one named progressbar and hides its visual fill', () => {
        const screen = render(<ProgressBar accessibilityLabel="Goal progress" value={0.42} />);
        const progress = screen.getByRole('progressbar', { name: 'Goal progress' });
        expect(progress.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
        const fill = progress.children[0];
        if (typeof fill === 'string') throw new Error('Expected the progress fill view.');
        expect(fill.props).toEqual(expect.objectContaining({
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
            'aria-hidden': true
        }));
    });

    it('defines system-color fallbacks for focus, selection, and progress', () => {
        expect(WEB_ACCESSIBILITY_STYLES).toContain('@media (forced-colors: active)');
        expect(WEB_ACCESSIBILITY_STYLES).toContain(':focus-visible');
        expect(WEB_ACCESSIBILITY_STYLES).toContain('[role="radio"][aria-checked="true"]');
        expect(WEB_ACCESSIBILITY_STYLES).toContain('[role="progressbar"]');
        expect(WEB_ACCESSIBILITY_STYLES).toContain('[role="progressbar"] > [aria-hidden="true"]');
        expect(WEB_ACCESSIBILITY_STYLES).toContain('Highlight');
        expect(WEB_ACCESSIBILITY_STYLES).toContain('CanvasText');
    });
});
