/** @file Goal Daily Change Select: Shared deficit/surplus selector used during onboarding and later goal edits. */

import React, { useMemo } from 'react';
import type { CaloriePlanOption } from '@calibrate/shared';
import { OverlaySelect, type OverlaySelectOption } from './OverlaySelect';
import { getPlanOptionUnavailableCopy } from '../caloriePlanning/presentation';
import {
    DAILY_GOAL_CHANGE_OPTIONS,
    getDailyGoalChangeCopy,
    type GoalMode
} from '../utils/goals';

type GoalDailyChangeSelectProps = {
    goalMode: Exclude<GoalMode, 'maintain'>;
    value: string;
    isOpen: boolean;
    onToggle: () => void;
    onChange: (value: string) => void;
    planOptions?: CaloriePlanOption[];
};

/** Shared deficit/surplus selector used during onboarding and later goal edits. */
export const GoalDailyChangeSelect: React.FC<GoalDailyChangeSelectProps> = ({
    goalMode,
    value,
    isOpen,
    onToggle,
    onChange,
    planOptions
}) => {
    const options = useMemo<Array<OverlaySelectOption<string>>>(() => (
        DAILY_GOAL_CHANGE_OPTIONS.map((option) => {
            const optionValue = String(option);
            const copy = getDailyGoalChangeCopy(goalMode, optionValue);
            const dailyDeficit = goalMode === 'lose' ? option : -option;
            const serverOption = planOptions?.find((candidate) => candidate.dailyDeficit === dailyDeficit);
            const disabled = serverOption?.available !== true;
            return {
                value: optionValue,
                label: copy.label,
                description: serverOption?.dailyCalorieTarget === null || serverOption?.dailyCalorieTarget === undefined
                    ? copy.description
                    : `${copy.description} | ${serverOption.dailyCalorieTarget.toLocaleString()} kcal/day`,
                disabled,
                disabledReason: disabled
                    ? getPlanOptionUnavailableCopy(serverOption?.reasonCode ?? 'SERVER_POLICY_UNAVAILABLE')
                    : undefined
            };
        })
    ), [goalMode, planOptions]);

    return (
        <OverlaySelect
            accessibilityLabel="Select daily calorie change"
            value={value}
            options={options}
            isOpen={isOpen}
            onToggle={onToggle}
            onChange={onChange}
            placeholder="Choose an available pace"
        />
    );
};
