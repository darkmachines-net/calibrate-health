/** @file Activity Level Selector: Keep activity descriptions consistent when creating and editing a calorie profile. */

import type { ActivityLevel } from '@calibrate/shared';
import { ACTIVITY_OPTIONS } from '../../utils/profileOptions';
import { AppChoiceGroup, type AppChoiceGroupProps } from '../AppChoiceGroup';

export type ActivityLevelSelectorProps = Pick<
    AppChoiceGroupProps<ActivityLevel>,
    'value' | 'onChange' | 'errorText' | 'focusError' | 'controlRef'
>;

/** Keep activity descriptions consistent when creating and editing a calorie profile. */
export function ActivityLevelSelector(props: ActivityLevelSelectorProps) {
    return <AppChoiceGroup {...props} label="Activity level" options={ACTIVITY_OPTIONS} />;
}
