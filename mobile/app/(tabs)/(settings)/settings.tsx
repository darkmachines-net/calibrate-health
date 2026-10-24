/** @file settings: Coordinates account preferences, sessions, integrations, offline recovery, export, and account deletion. */

import React, { useState } from 'react';
import { Image, Platform, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HEIGHT_UNITS, WEIGHT_UNITS } from '@calibrate/shared';
import { AppButton } from '../../../src/components/AppButton';
import { AppActionRow } from '../../../src/components/AppActionRow';
import { useServerSettings } from '../../../src/serverSettings/useServerSettings';
import { AppSection } from '../../../src/components/AppSection';
import { AppText } from '../../../src/components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../../../src/components/AsyncStateBoundary';
import { confirmDiscardChanges } from '../../../src/components/confirmDiscardChanges';
import { TabScreen } from '../../../src/components/TabScreen';
import { TextField } from '../../../src/components/TextField';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { useAuth } from '../../../src/auth/AuthContext';
import {
    canSubmitAccountDeletion,
    deleteAccountAndClearLocalData,
    shareAccountExport
} from '../../../src/account/accountData';
import { OUTBOX_MUTATION_STATES } from '../../../src/offline/queuedMutation';
import { useOfflineOutbox } from '../../../src/offline/provider';
import { hasPendingWeightMutation } from '../../../src/offline/pendingWeight';
import { supportsAndroidIntegrations } from '../../../src/platform/nativePlatform';
import { formatGoalSummary } from '../../../src/utils/goals';
import { spacing, useAppTheme } from '../../../src/theme';
import { useHealthConnect } from '../../../src/healthConnect/provider';
import { clearWearAccountData } from '../../../src/wear/accountCleanup';
import { DeleteAccountSheet } from '../../../src/settings/AccountSettingsSheets';
import {
    SettingsHome,
    shouldShowSettingsResourceStatus,
    type SettingsPageId,
    type SettingsCategoryId,
    type SettingsSheetId
} from '../../../src/settings/SettingsHome';
import {
    SettingsDetailSheet,
    SummaryRow
} from '../../../src/settings/SettingsPrimitives';
import {
    ASYNC_RESOURCE_STATES,
    isNeverEmpty,
    isNullResource,
    type AsyncResourceState
} from '../../../src/asyncState/resolveAsyncState';
import { getSafeActionErrorMessage } from '../../../src/errors/presentation';
import { getCaloriePlanPresentation } from '../../../src/caloriePlanning/presentation';
import { canonicalPathForRoute } from '../../../src/navigation/routeRegistry';

import { SettingsCategoryPage } from '../../../src/settings/SettingsCategoryPage';

const MIN_PASSWORD_LENGTH = 8;
function getAvatarLabel(email?: string | null): string {
    return email?.trim().charAt(0).toUpperCase() || 'C';
}

function hasResolvedResourceData(state: AsyncResourceState): boolean {
    return state.kind === ASYNC_RESOURCE_STATES.CONTENT
        || state.kind === ASYNC_RESOURCE_STATES.EMPTY
        || state.kind === ASYNC_RESOURCE_STATES.STALE
        || state.kind === ASYNC_RESOURCE_STATES.DEGRADED;
}

const SETTINGS_CATEGORY_ROUTES = {
    profile: 'settings-profile',
    security: 'settings-security',
    connections: 'settings-connections',
    data: 'settings-data',
    help: 'settings-help'
} as const;

