/** @file Calibrate Logo: Map the optional logo label to platform-safe SVG accessibility props. */

import React from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import type { SvgProps } from 'react-native-svg';
import { useAppTheme } from '../theme';

type CalibrateLogoProps = {
    accessibilityLabel?: string;
    size?: number;
    testID?: string;
};

const LOGO_VIEW_BOX = '0 0 64 64';
const LOGO_GAUGE_STROKE_WIDTH = 9; // Controls the weight of the dial ring in the brand mark.
const LOGO_NOTCH_STROKE_WIDTH = 6; // Keeps the top reference notch readable at app-bar sizes.
const LOGO_NEEDLE_STROKE_WIDTH = 7; // Controls the visual weight of the green gauge needle.

/** Map the optional logo label to platform-safe SVG accessibility props. */
function getLogoAccessibilityProps(accessibilityLabel: string | undefined): SvgProps {
    const decorative = !accessibilityLabel;
    if (Platform.OS === 'web') {
        if (decorative) return { 'aria-hidden': true };
        return { 'aria-label': accessibilityLabel, role: 'img' };
    }
    if (decorative) {
        return {
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants'
        };
    }
    return {
        accessible: true,
        accessibilityElementsHidden: false,
        importantForAccessibility: 'auto',
        accessibilityRole: 'image',
        accessibilityLabel
    };
}

/**
 * Native SVG version of the Calibrate gauge mark used in the PWA header.
 */
export const CalibrateLogo: React.FC<CalibrateLogoProps> = ({ accessibilityLabel, size = 32, testID }) => {
    const theme = useAppTheme();
    const accessibilityProps = getLogoAccessibilityProps(accessibilityLabel);

    return <Svg
        width={size}
        height={size}
        viewBox={LOGO_VIEW_BOX}
        {...accessibilityProps}
        testID={testID}
    >
        <Defs>
            <LinearGradient id="calibrateNeedleGradient" x1="20" y1="48" x2="50" y2="18" gradientUnits="userSpaceOnUse">
                <Stop stopColor={theme.colors.primary} />
                <Stop offset="1" stopColor="#A3E635" />
            </LinearGradient>
        </Defs>
        <Path
            d="M48.5 14.5A24 24 0 1 0 50 49"
            fill="none"
            stroke={theme.colors.onSurface}
            strokeWidth={LOGO_GAUGE_STROKE_WIDTH}
            strokeLinecap="butt"
        />
        <Path
            d="M32 4.5V14"
            fill="none"
            stroke={theme.colors.onSurface}
            strokeWidth={LOGO_NOTCH_STROKE_WIDTH}
            strokeLinecap="round"
        />
        <Path
            d="M30.5 36.5L48.5 18.5"
            fill="none"
            stroke="url(#calibrateNeedleGradient)"
            strokeWidth={LOGO_NEEDLE_STROKE_WIDTH}
            strokeLinecap="round"
        />
        <Circle cx="29" cy="38" r="8.5" fill={theme.colors.primary} />
        <Circle cx="29" cy="38" r="3.8" fill={theme.colors.onPrimary} />
    </Svg>
};
