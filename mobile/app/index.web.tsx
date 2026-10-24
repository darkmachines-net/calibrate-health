/** @file index: Public browser entry point; native keeps its direct authentication redirect. */

import { StyleSheet, View } from 'react-native';
import { Link, Redirect, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import { AppSection } from '../src/components/AppSection';
import { AppText } from '../src/components/AppText';
import { AuthBrand } from '../src/components/auth/AuthBrand';
import { LoadingState } from '../src/components/LoadingState';
import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/auth/AuthContext';
import { radius, spacing, typography, useAppTheme } from '../src/theme';

/** Public browser entry point; native keeps its direct authentication redirect. */
export default function WebHomeRoute() {
    const { colors } = useAppTheme();
    const { user, isLoading } = useAuth();

    if (isLoading) {
        return <LoadingState label="Opening Calibrate..." />;
    }

    if (user) {
        return <Redirect href="/today" />;
    }

    return (
        <Screen contentWidth="form" testID="hosted-landing" safeTop style={styles.screen}>
            <AuthBrand description="Track food, weight, and progress against a personalized calorie target - without losing sight of the daily choices." />
            <AppSection testID="hosted-landing-primary">
                <AppText variant="subtitle">A clearer view of what is working.</AppText>
                <AppText variant="muted">
                    Log meals and weigh-ins, compare them with your personal calorie target, and follow progress over time.
                </AppText>
                <AppText testID="hosted-install-copy" variant="muted">
                    Use Calibrate in your browser or install it from a supported browser for an app-like experience.
                </AppText>
                <View testID="hosted-landing-actions" style={styles.actions}>
                    <Link
                        href="/(auth)/login"
                        style={StyleSheet.flatten([
                            styles.primaryLink,
                            { backgroundColor: colors.primary, color: colors.onPrimary }
                        ])}
                    >
                        Sign in
                    </Link>
                    <Link
                        href="/(auth)/register"
                        style={StyleSheet.flatten([
                            styles.secondaryLink,
                            { borderColor: colors.outline, color: colors.primary }
                        ])}
                    >
                        Create account
                    </Link>
                </View>
            </AppSection>
            <AppSection testID="hosted-landing-trust" style={{
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.outlineVariant,
                paddingTop: spacing.lg
            }}>
                <AppText variant="subtitle">Your account stays under your control.</AppText>
                <AppText variant="muted">
                    Review signed-in devices, export your account data, or permanently delete your account from Settings.
                </AppText>
                <View testID="hosted-trust-links" style={styles.legalLinks}>
                    <Link
                        href={CALIBRATE_PRODUCT_LINKS.privacy as Href}
                        style={StyleSheet.flatten([styles.textLink, { color: colors.primary }])}
                    >
                        Privacy policy
                    </Link>
                    <Link
                        href={CALIBRATE_PRODUCT_LINKS.terms as Href}
                        style={StyleSheet.flatten([styles.textLink, { color: colors.primary }])}
                    >
                        Terms of service
                    </Link>
                    <Link
                        href={CALIBRATE_PRODUCT_LINKS.support as Href}
                        style={StyleSheet.flatten([styles.textLink, { color: colors.primary }])}
                    >
                        Support
                    </Link>
                    <Link
                        href="/account-deletion"
                        style={StyleSheet.flatten([styles.textLink, { color: colors.primary }])}
                    >
                        Account deletion
                    </Link>
                </View>
            </AppSection>
        </Screen>
    );
}

const styles = StyleSheet.create({
    screen: {
        justifyContent: 'center',
        flexGrow: 1,
        width: '100%',
        alignSelf: 'center'
    },
    actions: {
        gap: spacing.sm
    },
    primaryLink: {
        ...typography.styles.body,
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        fontWeight: '600'
    },
    secondaryLink: {
        ...typography.styles.body,
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        fontWeight: '600'
    },
    legalLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: spacing.md
    },
    textLink: {
        ...typography.styles.body,
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        fontWeight: '600'
    }
});
