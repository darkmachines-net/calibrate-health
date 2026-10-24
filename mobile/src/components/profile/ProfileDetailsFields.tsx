/** @file Profile Details Fields: Profile identity inputs shared by onboarding and the account editor. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import {
    HEIGHT_UNITS,
    type ActivityLevel,
    type HeightUnit,
    type Sex
} from '@calibrate/shared';
import { spacing } from '../../theme';
import {
    HEIGHT_UNIT_OPTIONS,
    SEX_OPTIONS
} from '../../utils/profileOptions';
import { AppChip } from '../AppChip';
import { AppText } from '../AppText';
import { DatePickerField } from '../DatePickerField';
import { NumberStepperField } from '../NumberStepperField';
import { SegmentedControl } from '../SegmentedControl';
import { TimeZonePickerField } from '../TimeZonePickerField';
import { ActivityLevelSelector } from './ActivityLevelSelector';

type ProfileIdentityFieldsProps = {
    dateOfBirth: string;
    minimumDate: string;
    maximumDate: string;
    onDateOfBirthChange: (value: string) => void;
    sex: Sex | null;
    onSexChange: (value: Sex) => void;
};

/** Profile identity inputs shared by onboarding and the account editor. */
export const ProfileIdentityFields: React.FC<ProfileIdentityFieldsProps> = ({
    dateOfBirth,
    minimumDate,
    maximumDate,
    onDateOfBirthChange,
    sex,
    onSexChange
}) => (
    <>
        <DatePickerField
            label="Date of birth"
            value={dateOfBirth}
            onChangeDate={onDateOfBirthChange}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            fallbackDate="1990-01-01"
        />
        <AppText variant="label">Sex</AppText>
        <View style={styles.chips}>
            {SEX_OPTIONS.map((option) => (
                <AppChip
                    key={option.value}
                    label={option.label}
                    selected={sex === option.value}
                    onPress={() => onSexChange(option.value)}
                />
            ))}
        </View>
    </>
);

type ProfileEnergyFieldsProps = {
    activityLevel: ActivityLevel | null;
    onActivityLevelChange: (value: ActivityLevel) => void;
    heightUnit: HeightUnit;
    onHeightUnitChange?: (value: HeightUnit) => void;
    heightCm: string;
    onHeightCmChange: (value: string) => void;
    heightFeet: string;
    onHeightFeetChange: (value: string) => void;
    heightInches: string;
    onHeightInchesChange: (value: string) => void;
    heightLayout?: 'row' | 'stack';
    timezone?: string;
    onTimezoneChange?: (value: string) => void;
};

/** Calorie-model inputs shared by onboarding and the account editor. */
export const ProfileEnergyFields: React.FC<ProfileEnergyFieldsProps> = ({
    activityLevel,
    onActivityLevelChange,
    heightUnit,
    onHeightUnitChange,
    heightCm,
    onHeightCmChange,
    heightFeet,
    onHeightFeetChange,
    heightInches,
    onHeightInchesChange,
    heightLayout = 'stack',
    timezone,
    onTimezoneChange
}) => (
    <>
        <ActivityLevelSelector value={activityLevel} onChange={onActivityLevelChange} />
        {onHeightUnitChange && (
            <>
                <AppText variant="label">Height unit</AppText>
                <SegmentedControl
                    accessibilityLabel="Height unit"
                    options={HEIGHT_UNIT_OPTIONS}
                    value={heightUnit}
                    onChange={onHeightUnitChange}
                />
            </>
        )}
        {heightUnit === HEIGHT_UNITS.CM ? (
            <NumberStepperField
                label="Height"
                value={heightCm}
                onChangeText={onHeightCmChange}
                step={1}
                min={100}
                max={250}
                suffix="cm"
            />
        ) : (
            <View style={heightLayout === 'row' ? styles.heightRow : styles.fieldStack}>
                <NumberStepperField
                    label="Feet"
                    value={heightFeet}
                    onChangeText={onHeightFeetChange}
                    step={1}
                    min={3}
                    max={8}
                    containerStyle={heightLayout === 'row' ? styles.heightRowField : undefined}
                />
                <NumberStepperField
                    label="Inches"
                    value={heightInches}
                    onChangeText={onHeightInchesChange}
                    step={1}
                    min={0}
                    max={11}
                    containerStyle={heightLayout === 'row' ? styles.heightRowField : undefined}
                />
            </View>
        )}
        {timezone !== undefined && onTimezoneChange && (
            <TimeZonePickerField value={timezone} onChange={onTimezoneChange} />
        )}
    </>
);

const styles = StyleSheet.create({
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    fieldStack: {
        gap: spacing.md
    },
    heightRow: {
        flexDirection: 'row',
        gap: spacing.md
    },
    heightRowField: {
        flex: 1
    }
});
