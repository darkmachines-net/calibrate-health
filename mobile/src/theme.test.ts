/** @file Regression coverage for theme: mobile semantic theme. */

import { resolveAppTheme, themes, typeScale } from './theme';

function channelToLinear(channel: number): number {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
    const channels = hex.match(/[A-Fa-f0-9]{2}/g);
    if (!channels || channels.length !== 3) throw new Error(`Expected an RGB hex color, received ${hex}`);
    const [red, green, blue] = channels.map((channel) => channelToLinear(Number.parseInt(channel, 16)));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

describe('mobile semantic theme', () => {
    it('resolves the system color scheme to a complete light or dark theme', () => {
        expect(resolveAppTheme('light')).toBe(themes.light);
        expect(resolveAppTheme('dark')).toBe(themes.dark);
        expect(resolveAppTheme(null)).toBe(themes.light);
        expect(themes.dark.colors.background).not.toBe(themes.light.colors.background);
        expect(themes.dark.interaction.minimumTouchTarget).toBe(48);
    });

    it('keeps semantic text and status colors contrast-safe in both schemes', () => {
        for (const theme of [themes.light, themes.dark]) {
            expect(contrastRatio(theme.colors.onSurface, theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onSurfaceVariant, theme.colors.surfaceContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.warning, theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onWarningContainer, theme.colors.warningContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.danger, theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onDanger, theme.colors.danger)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onDangerContainer, theme.colors.dangerContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onNeutralEmphasis, theme.colors.neutralEmphasis)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onNeutralEmphasisContainer, theme.colors.neutralEmphasisContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onSelection, theme.colors.selection)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onSelectionContainer, theme.colors.selectionContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onPositive, theme.colors.positive)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onPositiveContainer, theme.colors.positiveContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onCaution, theme.colors.caution)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onCautionContainer, theme.colors.cautionContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onCelebration, theme.colors.celebration)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.onCelebrationContainer, theme.colors.celebrationContainer)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(theme.colors.outline, theme.colors.surfaceContainer)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(theme.colors.focusRing, theme.colors.surface)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(theme.colors.selection, theme.colors.surface)).toBeGreaterThanOrEqual(3);
        }
    });

    it('uses a saturated red for dark-mode danger states', () => {
        expect(themes.dark.colors.danger).toBe('#FF5F56');
        expect(themes.dark.colors.danger).not.toBe(themes.light.colors.danger);
    });

    it('defines the locked page, section, card, body, label, caption, and metric scale', () => {
        expect(typeScale.page).toEqual(expect.objectContaining({ fontSize: 28, lineHeight: 34 }));
        expect(typeScale.section).toEqual(expect.objectContaining({ fontSize: 20, lineHeight: 26 }));
        expect(typeScale.card).toEqual(expect.objectContaining({ fontSize: 16, lineHeight: 22 }));
        expect(typeScale.body).toEqual(expect.objectContaining({ fontSize: 16, lineHeight: 24 }));
        expect(typeScale.label).toEqual(expect.objectContaining({ fontSize: 14, lineHeight: 20 }));
        expect(typeScale.caption).toEqual(expect.objectContaining({ fontSize: 12, lineHeight: 16 }));
        expect(typeScale.metric).toEqual(expect.objectContaining({ fontSize: 44, lineHeight: 50 }));
    });

    it('keeps caution separate from neutral selection and informational emphasis', () => {
        for (const theme of [themes.light, themes.dark]) {
            expect(theme.colors.selectionContainer).not.toBe(theme.colors.cautionContainer);
            expect(theme.colors.neutralEmphasisContainer).not.toBe(theme.colors.cautionContainer);
            expect(theme.colors.positive).toBe(theme.colors.success);
            expect(theme.colors.caution).toBe(theme.colors.warning);
        }
    });
});