/** Coordinates account preferences, sessions, integrations, offline recovery, export, and account deletion. */
export function SettingsScreen({ category }: { category?: SettingsCategoryId }) {
    const serverSettings = useServerSettings();
    const router = useRouter();
    const {
        api, user, clearLocalSession, logout, persistAccountDeletionCleanupNotice,
        serverUrl, updateCurrentUser
    } = useAuth();
    const {
        isReady: isOutboxReady,
        initializationError: outboxInitializationError,
        mutations: queuedMutations,
        discardAll: discardOfflineChanges,
        reconcile: reconcileOutbox,
        retryFailed: retryFailedOutbox
    } = useOfflineOutbox();
    const queryClient = useQueryClient();
    const { colors: themeColors } = useAppTheme();
    const isOnline = useOnlineStatus();
    const healthConnect = useHealthConnect();
    const isWeb = Platform.OS === 'web';
    const showAndroidIntegrations = supportsAndroidIntegrations();
    const weightUnit = user?.weight_unit ?? WEIGHT_UNITS.KG;
    const heightUnit = user?.height_unit ?? HEIGHT_UNITS.CM;
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [activeSheet, setActiveSheet] = useState<SettingsSheetId | null>(null);
    const [isDeleteAccountOpen, setIsDeleteAccountOpen] = useState(false);
    const [deleteAccountPassword, setDeleteAccountPassword] = useState('');
    const [deleteAccountConfirmation, setDeleteAccountConfirmation] = useState('');
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
    const passwordIsDirty = Boolean(currentPassword || newPassword || confirmPassword);
    const profileQuery = useQuery({ queryKey: ['mobile-profile'], queryFn: () => api.getUserProfile() });
    const goalQuery = useQuery({ queryKey: ['mobile-goal'], queryFn: () => api.getGoals() });
    const sessionsQuery = useQuery({
        queryKey: ['account-sessions'],
        queryFn: () => api.getAccountSessions()
    });
    const connectedAppsQuery = useQuery({
        queryKey: ['connected-apps'],
        queryFn: () => api.getConnectedApps()
    });
    const profileState = useAsyncResourceState(profileQuery, isNeverEmpty);
    const goalState = useAsyncResourceState(goalQuery, isNullResource);
    const sessionsState = useAsyncResourceState(
        sessionsQuery,
        ({ sessions }) => sessions.length === 0
    );
    const connectedAppsState = useAsyncResourceState(
        connectedAppsQuery,
        ({ connections }) => connections.length === 0
    );
    const pendingMutationCount = queuedMutations.filter(
        ({ state }) => state === OUTBOX_MUTATION_STATES.PENDING || state === OUTBOX_MUTATION_STATES.REPLAYING
    ).length;
    const hasPendingWeightChange = hasPendingWeightMutation(queuedMutations);
    const failedMutations = queuedMutations.filter(({ state }) => state === OUTBOX_MUTATION_STATES.FAILED);
    const syncOutbox = useMutation({ mutationFn: () => reconcileOutbox() });
    const retryOutbox = useMutation({ mutationFn: () => retryFailedOutbox() });
    const outboxActionError = syncOutbox.error ?? retryOutbox.error;
    let outboxErrorMessage = outboxInitializationError
        ? 'Offline changes are not available on this device. Reload Calibrate and try again.'
        : null;
    if (!outboxErrorMessage && outboxActionError) {
        outboxErrorMessage = getSafeActionErrorMessage(
            outboxActionError,
            'Unable to sync offline changes. Try again.'
        );
    }
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
            const accountServerUrl = serverUrl;
            await deleteAccountAndClearLocalData(deleteAccountPassword, {
                deleteRemoteAccount: (currentPassword) => api.deleteAccount(currentPassword),
                discardOfflineChanges,
                clearHealthConnectData: healthConnect.clearAccountData,
                clearWearData: () => clearWearAccountData(accountServerUrl, accountUserId),
                persistCleanupNotice: persistAccountDeletionCleanupNotice,
                clearLocalSession
            });
            setDeleteAccountPassword('');
            setDeleteAccountConfirmation('');
        }
    });

    function closePasswordEditor() {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setPasswordError(null);
        setPasswordStatus(null);
        setActiveSheet(null);
    }

    const updateProfileImage = useMutation({
        mutationFn: async () => {
            const ImagePicker = await import('expo-image-picker');
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: 'images',
                allowsEditing: true,
                aspect: [1, 1],
                shape: 'oval',
                quality: 0.45,
                base64: true
            });

            if (result.canceled || result.assets.length === 0) {
                return null;
            }

            const asset = result.assets[0];
            if (!asset.base64) {
                throw new Error('Selected image did not include image data.');
            }

            return api.updateProfileImage(`data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`);
        },
        onSuccess: async (response) => {
            if (!response) return;
            updateCurrentUser(response.user);
            await queryClient.invalidateQueries({ queryKey: ['mobile-profile'] });
        }
    });

    const removeProfileImage = useMutation({
        mutationFn: () => api.deleteProfileImage(),
        onSuccess: async (response) => {
            updateCurrentUser(response.user);
            await queryClient.invalidateQueries({ queryKey: ['mobile-profile'] });
        }
    });

    const changePassword = useMutation({
        mutationFn: () => api.changePassword({
            current_password: currentPassword,
            new_password: newPassword
        }),
        onSuccess: () => {
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setPasswordError(null);
            setPasswordStatus('Password updated.');
        },
        onError: (error) => {
            setPasswordStatus(null);
            setPasswordError(getSafeActionErrorMessage(error, 'Unable to update password.'));
        }
    });

    const importMutation = useMutation({
        mutationFn: async () => {
            const DocumentPicker = await import('expo-document-picker');
            const result = await DocumentPicker.getDocumentAsync({
                type: 'application/zip',
                copyToCacheDirectory: true
            });
            if (result.canceled || result.assets.length === 0) return null;
            const asset = result.assets[0];
            return api.executeLoseItImport({
                uri: asset.uri,
                name: asset.name ?? 'loseit-export.zip',
                type: asset.mimeType ?? 'application/zip'
            });
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries();
        }
    });

    function handleChangePassword() {
        setPasswordStatus(null);
        if (!currentPassword) {
            setPasswordError('Enter your current password.');
            return;
        }
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            setPasswordError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordError('New passwords do not match.');
            return;
        }
        if (newPassword === currentPassword) {
            setPasswordError('New password must be different from your current password.');
            return;
        }

        setPasswordError(null);
        changePassword.mutate();
    }

    function closeDeleteAccountEditor() {
        setDeleteAccountPassword('');
        setDeleteAccountConfirmation('');
        deleteAccount.reset();
        setIsDeleteAccountOpen(false);
    }

    function confirmDeleteAccount() {
        if (!canSubmitAccountDeletion(deleteAccountPassword, deleteAccountConfirmation)) return;
        deleteAccount.mutate();
    }

    let goalSummary = 'Current goal unavailable';
    if (goalState.kind === ASYNC_RESOURCE_STATES.LOADING) {
        goalSummary = 'Loading current goal...';
    } else if (hasResolvedResourceData(goalState)) {
        goalSummary = formatGoalSummary(goalQuery.data ?? null, user?.weight_unit);
    }
    const sessionCount = hasResolvedResourceData(sessionsState)
        ? sessionsQuery.data?.sessions.length
        : undefined;
    const connectedAppCount = hasResolvedResourceData(connectedAppsState)
        ? connectedAppsQuery.data?.connections.length
        : undefined;
    const planRequiresReview = !hasPendingWeightChange && profileQuery.data?.calorieSummary.planStatus === 'requires_review';
    const planPresentation = getCaloriePlanPresentation(
        profileQuery.data?.calorieSummary.planReasonCode,
        profileQuery.data?.calorieSummary.planStatus
    );
    function openSettingsPage(page: SettingsPageId) {
        router.push(canonicalPathForRoute(page) as Href);
    }

    function handlePlanAction() {
        if (planPresentation.actionKind === 'profile') {
            openSettingsPage('profile-details');
            return;
        }
        if (planPresentation.actionKind === 'weight') {
            router.push('/weight');
            return;
        }
        router.push({
            pathname: '/progress',
            params: { openPlanReview: 'true' }
        });
    }

    const showProfilePlanningStatus = category === undefined || category === 'profile';

    return (
        <TabScreen contentWidth="overview">
            {showProfilePlanningStatus && hasPendingWeightChange && (
                <AppSection>
                    <AppText variant="subtitle">Weight change syncing</AppText>
                    <AppText variant="muted">
                        Calorie target and projection will return after the server rechecks your plan.
                    </AppText>
                </AppSection>
            )}
            {showProfilePlanningStatus && planRequiresReview && (
                <AppSection>
                    <AppText variant="subtitle">{planPresentation.title}</AppText>
                    <AppText variant="muted">{planPresentation.message}</AppText>
                    <AppButton
                        title={planPresentation.actionLabel}
                        variant="secondary"
                        onPress={handlePlanAction}
                    />
                </AppSection>
            )}
            {showProfilePlanningStatus && shouldShowSettingsResourceStatus(profileState, isWeb) && (
                <AsyncStateBoundary
                    state={profileState}
                    resourceLabel="profile settings"
                    loading={<SettingsResourceSkeleton label="Loading profile settings..." />}
                    empty={null}
                    onRetry={isOnline ? () => profileQuery.refetch() : undefined}
                >
                    {null}
                </AsyncStateBoundary>
            )}
            {showProfilePlanningStatus && shouldShowSettingsResourceStatus(goalState, isWeb) && (
                <AsyncStateBoundary
                    state={goalState}
                    resourceLabel="your current goal"
                    loading={<SettingsResourceSkeleton label="Loading your current goal..." />}
                    empty={null}
                    onRetry={isOnline ? () => goalQuery.refetch() : undefined}
                >
                    {null}
                </AsyncStateBoundary>
            )}
            {category ? (
                <SettingsCategoryPage
                    category={category}
                    showAndroidIntegrations={showAndroidIntegrations}
                    sessionCount={sessionCount}
                    connectedAppCount={connectedAppCount}
                    isOutboxReady={isOutboxReady}
                    failedMutationCount={failedMutations.length}
                    pendingMutationCount={pendingMutationCount}
                    isWeb={isWeb}
                    onOpenPage={openSettingsPage}
                    onOpenSheet={setActiveSheet}
                    onOpenProductLink={(link) => router.push(CALIBRATE_PRODUCT_LINKS[link] as Href)}
                    onDeleteAccount={() => setIsDeleteAccountOpen(true)}
                    onLogout={() => void logout()}
                />
            ) : (
                <SettingsHome
                    email={user?.email}
                    profileImageUrl={user?.profile_image_url}
                    goalSummary={goalSummary}
                    weightUnit={weightUnit}
                    heightUnit={heightUnit}
                    sessionCount={sessionCount}
                    connectedAppCount={connectedAppCount}
                    isOutboxReady={isOutboxReady}
                    failedMutationCount={failedMutations.length}
                    pendingMutationCount={pendingMutationCount}
                    isWeb={isWeb}
                    onOpenCategory={(nextCategory) => {
                        router.push(canonicalPathForRoute(SETTINGS_CATEGORY_ROUTES[nextCategory]) as Href);
                    }}
                />
            )}

            {!category && serverSettings.isAdmin && (
                <AppActionRow accessibilityLabel="Server administration" onPress={() => router.push('/server-admin')}>
                    <AppText variant="label">Server administration</AppText>
                    <AppText variant="muted">Manage experimental features for everyone on this server.</AppText>
                </AppActionRow>
            )}

            <SettingsDetailSheet
                visible={activeSheet === 'import'}
                title="Import from Lose It"
                description="Import a Lose It ZIP export into food logs and weigh-ins."
                onClose={() => setActiveSheet(null)}
            >
                {importMutation.data && (
                    <>
                        <AppText variant="muted">
                            Imported {importMutation.data.food_logs.valid} food rows and {importMutation.data.weights.valid} weights.
                        </AppText>
                        {importMutation.data.foodDayCompletionMessage && (
                            <AppText variant="muted">{importMutation.data.foodDayCompletionMessage}</AppText>
                        )}
                    </>
                )}
                {importMutation.error && (
                    <AppText accessibilityRole="alert" style={[styles.error, { color: themeColors.danger }]}>
                        {getSafeActionErrorMessage(importMutation.error, 'Unable to import that ZIP file.')}
                    </AppText>
                )}
                <AppButton
                    title={importMutation.isPending ? 'Importing...' : 'Import Lose It ZIP'}
                    variant="secondary"
                    leftIcon={<Ionicons name="cloud-upload-outline" size={18} color={themeColors.onSurface} />}
                    onPress={() => importMutation.mutate()}
                />
            </SettingsDetailSheet>

            <SettingsDetailSheet
                visible={activeSheet === 'profile-photo'}
                title="Profile photo"
                description={user?.email ? `Signed in as ${user.email}.` : 'Used for your avatar across the app.'}
                onClose={() => setActiveSheet(null)}
            >
                <View style={styles.avatarRow}>
                    <View style={[
                        styles.avatar,
                        { backgroundColor: themeColors.primaryContainer, borderColor: themeColors.outlineVariant }
                    ]}>
                        {user?.profile_image_url ? (
                            <Image source={{ uri: user.profile_image_url }} style={styles.avatarImage} />
                        ) : (
                            <AppText variant="subtitle" style={{ color: themeColors.onPrimaryContainer }}>
                                {getAvatarLabel(user?.email)}
                            </AppText>
                        )}
                    </View>
                    <View style={styles.avatarActions}>
                        <AppButton
                            title={updateProfileImage.isPending ? 'Opening...' : 'Choose photo'}
                            variant="secondary"
                            disabled={updateProfileImage.isPending || removeProfileImage.isPending}
                            leftIcon={<Ionicons name="image-outline" size={18} color={themeColors.onSurface} />}
                            onPress={() => updateProfileImage.mutate()}
                        />
                        {user?.profile_image_url && (
                            <AppButton
                                title={removeProfileImage.isPending ? 'Removing...' : 'Remove photo'}
                                variant="ghost"
                                disabled={updateProfileImage.isPending || removeProfileImage.isPending}
                                leftIcon={<Ionicons name="trash-outline" size={18} color={themeColors.onSurface} />}
                                onPress={() => removeProfileImage.mutate()}
                            />
                        )}
                    </View>
                </View>
                {(updateProfileImage.error || removeProfileImage.error) && (
                    <AppText accessibilityRole="alert" style={[styles.error, { color: themeColors.danger }]}>
                        {getSafeActionErrorMessage(
                            updateProfileImage.error ?? removeProfileImage.error,
                            'Unable to update your profile photo.'
                        )}
                    </AppText>
                )}
            </SettingsDetailSheet>

            <SettingsDetailSheet
                visible={activeSheet === 'password'}
                maxHeight="92%"
                title="Password"
                description="Update the password for this account."
                dismissDisabled={changePassword.isPending}
                isDirty={passwordIsDirty}
                confirmDismiss={confirmDiscardChanges}
                onClose={closePasswordEditor}
            >
                <TextField
                    label="Current password"
                    secureTextEntry
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    errorText={passwordError === 'Enter your current password.' ? passwordError : undefined}
                    focusError={passwordError === 'Enter your current password.'}
                />
                <TextField
                    label="New password"
                    secureTextEntry
                    value={newPassword}
                    onChangeText={setNewPassword}
                    helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                    errorText={passwordError?.startsWith('New password must') ? passwordError : undefined}
                    focusError={Boolean(passwordError?.startsWith('New password must'))}
                />
                <TextField
                    label="Confirm new password"
                    secureTextEntry
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    errorText={passwordError === 'New passwords do not match.' ? passwordError : undefined}
                    focusError={passwordError === 'New passwords do not match.'}
                />
                {passwordError && <AppText style={[styles.error, { color: themeColors.danger }]}>{passwordError}</AppText>}
                {passwordStatus && <AppText style={[styles.success, { color: themeColors.success }]}>{passwordStatus}</AppText>}
                <AppButton
                    title={changePassword.isPending ? 'Updating...' : 'Update password'}
                    disabled={changePassword.isPending}
                    leftIcon={<Ionicons name="key-outline" size={18} color={themeColors.onPrimary} />}
                    onPress={handleChangePassword}
                />
            </SettingsDetailSheet>

            <SettingsDetailSheet
                visible={activeSheet === 'offline'}
                title={isOutboxReady ? 'Offline changes' : 'Online-only browser changes'}
                description={isOutboxReady
                    ? 'Writes saved on this device replay in order when the server is reachable.'
                    : 'The browser does not save pending writes yet. Stay online when adding or editing data.'}
                onClose={() => setActiveSheet(null)}
            >
                {isOutboxReady ? (
                    <>
                        <View style={styles.summaryRows}>
                            <SummaryRow label="Pending" value={String(pendingMutationCount)} />
                            <SummaryRow label="Failed" value={String(failedMutations.length)} />
                        </View>
                        {failedMutations.length > 0 && (
                            <AppText accessibilityRole="alert" style={[styles.error, { color: themeColors.danger }]}>
                                A saved change could not sync. Retry it or discard offline changes.
                            </AppText>
                        )}
                        {outboxErrorMessage && (
                            <AppText accessibilityRole="alert" style={[styles.error, { color: themeColors.danger }]}>
                                {outboxErrorMessage}
                            </AppText>
                        )}
                        <View style={styles.row}>
                            <AppButton
                                title={syncOutbox.isPending ? 'Syncing...' : 'Sync now'}
                                variant="secondary"
                                disabled={pendingMutationCount === 0 || failedMutations.length > 0 || syncOutbox.isPending || retryOutbox.isPending}
                                leftIcon={<Ionicons name="sync-outline" size={18} color={themeColors.onSurface} />}
                                onPress={() => syncOutbox.mutate()}
                                style={styles.rowButton}
                            />
                            {failedMutations.length > 0 && (
                                <AppButton
                                    title={retryOutbox.isPending ? 'Retrying...' : 'Retry failed'}
                                    variant="secondary"
                                    disabled={syncOutbox.isPending || retryOutbox.isPending}
                                    leftIcon={<Ionicons name="refresh-outline" size={18} color={themeColors.onSurface} />}
                                    onPress={() => retryOutbox.mutate()}
                                    style={styles.rowButton}
                                />
                            )}
                        </View>
                    </>
                ) : (
                    <AppText variant="muted">
                        If a browser request fails because the server is offline, Calibrate reports the failure and does not claim the change was queued.
                    </AppText>
                )}
            </SettingsDetailSheet>

            <SettingsDetailSheet
                visible={activeSheet === 'export'}
                title="Export your data"
                description="Download a portable JSON copy of your Calibrate account."
                onClose={() => setActiveSheet(null)}
            >
                <View testID="settings-export-sheet" style={styles.sheetContent}>
                    {exportAccount.error && (
                        <AppText accessibilityRole="alert" style={[styles.error, { color: themeColors.danger }]}>
                            {getSafeActionErrorMessage(exportAccount.error, 'Unable to export account data.')}
                        </AppText>
                    )}
                    <AppButton
                        title={exportAccount.isPending ? 'Preparing export...' : 'Export account data'}
                        variant="secondary"
                        disabled={exportAccount.isPending}
                        leftIcon={<Ionicons name="share-outline" size={18} color={themeColors.onSurface} />}
                        onPress={() => exportAccount.mutate()}
                    />
                </View>
            </SettingsDetailSheet>

            <DeleteAccountSheet
                visible={isDeleteAccountOpen}
                isOutboxReady={isOutboxReady}
                password={deleteAccountPassword}
                onPasswordChange={setDeleteAccountPassword}
                confirmation={deleteAccountConfirmation}
                onConfirmationChange={setDeleteAccountConfirmation}
                error={deleteAccount.error}
                isDeleting={deleteAccount.isPending}
                onClose={closeDeleteAccountEditor}
                onConfirm={confirmDeleteAccount}
            />
        </TabScreen>
    );
}

export default SettingsScreen;

const SettingsResourceSkeleton: React.FC<{ label: string }> = ({ label }) => (
    <AppSection accessibilityLabel={label}>
        <AppText variant="muted">{label}</AppText>
        <SkeletonBlock width="72%" height={18} />
    </AppSection>
);

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    rowButton: {
        flex: 1,
        // Sync actions wrap before their labels are compressed in phone sheets.
        minWidth: 160
    },
    sheetContent: {
        gap: spacing.md
    },
    summaryRows: {
        paddingVertical: spacing.sm,
        gap: spacing.xs
    },
    avatarRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.lg
    },
    avatar: {
        width: 76,
        height: 76,
        borderRadius: 38,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden'
    },
    avatarImage: {
        width: '100%',
        height: '100%'
    },
    avatarActions: {
        flex: 1,
        // Leave enough space for photo actions beside the avatar, or move them below it.
        minWidth: 180,
        gap: spacing.sm
    },

    success: {},
    error: {}
});
