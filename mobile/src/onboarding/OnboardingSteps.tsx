/** @file Shared About you, Activity, and Your plan step forms with canonical measurement preservation. */

import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { HEIGHT_UNITS, WEIGHT_UNITS } from '@calibrate/shared';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { AppNotice } from '../components/AppNotice';
import { AppChoiceGroup } from '../components/AppChoiceGroup';
import { DatePickerField } from '../components/DatePickerField';
import { FormField, type FocusableFormControl } from '../components/FormField';
import { TextField } from '../components/TextField';
import { SegmentedControl } from '../components/SegmentedControl';
import { TimeZonePickerField } from '../components/TimeZonePickerField';
import { ActivityLevelSelector } from '../components/profile/ActivityLevelSelector';
import { AsyncStateBoundary, useAsyncResourceState } from '../components/AsyncStateBoundary';
import { isNeverEmpty } from '../asyncState/resolveAsyncState';
import { getMinimumDateOfBirth } from '../caloriePlanning/dateBounds';
import { getCaloriePlanPresentation, getPlanOptionUnavailableCopy } from '../caloriePlanning/presentation';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { formatTimeZoneLabel, isValidIanaTimeZone } from '../utils/timezones';
import { SEX_OPTIONS } from '../utils/profileOptions';
import { GOAL_MODE_OPTIONS, DAILY_GOAL_CHANGE_OPTIONS } from '../utils/goals';
import { normalizeDecimalInput } from '../utils/numericInput';
import { normalizeWeightInputText } from '../weightEntry/input';
import { radius, spacing, useAppTheme } from '../theme';
import { editWeight, editHeight, changeHeightUnit, changeWeightUnit, type OnboardingField } from './completionState';
import { MeasurementUnitToggle } from './MeasurementUnitToggle';
import type { OnboardingController } from './useOnboardingController';

export type OnboardingControlRefs = Record<OnboardingField, React.RefObject<FocusableFormControl | null>>;
type StepProps = { controller: OnboardingController; controls: OnboardingControlRefs };
const KCAL_PER_POUND = 3500;
const KCAL_PER_KILOGRAM = 7700;
const DAYS_PER_WEEK = 7;

