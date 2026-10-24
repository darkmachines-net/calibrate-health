/** @file Trust Page Shell: Compact public/account-trust shell shared by recovery and consent flows. */

import { StyleSheet, View } from 'react-native';
import { AppSection } from '../AppSection';
import { AppText } from '../AppText';
import { CalibrateLogo } from '../CalibrateLogo';
import { Screen } from '../Screen';
import { spacing, useAppTheme } from '../../theme';

type TrustPageShellProps = {
    title: string;
    description: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
};

/** Compact public/account-trust shell shared by recovery and consent flows. */
export function TrustPageShell({ title, description, children, footer }: TrustPageShellProps) {
    const { colors } = useAppTheme();
    return (
        <Screen contentWidth="form" safeTop style={styles.screen}>
            <View style={styles.brandRow}>
                <CalibrateLogo size={42} />
                <AppText variant="label" style={{ color: colors.primary }}>Calibrate Health</AppText>
            </View>
            <View style={styles.heading}>
                <AppText nativeID="route-focus-title" accessibilityRole="header" aria-level={1} variant="title" style={styles.headingText}>
                    {title}
                </AppText>
                <AppText variant="muted" style={styles.headingText}>{description}</AppText>
            </View>
            <AppSection style={styles.card}>{children}</AppSection>
            {footer}
        </Screen>
    );
}

export const trustPageStyles = StyleSheet.create({
    actions: {
        gap: spacing.sm
    },
    links: {
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: spacing.md
    },
    linkTarget: {
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm
    }
});

const styles = StyleSheet.create({
    screen: {
        justifyContent: 'center',
        flexGrow: 1,
        width: '100%',
        alignSelf: 'center'
    },
    brandRow: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: spacing.sm
    },
    heading: {
        alignItems: 'center',
        gap: spacing.xs
    },
    headingText: {
        textAlign: 'center'
    },
    card: {
        gap: spacing.lg
    }
});
