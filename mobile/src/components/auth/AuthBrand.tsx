/** @file Auth Brand: Branded introduction shared by the native sign-in and registration screens. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from '../AppText';
import { CalibrateLogo } from '../CalibrateLogo';
import { radius, spacing, useAppTheme } from '../../theme';

type AuthBrandProps = {
    description: string;
};

/** Branded introduction shared by the native sign-in and registration screens. */
export const AuthBrand: React.FC<AuthBrandProps> = ({ description }) => {
    const { colors } = useAppTheme();

    return (
        <View style={styles.root}>
            <View style={[styles.logoPlate, { backgroundColor: colors.primaryContainer, borderColor: colors.outlineVariant }]}>
                <CalibrateLogo size={52} />
            </View>
            <View style={styles.copy}>
                <AppText variant="label" style={{ color: colors.primary }}>Calibrate Health</AppText>
                <AppText
                    nativeID="route-focus-title"
                    accessibilityRole="header"
                    aria-level={1}
                    variant="title"
                    style={styles.wordmark}
                >
                    calibrate
                </AppText>
                <AppText variant="muted" style={styles.description}>{description}</AppText>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    root: {
        alignItems: 'center',
        gap: spacing.md
    },
    logoPlate: {
        width: 76,
        height: 76,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth
    },
    copy: {
        alignItems: 'center',
        gap: spacing.xs,
        maxWidth: 420
    },
    wordmark: {
        fontSize: 30
    },
    description: {
        textAlign: 'center'
    }
});