/** Collects profile measurements, birth date, sex, and timezone with canonical quantity preservation. */
export function AboutYouStep({ controller, controls }: StepProps) {
    const { form, setForm, errors, clearFieldError } = controller;
    const { fontScale } = useWindowDimensions();
    const [timezoneOpen, setTimezoneOpen] = useState(false);
    const restoreHeightUnitFocus = useRef(false);
    const today = useCurrentLocalDate(isValidIanaTimeZone(form.timezone) ? form.timezone : 'UTC');
    const weightLabel = `Current weight (${form.weightUnit.toLowerCase()})`;
    const weightToggle = <MeasurementUnitToggle measurement="Weight" unit={form.weightUnit.toLowerCase()}
        nextUnit={form.weightUnit === WEIGHT_UNITS.KG ? 'lb' : 'kg'} onPress={() => {
            clearFieldError('currentWeight'); clearFieldError('targetWeight');
            setForm((current) => changeWeightUnit(current, current.weightUnit === WEIGHT_UNITS.KG ? WEIGHT_UNITS.LB : WEIGHT_UNITS.KG));
        }} />;
    const heightToggle = <MeasurementUnitToggle focusOnMount={restoreHeightUnitFocus.current} measurement="Height" unit={form.heightUnit === HEIGHT_UNITS.CM ? 'cm' : 'ft/in'}
        nextUnit={form.heightUnit === HEIGHT_UNITS.CM ? 'ft/in' : 'cm'} onPress={() => {
            const unit = form.heightUnit === HEIGHT_UNITS.CM ? HEIGHT_UNITS.FT_IN : HEIGHT_UNITS.CM;
            const next = changeHeightUnit(form, unit);
            if (next.heightUnit !== unit) {
                controller.showErrors({ ...errors, height: 'Finish entering your height before changing units.' });
            } else {
                restoreHeightUnitFocus.current = true;
                clearFieldError('height'); setForm(next);
            }
        }} />;
    return (
        <View style={styles.sections}>
            <View style={styles.group}>
                <FormField label="Sex used for calorie calculation" errorText={errors.sex}
                    helperText="Age and sex help estimate your daily calorie needs." controlRef={controls.sex}>
                    {(field) => <SegmentedControl {...field} accessibilityLabel="Sex used for calorie calculation"
                        options={SEX_OPTIONS} value={form.sex} controlRef={controls.sex}
                        onChange={(sex) => { clearFieldError('sex'); setForm((current) => ({ ...current, sex })); }} />}
                </FormField>
                <DatePickerField label="Date of birth" value={form.dateOfBirth}
                    controlRef={controls.dateOfBirth} errorText={errors.dateOfBirth}
                    minimumDate={getMinimumDateOfBirth(today)} maximumDate={today} fallbackDate="1990-01-01"
                    onChangeDate={(dateOfBirth) => { clearFieldError('dateOfBirth'); setForm((current) => ({ ...current, dateOfBirth })); }} />
            </View>
            <View style={styles.group}>
                <TextField label={weightLabel} value={form.currentWeight} controlRef={controls.currentWeight}
                    errorText={errors.currentWeight} keyboardType="decimal-pad" selectTextOnFocus trailingAccessory={weightToggle}
                    onChangeText={(text) => {
                        clearFieldError('currentWeight');
                        setForm((current) => editWeight(current, 'currentWeight', normalizeWeightInputText(text)));
                    }} />
                {form.heightUnit === HEIGHT_UNITS.CM ? (
                    <TextField label="Height (cm)" value={form.heightCm} controlRef={controls.height}
                        errorText={errors.height} keyboardType="decimal-pad" selectTextOnFocus trailingAccessory={heightToggle}
                        onChangeText={(text) => {
                            clearFieldError('height');
                            setForm((current) => editHeight(current, 'heightCm', normalizeDecimalInput(text)));
                        }} />
                ) : (
                    <View style={[styles.heightRow, fontScale >= 1.5 && styles.stacked]}>
                        <TextField label="Feet" value={form.heightFeet} controlRef={controls.height}
                            errorText={errors.height} keyboardType="number-pad" selectTextOnFocus containerStyle={styles.flex}
                            onChangeText={(text) => {
                                clearFieldError('height');
                                setForm((current) => editHeight(current, 'heightFeet', normalizeDecimalInput(text)));
                            }} />
                        <TextField label="Inches" value={form.heightInches} keyboardType="number-pad"
                            selectTextOnFocus containerStyle={styles.inchesField} trailingAccessory={heightToggle}
                            onChangeText={(text) => {
                                clearFieldError('height');
                                setForm((current) => editHeight(current, 'heightInches', normalizeDecimalInput(text)));
                            }} />
                    </View>
                )}
            </View>
            <View style={styles.group} ref={(element) => { controls.timezone.current = element; }} tabIndex={-1}>
                <View style={styles.timezoneRow}>
                    <View style={styles.flex}>
                        <AppText variant="label">Time zone</AppText>
                        <AppText variant="muted">{formatTimeZoneLabel(form.timezone)}</AppText>
                    </View>
                    <AppButton title={timezoneOpen ? 'Done' : 'Change'} accessibilityLabel={timezoneOpen ? 'Done changing time zone' : 'Change time zone'}
                        variant="ghost" onPress={() => setTimezoneOpen((current) => !current)} />
                </View>
                {errors.timezone && <FieldError message={errors.timezone} />}
                {(timezoneOpen || Boolean(errors.timezone)) && <TimeZonePickerField value={form.timezone}
                    onChange={(timezone) => { clearFieldError('timezone'); setForm((current) => ({ ...current, timezone })); setTimezoneOpen(false); }} />}
            </View>
        </View>
    );
}

