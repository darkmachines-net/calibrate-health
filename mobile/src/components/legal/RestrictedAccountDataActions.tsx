/** @file Restricted Account Data Actions: Export and irreversible deletion remain available while routine health access is restricted. */

import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { AppButton } from '../AppButton';
import { AppText } from '../AppText';
import { AppSection } from '../AppSection';
import { DeleteAccountSheet } from '../../settings/AccountSettingsSheets';
import { useAuth } from '../../auth/AuthContext';
import {
    canSubmitAccountDeletion,
    deleteAccountAndClearLocalData,
    shareAccountExport
} from '../../account/accountData';
import { clearOfflineOutboxAccountData } from '../../offline/accountCleanup';
import { useHealthConnect } from '../../healthConnect/provider';
import { clearWearAccountData } from '../../wear/accountCleanup';
import { getSafeActionErrorMessage } from '../../errors/presentation';
import { spacing, useAppTheme } from '../../theme';

/** Export and irreversible deletion remain available while routine health access is restricted. */
export function RestrictedAccountDataActions() {
    const {
        api,
        user,
        serverUrl,
        clearLocalSession,
        persistAccountDeletionCleanupNotice
    } = useAuth();
    const healthConnect = useHealthConnect();
    const { colors } = useAppTheme();
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const exportAccount = useMutation({
        mutationFn: async () => {
            const accountExport = await api.exportAccount();
            await shareAccountExport(accountExport);
        }
    });
    const deleteAccount = useMutation({
        mutationFn: async () => {
            if (!user) throw new Error('Sign in again before deleting this account.');
            const accountUserId = user.id;
            await deleteAccountAndClearLocalData(password, {
                deleteRemoteAccount: (currentPassword) => api.deleteAccount(currentPassword),
                discardOfflineChanges: () => clearOfflineOutboxAccountData(serverUrl, accountUserId),
                clearHealthConnectData: healthConnect.clearAccountData,
                clearWearData: () => clearWearAccountData(serverUrl, accountUserId),
                persistCleanupNotice: persistAccountDeletionCleanupNotice,
                clearLocalSession
            });
        },
        onSuccess: () => {
            setPassword('');
            setConfirmation('');
            setDeleteOpen(false);
        }
    });

    if (!user) return null;

    function closeDelete() {
        setPassword('');
        setConfirmation('');
        deleteAccount.reset();
        setDeleteOpen(false);
    }

    function confirmDelete() {
        if (!canSubmitAccountDeletion(password, confirmation)) return;
        Alert.alert(
            'Permanently delete account?',
            'This permanently deletes your profile, tracking history, goals, saved foods, and device sessions.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete forever', style: 'destructive', onPress: () => deleteAccount.mutate() }
            ]
        );
    }

    return (
        <>
            <AppSection style={styles.card}>
                <AppText accessibilityRole="header" aria-level={2} variant="subtitle">Your account data</AppText>
                <AppText variant="muted">
                    Export remains available without restoring tracking access. Deletion is permanent.
                </AppText>
                {exportAccount.error && (
                    <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                        {getSafeActionErrorMessage(exportAccount.error, 'Unable to export account data.')}
                    </AppText>
                )}
                <View style={styles.actions}>
                    <AppButton
                        title="Export account data"
                        variant="secondary"
                        busy={exportAccount.isPending}
                        busyLabel="Preparing export..."
                        disabled={deleteAccount.isPending}
                        onPress={() => exportAccount.mutate()}
                        style={styles.action}
                    />
                    <AppButton
                        title="Delete account"
                        variant="danger"
                        disabled={exportAccount.isPending || deleteAccount.isPending}
                        onPress={() => setDeleteOpen(true)}
                        style={styles.action}
                    />
                </View>
            </AppSection>
            <DeleteAccountSheet
                visible={deleteOpen}
                isOutboxReady
                password={password}
                onPasswordChange={setPassword}
                confirmation={confirmation}
                onConfirmationChange={setConfirmation}
                error={deleteAccount.error}
                isDeleting={deleteAccount.isPending}
                onClose={closeDelete}
                onConfirm={confirmDelete}
            />
        </>
    );
}

const styles = StyleSheet.create({
    card: {
        gap: spacing.md
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    action: {
        flexGrow: 1,
        minWidth: 220
    }
});
