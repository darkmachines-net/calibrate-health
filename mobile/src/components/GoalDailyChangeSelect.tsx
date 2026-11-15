/** @file Shared pace dropdown with server-validated options and daily calorie target previews. */

import React, { useMemo } from 'react';
import type { CaloriePlanOption, WeightUnit } from '@calibrate/shared';
import { Combobox, type ComboboxOption } from './Combobox';
import type { ExternalFieldError, FocusableFormControl } from './FormField';
import { getPlanOptionUnavailableCopy } from '../caloriePlanning/presentation';
import { formatNumber, formatWeightUnit } from '../utils/format';
import {
    DAILY_GOAL_CHANGE_OPTIONS,
    getDailyGoalChangeCopy,
    type GoalMode
} from '../utils/goals';

type GoalDailyChangeSelectProps = {
    goalMode: Exclude<GoalMode, 'maintain'>;
    value: string;
    label?: string;
    disabled?: boolean;
    isOpen?: boolean;
    onToggle?: () => void;
    onChange: (value: string) => void;
    planOptions?: CaloriePlanOption[];
    weightUnit?: WeightUnit;
    externalError?: ExternalFieldError;
    controlRef?: React.RefObject<FocusableFormControl | null>;
};

/** Select an allowed pace and optionally preview its approximate weekly weight change. */
export const GoalDailyChangeSelect: React.FC<GoalDailyChangeSelectProps> = ({
    goalMode,
    value,
    label,
    disabled,
    isOpen,
    onToggle,
    onChange,
    planOptions,
    weightUnit,
    externalError,
    controlRef
}) => {
    const options = useMemo<Array<ComboboxOption<string>>>(() => (
        DAILY_GOAL_CHANGE_OPTIONS.map((option) => {
            const optionValue = String(option);
            const copy = getDailyGoalChangeCopy(goalMode, optionValue);
            const dailyDeficit = goalMode === 'lose' ? option : -option;
            const serverOption = planOptions?.find((candidate) => candidate.dailyDeficit === dailyDeficit);
            const disabled = serverOption?.available !== true;
            const description = [copy.description];
            if (serverOption?.dailyCalorieTarget != null) description.push(`${serverOption.dailyCalorieTarget.toLocaleString()} kcal/day`);
            if (weightUnit) {
                const weeklyChange = option * 7 / (weightUnit === 'LB' ? 3500 : 7700);
                description.push(`About ${formatNumber(weeklyChange)} ${formatWeightUnit(weightUnit)}/week`);
            }
            return {
                value: optionValue,
                label: copy.label,
                description: description.join(' | '),
                disabled,
                disabledReason: disabled
                    ? getPlanOptionUnavailableCopy(serverOption?.reasonCode ?? 'SERVER_POLICY_UNAVAILABLE')
                    : undefined
            };
        })
    ), [goalMode, planOptions, weightUnit]);

    return (
        <Combobox
            label={label ?? 'Select daily calorie change'}
            hideLabel={!label}
            disabled={disabled}
            value={value}
            options={options}
            externalError={externalError}
            controlRef={controlRef}
            open={isOpen}
            onOpenChange={onToggle && (nextOpen => { if (nextOpen !== isOpen) onToggle(); })}
            closeOnSelect={isOpen === undefined}
            onChange={onChange}
            placeholder="Choose an available pace"
        />
    );
};
