/** @file Card Header: Consistent card title, metadata, and action row across dashboard densities. */

import React, { type ReactNode } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from './AppText';

export type CardHeaderProps = Omit<ViewProps, 'children'> & {
    title: string;
    metadata?: string | null;
    action?: ReactNode;
    density?: 'compact' | 'comfortable';
    headingLevel?: 2 | 3 | 4 | 5 | 6;
    headingTestID?: string;
};

/** Consistent card title, metadata, and action row across dashboard densities. */
export const CardHeader: React.FC<CardHeaderProps> = ({
    title,
    metadata,
    action,
    density = 'compact',
    headingLevel = 2,
    headingTestID,
    style,
    ...props
}) => {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);

    return (
        <View {...props} style={[styles.root, density === 'comfortable' && styles.comfortable, style]}>
            <View testID={headingTestID} style={styles.heading}>
                <AppText
                    accessibilityRole="header"
                    aria-level={headingLevel}
                    style={styles.title}
                >
                    {title}
                </AppText>
                {metadata ? <AppText style={styles.metadata}>{metadata}</AppText> : null}
            </View>
            {action ? <View style={styles.action}>{action}</View> : null}
        </View>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: {
            minHeight: theme.typography.styles.card.lineHeight,
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: theme.spacing.sm
        },
        comfortable: {
            minHeight: theme.interaction.minimumTouchTarget,
            alignItems: 'center'
        },
        heading: {
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            columnGap: theme.spacing.sm,
            rowGap: theme.spacing.xs
        },
        title: {
            color: theme.colors.onSurface,
            ...theme.typography.styles.section
        },
        metadata: {
            flexShrink: 1,
            color: theme.colors.onSurfaceVariant,
            ...theme.typography.styles.caption
        },
        action: {
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center'
        }
    });
}
