/** @file Notification Card: Presents an active reminder and its logging and dismissal actions. */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { InAppNotification } from '@calibrate/api-client';
import {
    formatNotificationDate,
    getNotificationText
} from '../notifications/presentation';
import { getNotificationAction } from '../notifications/workflow';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppIconButton } from './AppIconButton';
import { AppText } from './AppText';

type NotificationCardProps = {
    notification: InAppNotification;
    isBusy?: boolean;
    onOpen: (notification: InAppNotification) => void;
    onDismiss: (notification: InAppNotification) => void;
};

/** Presents an active reminder and its logging and dismissal actions. */
export const NotificationCard: React.FC<NotificationCardProps> = ({
    notification,
    isBusy = false,
    onOpen,
    onDismiss
}) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const action = getNotificationAction(notification.action_url, notification.local_date);
    const text = getNotificationText(notification);
    const isResolved = 'resolved_at' in notification && Boolean(notification.resolved_at);
    const isUnread = !notification.read_at && !notification.dismissed_at && !isResolved;

    return (
        <AppSection
            testID={`notification-card-${notification.id}`}
            style={styles.card}
        >
            <View style={styles.row}>
                <View style={styles.iconTile}>
                    <Ionicons
                        name={isUnread ? 'notifications' : 'notifications-outline'}
                        size={20}
                        color={isUnread ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                </View>
                <View style={styles.body}>
                    <View style={styles.titleRow}>
                        <AppText variant="body" style={styles.title}>
                            {text.title}
                        </AppText>
                        {isUnread ? <View style={styles.unreadDot} /> : null}
                    </View>
                    <AppText variant="caption">
                        {formatNotificationDate(notification.local_date)}
                    </AppText>
                    <AppText variant="muted">{text.body}</AppText>
                </View>
            </View>
            <View style={styles.actions}>
                <AppButton
                    testID={`notification-open-${notification.id}`}
                    title={action.label}
                    variant="ghost"
                    accessibilityHint="Marks this reminder read and opens its Calibrate destination."
                    disabled={isBusy}
                    leftIcon={<Ionicons name="open-outline" size={18} color={theme.colors.primary} />}
                    onPress={() => onOpen(notification)}
                    style={styles.actionButton}
                />
                {!notification.dismissed_at && !isResolved && (
                    <AppIconButton
                        testID={`notification-dismiss-${notification.id}`}
                        icon="close"
                        accessibilityLabel={`Dismiss ${text.title}`}
                        disabled={isBusy}
                        iconColor={theme.colors.onSurfaceVariant}
                        onPress={() => onDismiss(notification)}
                    />
                )}
            </View>
        </AppSection>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    card: {
        gap: spacing.md,
        paddingVertical: spacing.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.outlineVariant
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md
    },
    iconTile: {
        width: spacing.lg,
        height: spacing.lg,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    body: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontWeight: '600'
    },
    unreadDot: {
        width: 10,
        height: 10,
        borderRadius: radius.pill,
        backgroundColor: theme.colors.primary
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.md
    },
    actionButton: {
        flex: 1
    }
});
