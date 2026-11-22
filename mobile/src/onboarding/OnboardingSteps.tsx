/** @file Onboarding forms for profile details, activity, and the user's initial weight goal. */

import React, { useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { HEIGHT_UNITS, isMaintenanceRange, WEIGHT_UNITS } from '@calibrate/shared';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { AppNotice } from '../components/AppNotice';
import { GoalDailyChangeSelect } from '../components/GoalDailyChangeSelect';
import { DatePickerField } from '../components/DatePickerField';
import { FormField, type FocusableFormControl } from '../components/FormField';
import { GOAL_TYPE_LABEL, GoalTypeSelector } from '../components/GoalTypeSelector';
import { TextField } from '../components/TextField';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { MaintenanceRangeFields } from '../progress/MaintenanceRangeFields';
import { displayMaintenanceDistance, distanceFromInput } from '../progress/maintenanceRange';
import { SegmentedControl } from '../components/SegmentedControl';
import { TimeZonePickerField } from '../components/TimeZonePickerField';
import { ActivityLevelSelector } from '../components/profile/ActivityLevelSelector';
import { AsyncStateBoundary, useAsyncResourceState } from '../components/AsyncStateBoundary';
import { isNeverEmpty } from '../asyncState/resolveAsyncState';
import { getMinimumDateOfBirth } from '../caloriePlanning/dateBounds';
import { getCaloriePlanPresentation } from '../caloriePlanning/presentation';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { formatTimeZoneLabel, isValidIanaTimeZone } from '../utils/timezones';
import { SEX_OPTIONS } from '../utils/profileOptions';
import { normalizeDecimalInput } from '../utils/numericInput';
import { normalizeWeightInputText } from '../weightEntry/input';
import { radius, spacing, useAppTheme } from '../theme';
import { editWeight, editHeight, changeHeightUnit, changeWeightUnit, type OnboardingField } from './completionState';
import { MeasurementUnitToggle } from './MeasurementUnitToggle';
import type { OnboardingController } from './useOnboardingController';

export type OnboardingControlRefs = Record<OnboardingField, React.RefObject<FocusableFormControl | null>>;
type StepProps = { controller: OnboardingController; controls: OnboardingControlRefs };

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

/** Collects an available pace for directional goals or a reviewed maintenance range. */
export function YourPlanStep({ controller, controls, errorId }: StepProps & { errorId: string }) {
    const { form, setForm, planQuery, clearFieldError } = controller;
    const previewState = useAsyncResourceState(planQuery, isNeverEmpty);
    const weightUnit = form.weightUnit.toLowerCase();
    const targetLabel = `Target weight (${weightUnit})`;
    const goalMode = form.goalMode;
    const isChangingWeight = goalMode === 'lose' || goalMode === 'gain';
    const range = controller.maintenanceRange;
    const [distanceInput, setDistanceInput] = useState<{ text: string; unit: typeof form.weightUnit } | null>(null);
    function fieldError(field: OnboardingField) {
        const message = controller.visiblePlanErrors[field];
        return message && message === controller.planError ? { id: errorId, message } : undefined;
    }
    function editDistance(text: string) {
        clearFieldError('targetWeight');
        clearFieldError('maintenanceRange');
        setDistanceInput({ text, unit: form.weightUnit });
        setForm(current => ({ ...current, maintenanceDistanceGrams: distanceFromInput(text, current.weightUnit) }));
    }
    return (
        <View style={styles.sections}>
            <View style={styles.group}>
                <FormField label={GOAL_TYPE_LABEL} externalError={fieldError('goalMode')} controlRef={controls.goalMode}>
                    {(field) => <GoalTypeSelector {...field}
                        value={form.goalMode} controlRef={controls.goalMode} disabled={controller.completion.isPending}
                        onChange={(goalMode) => {
                            clearFieldError('goalMode'); clearFieldError('dailyChangeAbs'); clearFieldError('targetWeight'); clearFieldError('maintenanceRange');
                            if (form.goalMode !== goalMode) setDistanceInput(null);
                            setForm((current) => ({ ...current, goalMode, dailyChangeAbs: current.goalMode === goalMode ? current.dailyChangeAbs : '',
                                ...(current.goalMode !== goalMode && goalMode === 'maintain' ? {
                                    targetWeight: '', targetWeightGrams: null, maintenanceRangeDraft: undefined,
                                    maintenanceDistanceGrams: undefined, maintenanceTargetEdited: false
                                } : {}) }));
                        }} />}
                </FormField>
                {isChangingWeight && (
                    <>
                        <AppText variant="muted">Starting at {form.currentWeight} {weightUnit}</AppText>
                        <TextField label={targetLabel} accessibilityLabel={targetLabel} value={form.targetWeight} controlRef={controls.targetWeight}
                            keyboardType="decimal-pad" selectTextOnFocus required placeholder="Enter a target weight"
                            externalError={fieldError('targetWeight')} editable={!controller.completion.isPending}
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
                {range && <>
                    <MaintenanceRangeFields range={range} unit={form.weightUnit}
                        valid={isMaintenanceRange(range.target_weight_grams, range.lower_weight_grams, range.upper_weight_grams)}
                        distanceError={fieldError('maintenanceRange')} distanceControlRef={controls.maintenanceRange}
                        distance={distanceInput?.unit === form.weightUnit ? distanceInput.text : displayMaintenanceDistance(controller.maintenanceDistance, form.weightUnit)}
                        onDistanceChange={editDistance} disabled={controller.completion.isPending}
                        onUseCenteredRange={form.maintenanceRangeDraft ? () => {
                            clearFieldError('targetWeight'); clearFieldError('maintenanceRange');
                            setForm(current => ({ ...current, maintenanceRangeDraft: undefined }));
                        } : undefined}
                        targetField={<TextField label={targetLabel} accessibilityLabel={targetLabel}
                            value={form.maintenanceTargetEdited ? form.targetWeight : gramsToDisplayWeight(range.target_weight_grams, form.weightUnit)}
                            keyboardType="decimal-pad" controlRef={controls.targetWeight} required placeholder="Enter a target weight"
                            externalError={fieldError('targetWeight')} editable={!controller.completion.isPending}
                            onChangeText={text => {
                                clearFieldError('targetWeight');
                                clearFieldError('maintenanceRange');
                                setForm(current => ({ ...editWeight(current, 'targetWeight', normalizeWeightInputText(text)), maintenanceTargetEdited: true }));
                            }} />} />
                    <AppText variant="muted">You start by tracking weight. You can turn on calorie tracking from Today or Progress.</AppText>
                </>}
                {form.goalMode === 'maintain' && !range && <AppText variant="muted">
                    Maintain around {form.currentWeight} {weightUnit}, with no planned deficit or surplus.
                </AppText>}
            </View>
            {!range && <AsyncStateBoundary state={previewState} resourceLabel="calorie plan options"
                loading={<AppText variant="muted">Finding your calorie target...</AppText>}
                empty={<AppText variant="muted">No calorie plans are available.</AppText>}
                onRetry={controller.isOnline ? () => planQuery.refetch() : undefined} retrying={planQuery.isFetching}>
                {planQuery.data?.eligibility.status !== 'eligible' ? (
                    <AppNotice tone="warning"><AppText>{getCaloriePlanPresentation(planQuery.data?.eligibility.reasonCode).message}</AppText></AppNotice>
                ) : (
                    <View style={styles.sections}>
                        {isChangingWeight && <View style={styles.group}>
                            <GoalDailyChangeSelect label={goalMode === 'gain' ? 'Calorie Surplus' : 'Calorie Deficit'} goalMode={goalMode}
                                value={form.dailyChangeAbs} weightUnit={form.weightUnit} planOptions={planQuery.data?.planOptions}
                                disabled={planQuery.isFetching || planQuery.isError || controller.completion.isPending}
                                externalError={fieldError('dailyChangeAbs')} controlRef={controls.dailyChangeAbs}
                                onChange={(dailyChangeAbs) => { clearFieldError('dailyChangeAbs'); setForm((current) => ({ ...current, dailyChangeAbs })); }} />
                            <AppText variant="caption">Weekly changes are estimates. Your actual progress will vary.</AppText>
                        </View>}

                    </View>
                )}
            </AsyncStateBoundary>}
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
    if (controller.maintenanceRange) return null;
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
