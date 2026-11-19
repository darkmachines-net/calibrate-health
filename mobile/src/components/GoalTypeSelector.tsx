/** @file Shared Goal type selector for onboarding and goal setup. */

import type { ComponentProps } from 'react';
import { GOAL_MODE_OPTIONS, type GoalMode } from '../utils/goals';
import { SegmentedControl } from './SegmentedControl';

export const GOAL_TYPE_LABEL = 'Goal type';

const GOAL_TYPE_ICONS = {
    lose: 'trending-down-outline',
    maintain: 'remove-outline',
    gain: 'trending-up-outline'
} as const;
const GOAL_TYPES = GOAL_MODE_OPTIONS.map(option => ({ ...option, icon: GOAL_TYPE_ICONS[option.value] }));

type GoalTypeSelectorProps = Omit<ComponentProps<typeof SegmentedControl<GoalMode>>, 'accessibilityLabel' | 'options'>;

/** Render the shared goal choices in Lose, Maintain, Gain order with their accessible names and icons. */
export function GoalTypeSelector(props: GoalTypeSelectorProps) {
    return <SegmentedControl {...props} accessibilityLabel={GOAL_TYPE_LABEL} options={GOAL_TYPES} />;
}
