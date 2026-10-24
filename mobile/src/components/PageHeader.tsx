/** @file Page Header: Header for public and pre-shell routes that cannot use authenticated app navigation. */

import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { spacing } from '../theme';
import { AppIconButton } from './AppIconButton';
import { AppText } from './AppText';

type PageHeaderProps = ViewProps & {
    title: string;
    description?: string;
    eyebrow?: string;
    onBack?: () => void;
    backLabel?: string;
    actions?: React.ReactNode;
};

/** Header for public and pre-shell routes that cannot use authenticated app navigation. */
export const PageHeader: React.FC<PageHeaderProps> = ({
    title,
    description,
    eyebrow,
    onBack,
    backLabel = 'Go back',
    actions,
    style,
    ...props
}) => (
    <View {...props} style={[styles.root, style]}>
        {onBack ? (
            <AppIconButton
                icon="chevron-back"
                accessibilityLabel={backLabel}
                onPress={onBack}
            />
        ) : null}
        <View style={styles.copy}>
            {eyebrow ? <AppText variant="label">{eyebrow}</AppText> : null}
            <AppText
                accessibilityRole="header"
                aria-level={1}
                nativeID="route-focus-title"
                variant="screenTitle"
            >
                {title}
            </AppText>
            {description ? <AppText variant="caption">{description}</AppText> : null}
        </View>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
);

const styles = StyleSheet.create({
    root: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    }
});
