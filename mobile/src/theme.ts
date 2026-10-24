/** @file Shared client palettes, semantic typography, spacing, and theme selection from canonical design tokens. */

import { Platform, type ColorSchemeName } from 'react-native';
import { useSystemColorScheme } from './hooks/useSystemColorScheme';
import {
    calibrateDesignTokens,
    type CalibrateColorScheme,
    type CalibrateSemanticColors
} from '@calibrate/shared/designTokens';

export type AppColorScheme = CalibrateColorScheme;
export type AppThemePreference = AppColorScheme | 'system';

type LegacyColorAliases = {
    surfaceAlt: string;
    surfaceMuted: string;
    text: string;
    muted: string;
    primaryDark: string;
    primarySoft: string;
    border: string;
    controlTrack: string;
    infoSoft: string;
    dangerMuted: string;
    warningDark: string;
    warningSoft: string;
    nav: string;
};

export type AppThemeColors = CalibrateSemanticColors & LegacyColorAliases;

function createColors(mode: AppColorScheme): AppThemeColors {
    const scheme = calibrateDesignTokens.schemes[mode];
    const isDark = mode === 'dark';

    return {
        ...scheme,
        // Compatibility names keep existing screens working while they migrate
        // toward semantic surface/on-surface roles.
        surfaceAlt: scheme.surfaceContainer,
        surfaceMuted: scheme.surfaceContainerLow,
        text: scheme.onSurface,
        muted: scheme.onSurfaceVariant,
        primaryDark: isDark ? scheme.primary : calibrateDesignTokens.brand.greenDark,
        primarySoft: scheme.primaryContainer,
        border: scheme.outlineVariant,
        controlTrack: isDark ? scheme.outlineVariant : '#B8C5B8',
        infoSoft: scheme.infoContainer,
        dangerMuted: scheme.onDangerContainer,
        warningDark: scheme.onWarningContainer,
        warningSoft: scheme.warningContainer,
        nav: isDark ? scheme.surfaceContainer : calibrateDesignTokens.brand.ink
    };
}

export const spacing = {
    xs: calibrateDesignTokens.spacing.extraSmall,
    sm: calibrateDesignTokens.spacing.small,
    md: calibrateDesignTokens.spacing.medium,
    lg: calibrateDesignTokens.spacing.large,
    xl: calibrateDesignTokens.spacing.extraLarge,
    xxl: calibrateDesignTokens.spacing.jumbo
};

export const radius = {
    sm: calibrateDesignTokens.shape.small,
    md: calibrateDesignTokens.shape.medium,
    lg: calibrateDesignTokens.shape.large,
    xl: calibrateDesignTokens.shape.extraLarge,
    sheet: calibrateDesignTokens.shape.sheet,
    pill: calibrateDesignTokens.shape.pill
};

export const typeScale = calibrateDesignTokens.typography;

// Raw browser inputs need the same explicit system stack used by React Native Web controls.
const INPUT_FONT_FAMILY = Platform.OS === 'web'
    ? '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
    : undefined;

export const typography = {
    // Numeric aliases preserve existing StyleSheet call sites while new shared
    // components consume the complete, line-height-safe styles below.
    title: typeScale.page.fontSize,
    screenTitle: typeScale.page.fontSize,
    subtitle: typeScale.section.fontSize,
    body: typeScale.body.fontSize,
    small: typeScale.label.fontSize,
    caption: typeScale.caption.fontSize,
    metric: typeScale.metric.fontSize,
    styles: {
        ...typeScale,
        input: { ...typeScale.body, letterSpacing: 0, fontFamily: INPUT_FONT_FAMILY, fontWeight: '500' as const }
    }
};

export const interaction = { ...calibrateDesignTokens.interaction };

const stroke = {
    control: 1 // Keeps rounded interactive outlines stable across Android display densities.
};

function createShadows(mode: AppColorScheme) {
    return {
        card: {
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: mode === 'dark' ? 0.24 : 0.06,
            shadowRadius: 3,
            elevation: 1
        },
        button: {
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: mode === 'dark' ? 0.28 : 0.10,
            shadowRadius: 4,
            elevation: 2
        },
        raised: {
            shadowColor: '#000000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: mode === 'dark' ? 0.34 : 0.12,
            shadowRadius: 10,
            elevation: 5
        }
    };
}

function createTheme(mode: AppColorScheme) {
    return {
        mode,
        dark: mode === 'dark',
        colors: createColors(mode),
        spacing,
        radius,
        typography,
        interaction,
        stroke,
        shadows: createShadows(mode)
    } as const;
}

export const themes = {
    light: createTheme('light'),
    dark: createTheme('dark')
} as const;

export type AppTheme = typeof themes.light | typeof themes.dark;

/** Selects the dark palette only for an explicit dark scheme, otherwise the light palette. */
export function resolveAppTheme(colorScheme: ColorSchemeName | null | undefined): AppTheme {
    return colorScheme === 'dark' ? themes.dark : themes.light;
}

/** Follow system appearance unless the caller supplies an override. */
export function useAppTheme(preference: AppThemePreference = 'system'): AppTheme {
    const systemScheme = useSystemColorScheme();
    return resolveAppTheme(preference === 'system' ? systemScheme : preference);
}
