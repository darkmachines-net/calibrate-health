/** @file Section Header: Shared page and section headings with an independent action slot. */

import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { spacing } from '../theme';
import { AppText } from './AppText';

type SectionHeaderProps = ViewProps & {
    title: string;
    eyebrow?: string;
    description?: string;
    headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
    action?: React.ReactNode;
};

/**
 * Shared page and section headings with an independent action slot.
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
    title,
    eyebrow,
    description,
    headingLevel = 2,
    action,
    style,
    ...props
}) => (
    <View {...props} style={[styles.root, style]}>
        <View style={styles.copy}>
            {eyebrow && <AppText variant="label">{eyebrow}</AppText>}
            <AppText accessibilityRole="header" aria-level={headingLevel} variant={headingLevel === 1 ? 'page' : 'section'}>{title}</AppText>
            {description && <AppText variant="muted">{description}</AppText>}
        </View>
        {action}
    </View>
);

const styles = StyleSheet.create({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    }
});
