/** @file health connect privacy: Explains Health Connect data use and links to the selected server's complete privacy policy. */

import { Alert, Linking, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AppButton } from '../src/components/AppButton';
import { AppSection } from '../src/components/AppSection';
import { AppText } from '../src/components/AppText';
import { SectionHeader } from '../src/components/SectionHeader';
import { PageHeader } from '../src/components/PageHeader';
import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/auth/AuthContext';
import { spacing, useAppTheme } from '../src/theme';

/** Explains Health Connect data use and links to the selected server's complete privacy policy. */
export default function HealthConnectPrivacyScreen() {
    const { serverUrl } = useAuth();
    const { colors } = useAppTheme();
    const dividedSection = [styles.section, styles.dividedSection, { borderTopColor: colors.outlineVariant }];
    const privacyPolicyUrl = `${serverUrl.replace(/\/+$/, '')}/privacy`;

    async function openCompletePrivacyPolicy() {
        try {
            await Linking.openURL(privacyPolicyUrl);
        } catch {
            Alert.alert('Unable to open privacy policy', `Open ${privacyPolicyUrl} in your browser.`);
        }
    }

    return (
        <Screen contentWidth="overview" safeTop>
            <PageHeader
                eyebrow="Health Connect"
                title="How Calibrate uses health data"
                description="Clear, read-only access that stays under your control."
                onBack={() => router.back()}
            />
            <View style={styles.content}>
                <AppSection style={styles.section}>
                    <SectionHeader title="What Calibrate requests" />
                    <AppText>
                        Calibrate can read steps, active calories, total calories, and exercise sessions. Weight is separate and off by default until you explicitly enable it.
                    </AppText>
                </AppSection>
                <AppSection style={dividedSection}>
                    <SectionHeader title="What Calibrate does not do" />
                    <AppText>
                        Calibrate does not write, edit, or delete records in Health Connect. Health activity does not automatically change your calorie target or add calories back to your food budget.
                    </AppText>
                </AppSection>
                <AppSection style={dividedSection}>
                    <SectionHeader title="Connection preview" />
                    <AppText>
                        While connected and unpaused, Calibrate reads selected Health Connect data when the app opens or returns to the foreground and syncs it to your chosen Calibrate server. Remote servers should use HTTPS; a private-network HTTP server may send data without transport encryption. Each source record keeps its originating app so retries and overlapping providers do not silently inflate totals.
                    </AppText>
                </AppSection>
                <AppSection style={dividedSection}>
                    <SectionHeader title="Your controls" />
                    <AppText>
                        You can pause Calibrate, disable individual data types, manage Android permissions, or disconnect at any time. These controls stop future imports. Records already sent to your chosen Calibrate server remain available in activity history and account exports until you delete your account or the server operator removes them. Android retains permissions for individually disabled data types until you remove them in Health Connect or disconnect.
                    </AppText>
                    <AppText variant="muted">
                        Samsung Health may take time to publish Galaxy Watch activity to Health Connect. Calibrate cannot speed up that handoff.
                    </AppText>
                    <AppButton
                        title="Open complete privacy policy"
                        variant="secondary"
                        accessibilityHint="Opens the complete privacy policy hosted by your selected Calibrate server."
                        onPress={() => void openCompletePrivacyPolicy()}
                    />
                </AppSection>
            </View>
        </Screen>
    );
}

const styles = StyleSheet.create({
    content: {
        width: '100%',
        gap: spacing.lg
    },
    section: {
        gap: spacing.sm
    },
    dividedSection: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.lg
    }
});
