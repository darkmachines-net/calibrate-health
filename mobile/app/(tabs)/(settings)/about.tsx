/** @file About screen with product information and canonical support, privacy, and software-license links. */

/**
 * Defines the about Expo Router screen.
 */
import { useState } from 'react';
/**
 * Defines the about Expo Router screen.
 */
import { Pressable, StyleSheet, View } from 'react-native';
/**
 * Defines the about Expo Router screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
/**
 * Defines the about Expo Router screen.
 */
import { Link, type Href } from 'expo-router';
/**
 * Defines the about Expo Router screen.
 */
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
/**
 * Defines the about Expo Router screen.
 */
import { AppSection } from '../../../src/components/AppSection';
/**
 * Defines the about Expo Router screen.
 */
import { AppText } from '../../../src/components/AppText';
/**
 * Defines the about Expo Router screen.
 */
import { CalibrateLogo } from '../../../src/components/CalibrateLogo';
/**
 * Defines the about Expo Router screen.
 */
import { TabScreen } from '../../../src/components/TabScreen';
/**
 * Defines the about Expo Router screen.
 */
import { useFocusVisible } from '../../../src/components/useFocusVisible';
/**
 * Defines the about Expo Router screen.
 */
import { interaction, radius, spacing, useAppTheme } from '../../../src/theme';

const PRODUCT_LINKS = [
    { label: 'Calibrate website', href: CALIBRATE_PRODUCT_LINKS.product },
    { label: 'Privacy policy', href: CALIBRATE_PRODUCT_LINKS.privacy },
    { label: 'Terms of service', href: CALIBRATE_PRODUCT_LINKS.terms },
    { label: 'Support', href: CALIBRATE_PRODUCT_LINKS.support },
    { label: 'Feedback', href: CALIBRATE_PRODUCT_LINKS.feedback },
    { label: 'Software license', href: CALIBRATE_PRODUCT_LINKS.licenses },
    { label: 'Release notes', href: CALIBRATE_PRODUCT_LINKS.releases }
] as const;

const PRODUCT_LINK_MIN_WIDTH = 200; // Keeps every wrapped destination readable as a distinct control.

function ProductLinkRow({ link }: { link: (typeof PRODUCT_LINKS)[number] }) {
    const theme = useAppTheme();
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const [pressed, setPressed] = useState(false);
    const [hovered, setHovered] = useState(false);
    return <Link href={link.href as Href} asChild>
        <Pressable
            accessibilityRole="link"
            accessibilityLabel={link.label}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            style={StyleSheet.flatten([
                styles.productLink,
                {
                    borderBottomColor: theme.colors.outlineVariant
                },
                hovered && { backgroundColor: theme.colors.surfaceHovered },
                pressed && { backgroundColor: theme.colors.surfacePressed },
                focusVisible && {
                    outlineWidth: theme.interaction.focusRingWidth,
                    outlineStyle: 'solid',
                    outlineColor: theme.colors.focusRing
                }
            ])}
        >
            <AppText style={[styles.productLinkText, { color: theme.colors.primary }]}>{link.label}</AppText>
            <Ionicons name="open-outline" size={18} color={theme.colors.primary} />
        </Pressable>
    </Link>;
}

/** Render the about screen interface. */
export default function AboutScreen() {
    const theme = useAppTheme();
    return (
        <TabScreen contentWidth="overview">
            <AppSection style={styles.brandCard}>
                <View style={[styles.logoSurface, { backgroundColor: theme.colors.primaryContainer }]}>
                    <CalibrateLogo size={52} />
                </View>
                <View style={styles.brandCopy}>
                    <AppText variant="title">About Calibrate</AppText>
                    <AppText variant="caption">Food, weight, and goal tracking built around clear daily progress.</AppText>
                </View>
            </AppSection>

            <AppSection style={[styles.dividedSection, { borderTopColor: theme.colors.outlineVariant }]}>
                <AppText accessibilityRole="header" aria-level={2} variant="subtitle">Understand your progress</AppText>
                <AppText>
                    Calibrate helps you log food and weight, compare calories with a personalized target, and follow
                    your trend over time.
                </AppText>
                <AppText variant="caption">
                    Available in English on the web as an installable PWA and on Android and iOS, with a Wear OS
                    companion for Android.
                </AppText>
            </AppSection>

            <AppSection style={[styles.dividedSection, { borderTopColor: theme.colors.outlineVariant }]}>
                <AppText accessibilityRole="header" aria-level={2} variant="subtitle">Your data, your choices</AppText>
                <AppText>
                    The service you sign in to stores the account data Calibrate needs to work. You can export a
                    portable copy or permanently delete your account from Settings.
                </AppText>
                <View style={styles.productLinks}>
                    {PRODUCT_LINKS.map((link) => <ProductLinkRow key={link.label} link={link} />)}
                </View>
            </AppSection>

        </TabScreen>
    );
}

const styles = StyleSheet.create({
    dividedSection: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.lg
    },
    brandCard: {
        flexDirection: 'row',
        alignItems: 'center'
    },
    logoSurface: {
        width: 72,
        height: 72,
        borderRadius: radius.lg,
        alignItems: 'center',
        justifyContent: 'center'
    },
    brandCopy: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    productLinks: {
        gap: spacing.sm
    },
    productLink: {
        width: '100%',
        minWidth: PRODUCT_LINK_MIN_WIDTH,
        minHeight: interaction.minimumTouchTarget,
        flexGrow: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 0,
        paddingVertical: spacing.sm
    },
    productLinkText: {
        flex: 1,
        minWidth: 0,
        fontWeight: '600'
    }
});