/** Renders activity-level selection and clears its field error when the choice changes. */
export function ActivityStep({ controller, controls }: StepProps) {
    return <ActivityLevelSelector value={controller.form.activityLevel}
        errorText={controller.errors.activityLevel} controlRef={controls.activityLevel}
        onChange={(activityLevel) => {
            controller.clearFieldError('activityLevel');
            controller.setForm((current) => ({ ...current, activityLevel }));
        }} />;
}

/** Collects goal direction, target weight, and an available pace with live calorie-preview state. */
export function YourPlanStep({ controller, controls }: StepProps) {
    const { form, setForm, errors, planQuery, clearFieldError } = controller;
    const previewState = useAsyncResourceState(planQuery, isNeverEmpty);
    const weightUnit = form.weightUnit.toLowerCase();
    const isChangingWeight = form.goalMode === 'lose' || form.goalMode === 'gain';
    const paceOptions = useMemo(() => DAILY_GOAL_CHANGE_OPTIONS.map((magnitude) => {
        const isGain = form.goalMode === 'gain';
        const option = planQuery.data?.planOptions.find((candidate) => candidate.dailyDeficit === (isGain ? -magnitude : magnitude));
        const weeklyChange = magnitude * DAYS_PER_WEEK / (form.weightUnit === 'LB' ? KCAL_PER_POUND : KCAL_PER_KILOGRAM);
        return {
            value: String(magnitude),
            label: `${isGain ? 'Gain' : 'Lose'} about ${weeklyChange.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${weightUnit}/week`,
            description: `${magnitude.toLocaleString()} kcal/day ${isGain ? 'surplus' : 'deficit'}`,
            disabled: option?.available !== true || planQuery.isFetching || planQuery.isError || controller.completion.isPending,
            disabledReason: option?.available === false ? getPlanOptionUnavailableCopy(option.reasonCode) : undefined
        };
    }), [form.goalMode, form.weightUnit, weightUnit, planQuery.data, planQuery.isFetching, planQuery.isError, controller.completion.isPending]);

    return (
        <View style={styles.sections}>
            <View style={styles.group}>
                <FormField label="Goal direction" errorText={errors.goalMode} controlRef={controls.goalMode}>
                    {(field) => <SegmentedControl {...field} accessibilityLabel="Goal direction"
                        options={GOAL_MODE_OPTIONS} value={form.goalMode} controlRef={controls.goalMode} disabled={controller.completion.isPending}
                        onChange={(goalMode) => {
                            clearFieldError('goalMode'); clearFieldError('dailyChangeAbs'); clearFieldError('targetWeight');
                            setForm((current) => ({ ...current, goalMode, dailyChangeAbs: current.goalMode === goalMode ? current.dailyChangeAbs : '' }));
                        }} />}
                </FormField>
                {isChangingWeight && (
                    <>
                        <AppText variant="muted">Starting at {form.currentWeight} {weightUnit}</AppText>
                        <TextField label={`Target weight (${weightUnit})`} value={form.targetWeight} controlRef={controls.targetWeight}
                            keyboardType="decimal-pad" selectTextOnFocus errorText={errors.targetWeight} editable={!controller.completion.isPending}
                            trailingAccessory={<MeasurementUnitToggle measurement="Weight" unit={weightUnit}
                                nextUnit={form.weightUnit === WEIGHT_UNITS.KG ? 'lb' : 'kg'} disabled={controller.completion.isPending}
                                onPress={() => {
                                    clearFieldError('targetWeight');
                                    setForm((current) => changeWeightUnit(current, current.weightUnit === WEIGHT_UNITS.KG ? WEIGHT_UNITS.LB : WEIGHT_UNITS.KG));
                                }} />}
                            onChangeText={(text) => {
                                clearFieldError('targetWeight');
                                setForm((current) => editWeight(current, 'targetWeight', normalizeWeightInputText(text)));
                            }} />
                    </>
                )}
                {form.goalMode === 'maintain' && <AppText variant="muted">
                    Maintain around {form.currentWeight} {weightUnit}, with no planned deficit or surplus.
                </AppText>}
            </View>
            <AsyncStateBoundary state={previewState} resourceLabel="calorie plan options"
                loading={<AppText variant="muted">Finding your calorie target...</AppText>}
                empty={<AppText variant="muted">No calorie plans are available.</AppText>}
                onRetry={controller.isOnline ? () => planQuery.refetch() : undefined} retrying={planQuery.isFetching}>
                {planQuery.data?.eligibility.status !== 'eligible' ? (
                    <AppNotice tone="warning"><AppText>{getCaloriePlanPresentation(planQuery.data?.eligibility.reasonCode).message}</AppText></AppNotice>
                ) : (
                    <View style={styles.sections}>
                        {isChangingWeight && <View style={styles.group}>
                            <AppChoiceGroup label="Goal pace" options={paceOptions} value={form.dailyChangeAbs || null}
                                errorText={errors.dailyChangeAbs} controlRef={controls.dailyChangeAbs}
                                onChange={(dailyChangeAbs) => { clearFieldError('dailyChangeAbs'); setForm((current) => ({ ...current, dailyChangeAbs })); }} />
                            <AppText variant="caption">Weekly changes are estimates. Your actual progress will vary.</AppText>
                        </View>}

                    </View>
                )}
            </AsyncStateBoundary>
            <View style={styles.editActions}>
                <AppButton title="Edit details" variant="ghost" disabled={controller.completion.isPending} onPress={() => controller.editStep('about')} />
                <AppButton title="Edit activity" variant="ghost" disabled={controller.completion.isPending} onPress={() => controller.editStep('activity')} />
            </View>
        </View>
    );
}

