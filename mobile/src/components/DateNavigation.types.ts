/** @file Shared date-navigation props used by matching browser and native implementations. */

import type { ViewProps } from 'react-native';
import type { LogDateNavigation } from '../hooks/useLogDateNavigation';

export type DateNavigationProps = ViewProps & {
    navigation: LogDateNavigation;
    compact?: boolean;
    unified?: boolean;
    /** Render optional picker actions; the supplied callback closes the picker. */
    pickerFooter?: (closePicker: () => void) => React.ReactNode;
};
