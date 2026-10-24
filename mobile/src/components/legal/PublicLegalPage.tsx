/** @file Public Legal Page: Use public trust navigation when signed out and the app-bar contract when signed in. */

import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Link, router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthContext';
import { AppIconButton } from '../AppIconButton';
import { AppText } from '../AppText';
import { CalibrateLogo } from '../CalibrateLogo';
import { Screen } from '../Screen';
import type { PublicLegalSection } from '../../legal/publicLegalContent';
import {
    NAVIGATION_RAIL_BREAKPOINT,
    resolveSafeHorizontalPadding
} from '../../layout/adaptiveLayout';
import { radius, spacing, useAppTheme } from '../../theme';

const DESKTOP_HEADER_MAX_WIDTH = 1040; // Aligns legal-page app-bar content with the authenticated shell.

type PublicLegalLink = {
    href: string;
    label: string;
};

type PublicLegalPageProps = {
    title: string;
    lastUpdated?: string;
    intro: string[];
    sections: PublicLegalSection[];
    links: PublicLegalLink[];
    actions?: React.ReactNode;
};

/** Use public trust navigation when signed out and the app-bar contract when signed in. */
export function PublicLegalPage({ title, lastUpdated, intro, sections, links, actions }: PublicLegalPageProps) {
    const { user } = useAuth();
    const { colors } = useAppTheme();
    const insets = useSafeAreaInsets();
    const { width } = useWindowDimensions();
    const inApp = Boolean(user);
    const desktop = width >= NAVIGATION_RAIL_BREAKPOINT;
    const headerHorizontalPadding = resolveSafeHorizontalPadding(
        desktop ? spacing.xl : spacing.lg,
        insets.left,
        insets.right,
        spacing.sm
    );

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            {inApp ? (
                <View
                    role="banner"
                    testID="legal-app-header"
                    style={[
                        styles.appHeader,
                        { borderBottomColor: colors.border, backgroundColor: colors.surface, paddingTop: insets.top }
                    ]}
                >
                    <View
                        style={[styles.appHeaderRow, desktop && styles.appHeaderRowDesktop, headerHorizontalPadding]}>
                        <View style={styles.appHeaderLeading}>
                            <AppIconButton
                                accessibilityLabel="Back to Settings"
                                icon="chevron-back"
                                iconSize={24}
                                variant="ghost"
                                onPress={() => router.replace('/settings')}
                            />
                            <AppText
                                accessibilityRole="header"
                                aria-level={1}
                                nativeID="route-focus-title"
                                numberOfLines={2}
                                style={styles.appHeaderTitle}
                            >
                                {title}
                            </AppText>
                        </View>
                        <View accessibilityRole="toolbar" accessibilityLabel="App actions" style={styles.appHeaderActions}>
                            <AppIconButton
                                accessibilityLabel="Account & settings"
                                accessibilityHint="Opens account details and app settings"
                                icon="person-circle-outline"
                                iconSize={29}
                                variant="ghost"
                                onPress={() => router.push('/settings')}
                            />
                        </View>
                    </View>
                </View>
            ) : null}

            <Screen
                contentWidth="overview"
                testID={inApp ? 'legal-in-app-shell' : 'legal-public-shell'}
                safeTop={!inApp}
                style={styles.screen}
            >
                {!inApp ? (
                    <View style={[styles.brandBar, { borderBottomColor: colors.outlineVariant }]}>
                        <View style={styles.brandIdentity}>
                            <CalibrateLogo size={36} />
                            <AppText variant="label" style={{ color: colors.primary }}>Calibrate Health</AppText>
                        </View>
                        <Link
                            href={'/' as Href}
                            style={StyleSheet.flatten([styles.homeLink, { color: colors.primary }])}
                        >
                            Calibrate home
                        </Link>
                    </View>
                ) : null}

                <View testID="legal-page" style={styles.content}>
                    <View style={styles.section}>
                        {!inApp ? (
                            <AppText
                                nativeID="route-focus-title"
                                accessibilityRole="header"
                                aria-level={1}
                                variant="title"
                            >
                                {title}
                            </AppText>
                        ) : null}
                        {lastUpdated && <AppText variant="label">Last updated: {lastUpdated}</AppText>}
                        {intro.map((paragraph) => (
                            <AppText key={paragraph}>{paragraph}</AppText>
                        ))}
                    </View>

                    {actions}

                    {sections.map((section) => (
                        <View
                            key={section.title}
                            style={[styles.section, styles.dividedSection, { borderTopColor: colors.outlineVariant }]}
                        >
                            <AppText accessibilityRole="header" aria-level={2} variant="subtitle">{section.title}</AppText>
                            {section.paragraphs?.map((paragraph) => (
                                <AppText key={paragraph}>{paragraph}</AppText>
                            ))}
                            {section.bullets?.map((bullet) => (
                                <View key={bullet} style={styles.bulletRow}>
                                    <AppText accessibilityElementsHidden importantForAccessibility="no">-</AppText>
                                    <AppText style={styles.bulletCopy}>{bullet}</AppText>
                                </View>
                            ))}
                        </View>
                    ))}

                    <View style={[styles.links, styles.dividedSection, { borderTopColor: colors.outlineVariant }]}>
                        {links.map((link) => (
                            <Link
                                key={link.href}
                                href={link.href as Href}
                                style={StyleSheet.flatten([
                                    styles.link,
                                    { borderColor: colors.outline, color: colors.primary }
                                ])}
                            >
                                {link.label}
                            </Link>
                        ))}
                    </View>
                </View>
            </Screen>
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        width: '100%'
    },
    screen: {
        width: '100%',
        alignSelf: 'center'
    },
    appHeader: {
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    appHeaderRow: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg
    },
    appHeaderRowDesktop: {
        width: '100%',
        maxWidth: DESKTOP_HEADER_MAX_WIDTH,
        alignSelf: 'center',
        paddingHorizontal: spacing.xl
    },
    appHeaderLeading: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    appHeaderTitle: {
        flexShrink: 1,
        fontSize: 20,
        lineHeight: 26,
        fontWeight: '600'
    },
    appHeaderActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs
    },
    brandBar: {
        minHeight: 56,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingBottom: spacing.md,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    brandIdentity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm
    },
    homeLink: {
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        fontWeight: '600'
    },
    content: {
        gap: spacing.lg
    },
    section: {
        gap: spacing.sm
    },
    dividedSection: {
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.lg
    },
    bulletRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
        paddingLeft: spacing.sm
    },
    bulletCopy: {
        flex: 1
    },
    links: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    link: {
        minHeight: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        textAlign: 'center',
        fontWeight: '600'
    }
});
