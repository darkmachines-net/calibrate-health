/** @file profile details: Render the route-owned editor for calorie-model profile details. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ACTIVITY_LEVELS,
    HEIGHT_UNITS,
    type ActivityLevel,
    type HeightUnit,
    type Sex
} from '@calibrate/shared';
import { useAuth } from '../../../src/auth/AuthContext';
import { invalidateProfilePlanningQueries } from '../../../src/caloriePlanning/queryInvalidation';
import { getHeightPolicyError, isHeightWithinPolicy } from '../../../src/caloriePlanning/heightInput';
import { spacing } from '../../../src/theme';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { TabScreen } from '../../../src/components/TabScreen';
import { useConfirmDiscardNavigation } from '../../../src/hooks/useConfirmDiscardNavigation';
import { usePendingWeightMutation } from '../../../src/offline/usePendingWeightMutation';
import { ProfileEditorContent } from '../../../src/settings/AccountSettingsSheets';
import {
    millimetersToCentimeters,
    millimetersToFeetInches
} from '../../../src/utils/bodyMeasurements';

/** Render the route-owned editor for calorie-model profile details. */
export default function ProfileSettingsScreen() {
    const router = useRouter();
    const { api, user, updateCurrentUser } = useAuth();
    const queryClient = useQueryClient();
    const hasPendingWeightChange = usePendingWeightMutation();
    const profileQuery = useQuery({
        queryKey: ['mobile-profile'],
        queryFn: () => api.getUserProfile(),
        // TabsLayout owns the initial profile gate; this observer reuses that resolved cache.
        enabled: false
    });
    const editableProfile = profileQuery.data?.profile ?? user;
    const [timezone, setTimezone] = useState(editableProfile?.timezone ?? 'UTC');
    const [dateOfBirth, setDateOfBirth] = useState(editableProfile?.date_of_birth?.slice(0, 10) ?? '');
    const [sex, setSex] = useState<Sex | null>(editableProfile?.sex ?? null);
    const [activityLevel, setActivityLevel] = useState<ActivityLevel | null>(
        editableProfile?.activity_level ?? ACTIVITY_LEVELS.LIGHT
    );
    const [heightUnit, setHeightUnit] = useState<HeightUnit>(
        editableProfile?.height_unit ?? HEIGHT_UNITS.CM
    );
    const [heightCm, setHeightCm] = useState(() => millimetersToCentimeters(editableProfile?.height_mm));
    const initialImperialHeight = millimetersToFeetInches(editableProfile?.height_mm);
    const [heightFeet, setHeightFeet] = useState(initialImperialHeight.feet);
    const [heightInches, setHeightInches] = useState(initialImperialHeight.inches);
    const [validationError, setValidationError] = useState<string | null>(null);
    const profileBaselineRef = useRef(editableProfile);
    const profileBaseline = profileBaselineRef.current;
    const profileIsDirty = Boolean(profileBaseline && (
        timezone !== profileBaseline.timezone
        || dateOfBirth !== (profileBaseline.date_of_birth?.slice(0, 10) ?? '')
        || sex !== profileBaseline.sex
        || activityLevel !== (profileBaseline.activity_level ?? ACTIVITY_LEVELS.LIGHT)
        || heightCm !== millimetersToCentimeters(profileBaseline.height_mm)
        || heightFeet !== millimetersToFeetInches(profileBaseline.height_mm).feet
        || heightInches !== millimetersToFeetInches(profileBaseline.height_mm).inches
    ));
    const calorieTarget = !hasPendingWeightChange
        && profileQuery.data?.calorieSummary.planStatus === 'available'
        ? profileQuery.data.calorieSummary.dailyCalorieTarget
        : undefined;
    const resetProfileDraft = useCallback(() => {
        if (!editableProfile) return;
        profileBaselineRef.current = editableProfile;
        setTimezone(editableProfile.timezone);
        setDateOfBirth(editableProfile.date_of_birth?.slice(0, 10) ?? '');
        setSex(editableProfile.sex);
        setActivityLevel(editableProfile.activity_level ?? ACTIVITY_LEVELS.LIGHT);
        setHeightUnit(editableProfile.height_unit);
        setHeightCm(millimetersToCentimeters(editableProfile.height_mm));
        const nextImperialHeight = millimetersToFeetInches(editableProfile.height_mm);
        setHeightFeet(nextImperialHeight.feet);
        setHeightInches(nextImperialHeight.inches);
        setValidationError(null);
    }, [editableProfile]);
    useEffect(() => {
        if (!profileIsDirty) resetProfileDraft();
    }, [resetProfileDraft, profileIsDirty]);

    function navigateToSettings() {
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace('/profile');
    }

    const saveProfile = useMutation({
        mutationFn: () =>
            api.updateProfile({
                timezone,
                date_of_birth: dateOfBirth || null,
                sex,
                activity_level: activityLevel,
                ...(heightUnit === HEIGHT_UNITS.CM
                    ? { height_cm: heightCm || null }
                    : { height_feet: heightFeet || null, height_inches: heightInches || '0' })
            })
    });
    const { allowNavigation, requestNavigation } = useConfirmDiscardNavigation(
        profileIsDirty,
        saveProfile.isPending,
        resetProfileDraft
    );

    async function handleCancel() {
        await requestNavigation(navigateToSettings);
    }

    function handleSave() {
        const heightIsValid = isHeightWithinPolicy({
            unit: heightUnit,
            centimeters: Number(heightCm),
            feet: Number(heightFeet),
            inches: Number(heightInches || '0')
        });
        if (!heightIsValid) {
            setValidationError(getHeightPolicyError(heightUnit));
            return;
        }
        setValidationError(null);
        saveProfile.mutate(undefined, {
            onSuccess: async (response) => {
                updateCurrentUser(response.user);
                await invalidateProfilePlanningQueries(queryClient);
                allowNavigation(navigateToSettings);
            }
        });
    }

    return (
        <TabScreen contentWidth="form" testID="settings-profile-page">
            <View testID="settings-profile-content" style={styles.content}>
                <SectionHeader
                    title="Calorie profile"
                    description="Time zone and body details used for calorie targets."
                />
                <ProfileEditorContent
                    timezone={timezone}
                    onTimezoneChange={setTimezone}
                    dateOfBirth={dateOfBirth}
                    onDateOfBirthChange={setDateOfBirth}
                    sex={sex}
                    onSexChange={setSex}
                    activityLevel={activityLevel}
                    onActivityLevelChange={setActivityLevel}
                    heightUnit={heightUnit}
                    heightCm={heightCm}
                    onHeightCmChange={setHeightCm}
                    heightFeet={heightFeet}
                    onHeightFeetChange={setHeightFeet}
                    heightInches={heightInches}
                    onHeightInchesChange={setHeightInches}
                    calorieTarget={calorieTarget}
                    validationError={validationError}
                    saveError={saveProfile.error}
                    isSaving={saveProfile.isPending}
                    onCancel={() => { void handleCancel(); }}
                    onSave={handleSave}
                />
            </View>
        </TabScreen>
    );
}

const styles = StyleSheet.create({
    content: { gap: spacing.lg }
});
