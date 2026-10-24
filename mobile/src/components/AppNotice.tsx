/** @file App Notice: A single, visible boundary for information requiring attention or a decision. */

import { type ViewProps } from 'react-native';
import { AppSection } from './AppSection';
import { useAppTheme } from '../theme';

type AppNoticeProps = ViewProps & { tone?: 'info' | 'warning' | 'danger' | 'success' };

/** A single, visible boundary for information requiring attention or a decision. */
export function AppNotice({ tone = 'info', style, ...props }: AppNoticeProps) {
    const theme = useAppTheme();
    return <AppSection {...props} style={[
        {
            borderLeftWidth: theme.interaction.focusRingWidth,
            borderLeftColor: theme.colors[tone],
            backgroundColor: theme.colors[`${tone}Container`],
            padding: theme.spacing.md
        },
        style
    ]} />;
}