/** Displays the current onboarding target preview and explains pending or unavailable calculations. */
export function OnboardingTargetSummary({ controller, compact }: { controller: OnboardingController; compact: boolean }) {
    const { colors } = useAppTheme();
    let explanation = 'Choose your goal and an available pace to see your target.';
    if (controller.planQuery.isFetching) explanation = 'Updating your target...';
    else if (controller.form.goalMode === 'maintain') explanation = 'Your maintenance target is not available yet.';
    return (
        <View style={[styles.targetSummary, compact && styles.compactSummary, { backgroundColor: colors.primaryContainer }]}>
            <AppText variant="label" style={{ color: colors.onPrimaryContainer }}>Your daily calorie target</AppText>
            {controller.planVerified ? (
                <>
                    <AppText variant="metric" accessibilityLiveRegion="polite" style={{ color: colors.onPrimaryContainer }}>
                        {controller.selectedOption!.dailyCalorieTarget!.toLocaleString()} kcal
                    </AppText>
                    {!compact && <AppText variant="muted" style={{ color: colors.onPrimaryContainer }}>A starting target based on your details and goal.</AppText>}
                </>
            ) : <AppText style={{ color: colors.onPrimaryContainer }}>{explanation}</AppText>}
        </View>
    );
}
function FieldError({ message }: { message: string }) {
    const { colors } = useAppTheme();
    return <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.danger }}>{message}</AppText>;
}

const styles = StyleSheet.create({
    sections: { gap: spacing.xxl },
    group: { gap: spacing.md },
    heightRow: { flexDirection: 'row', gap: spacing.sm },
    // Reserve space beside the inches input for its compact unit switch.
    inchesField: { flex: 2, minWidth: 0 },
    stacked: { flexDirection: 'column' },
    flex: { flex: 1, minWidth: 0 },
    timezoneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    targetSummary: { padding: spacing.lg, borderRadius: radius.lg, gap: spacing.sm },
    compactSummary: { padding: spacing.md, gap: spacing.xs },
    editActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }
});
