/** @file Legal Consent Fields: Explicit, independently recorded legal choices with adjacent document links. */

import { Pressable, StyleSheet, View } from 'react-native';
import { Link, type Href } from 'expo-router';
import { CALIBRATE_PRODUCT_LINKS } from '@calibrate/shared/product';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '../AppText';
import { useFocusVisible } from '../useFocusVisible';
import { type AppTheme, useAppTheme } from '../../theme';

type ConsentCheckboxProps = {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
    testID?: string;
};

function ConsentCheckbox({ label, checked, disabled = false, onChange, testID }: ConsentCheckboxProps) {
    const theme = useAppTheme();
    const styles = createStyles(theme);
    const { focusVisible, handleBlur, handleFocus } = useFocusVisible();
    return (
        <Pressable
            aria-checked={checked}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled }}
            accessibilityLabel={label}
            disabled={disabled}
            onBlur={handleBlur}
            onFocus={handleFocus}
            onPress={() => onChange(!checked)}
            testID={testID}
            style={({ pressed }) => [
                styles.choice,
                checked && styles.choiceSelected,
                pressed && !disabled && styles.choicePressed,
                focusVisible && styles.choiceFocused,
                disabled && styles.choiceDisabled
            ]}
        >
            <View style={[styles.checkbox, checked && styles.checkboxSelected]}>
                {checked && <Ionicons name="checkmark" size={18} color={theme.colors.onSelection} />}
            </View>
            <AppText style={styles.choiceLabel}>{label}</AppText>
        </Pressable>
    );
}

type LegalConsentFieldsProps = {
    termsAccepted: boolean;
    privacyAccepted: boolean;
    onTermsAcceptedChange: (checked: boolean) => void;
    onPrivacyAcceptedChange: (checked: boolean) => void;
    disabled?: boolean;
    error?: string | null;
};

/** Explicit, independently recorded legal choices with adjacent document links. */
export function LegalConsentFields({
    termsAccepted,
    privacyAccepted,
    onTermsAcceptedChange,
    onPrivacyAcceptedChange,
    disabled = false,
    error
}: LegalConsentFieldsProps) {
    const theme = useAppTheme();
    const styles = createStyles(theme);
    return (
        <View style={styles.root} accessibilityLabel="Legal agreements">
            <ConsentCheckbox
                label="I agree to the current Terms of service"
                checked={termsAccepted}
                disabled={disabled}
                onChange={onTermsAcceptedChange}
                testID="accept-terms"
            />
            <ConsentCheckbox
                label="I accept the current Privacy policy"
                checked={privacyAccepted}
                disabled={disabled}
                onChange={onPrivacyAcceptedChange}
                testID="accept-privacy"
            />
            <View style={styles.links}>
                <Link href={CALIBRATE_PRODUCT_LINKS.terms as Href} style={[styles.link, { color: theme.colors.primary }]}>Read Terms</Link>
                <Link href={CALIBRATE_PRODUCT_LINKS.privacy as Href} style={[styles.link, { color: theme.colors.primary }]}>Read Privacy policy</Link>
            </View>
            {error && (
                <AppText accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: theme.colors.danger }}>
                    {error}
                </AppText>
            )}
        </View>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: {
            gap: theme.spacing.sm
        },
        choice: {
            minHeight: theme.interaction.minimumTouchTarget,
            alignItems: 'center',
            flexDirection: 'row',
            gap: theme.spacing.md,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceContainerLow,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm
        },
        choiceSelected: {
            borderColor: theme.colors.selection,
            backgroundColor: theme.colors.selectionContainer
        },
        choicePressed: {
            opacity: theme.interaction.pressedOpacity
        },
        choiceFocused: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        choiceDisabled: {
            opacity: theme.interaction.disabledOpacity
        },
        checkbox: {
            width: 24,
            height: 24,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            borderColor: theme.colors.outline,
            borderWidth: 2,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.surface
        },
        checkboxSelected: {
            borderColor: theme.colors.selection,
            backgroundColor: theme.colors.selection
        },
        choiceLabel: {
            flex: 1,
            minWidth: 0,
            fontWeight: '600'
        },
        links: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.md
        },
        link: {
            minHeight: theme.interaction.minimumTouchTarget,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            fontWeight: '600'
        }
    });
}
