import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type NutritionLabelDraft } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { useServerSettings } from '../serverSettings/useServerSettings';
import { AppButton } from '../components/AppButton';
import { AppSection } from '../components/AppSection';
import { AppNotice } from '../components/AppNotice';
import { AppText } from '../components/AppText';
import { useOnlineStatus } from '../components/AsyncStateBoundary';
import { confirmDiscardChanges } from '../components/confirmDiscardChanges';
import { LoadingState } from '../components/LoadingState';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { TextField } from '../components/TextField';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { SAVED_FOODS_LIBRARY_QUERY_KEY } from '../savedFoods/queryKeys';
import { spacing, useAppTheme } from '../theme';
import { labelFoodPayload, validateLabelFood, type LabelFoodFields } from './draft';
import { chooseLabelImage, LabelImageError, releaseLabelImage, type LabelImage, type LabelImageSource } from './imagePicker';

const EMPTY_FIELDS: LabelFoodFields = { title: '', quantity: '', unit: '', calories: '' };
// Bound the photo preview so the review fields remain reachable on narrow screens.
const LABEL_PREVIEW_HEIGHT = 260;

function scanErrorMessage(error: unknown): string {
    if (error instanceof LabelImageError) return error.message;
    if (error instanceof ApiError) {
        if (error.status === 403) return 'Nutrition label scanning is disabled or unavailable for this account.';
        if (error.status === 413) return 'Choose a photo smaller than 8 MB.';
        if (error.status === 400) return 'Choose a clear JPEG, PNG, or WebP photo under 25 megapixels.';
        if (error.status === 503) return 'The label scanner is busy. Try again shortly.';
        if (error.status === 504) return 'Reading this label took too long. Try a clearer, tightly cropped photo.';
    }
    return getSafeActionErrorMessage(error, 'The label could not be read. Try another photo or enter the details below.');
}

export default function NutritionLabelScreen() {
    const { nutritionLabelScanning } = useServerSettings();
    const theme = useAppTheme();
    const { api, user, isLoading } = useAuth();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const params = useLocalSearchParams<{ from?: string }>();
    const [fields, setFields] = useState<LabelFoodFields>(EMPTY_FIELDS);
    const [draft, setDraft] = useState<NutritionLabelDraft | null>(null);
    const [photo, setPhoto] = useState<LabelImage | null>(null);
    const [scanning, setScanning] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedTitle, setSavedTitle] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const photoRef = useRef<LabelImage | null>(null);
    const requestRef = useRef<AbortController | null>(null);
    const busyRef = useRef(false);
    const scanSequence = useRef(0);
    const mounted = useRef(true);
    const busy = scanning || saving;
    const hasDetails = Boolean(fields.quantity || fields.unit || fields.calories);
    const validationError = validateLabelFood(fields);

    useEffect(() => {
        if (!nutritionLabelScanning) cancelScan();
    }, [nutritionLabelScanning]);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            requestRef.current?.abort();
            if (photoRef.current) releaseLabelImage(photoRef.current);
        };
    }, []);

    function updateField(key: keyof LabelFoodFields, value: string) {
        setFields((current) => ({ ...current, [key]: value }));
        setError(null);
    }

    async function scan(source: LabelImageSource) {
        if (busyRef.current || !isOnline || !nutritionLabelScanning) return;
        busyRef.current = true;
        const scanId = ++scanSequence.current;
        try {
            if (hasDetails && !await confirmDiscardChanges()) return;
            if (!mounted.current || scanId !== scanSequence.current) return;
            // Call the browser picker before an await unless an existing draft needs confirmation.
            const pendingImage = chooseLabelImage(source);
            setScanning(true);
            setError(null);
            const selected = await pendingImage;
            if (!selected) return;
            if (!mounted.current || scanId !== scanSequence.current) {
                releaseLabelImage(selected);
                return;
            }
            if (photoRef.current) releaseLabelImage(photoRef.current);
            photoRef.current = selected;
            setPhoto(selected);
            setDraft(null);
            setFields((current) => ({ ...EMPTY_FIELDS, title: current.title }));
            const controller = new AbortController();
            requestRef.current = controller;
            const result = await api.scanNutritionLabel(selected.upload, controller.signal);
            if (!mounted.current || controller.signal.aborted || scanId !== scanSequence.current) return;
            setDraft(result);
            setFields((current) => ({
                title: current.title,
                quantity: result.serving_size_quantity === null ? '' : String(result.serving_size_quantity),
                unit: result.serving_unit_label ?? '',
                calories: result.calories_per_serving === null ? '' : String(result.calories_per_serving)
            }));
        } catch (failure) {
            if (mounted.current && scanId === scanSequence.current && !requestRef.current?.signal.aborted) setError(scanErrorMessage(failure));
        } finally {
            if (scanId === scanSequence.current) {
                requestRef.current = null;
                busyRef.current = false;
                if (mounted.current) setScanning(false);
            }
        }
    }

    function cancelScan() {
        scanSequence.current += 1;
        requestRef.current?.abort();
        requestRef.current = null;
        busyRef.current = false;
        setScanning(false);
    }

    async function save() {
        if (busyRef.current || !isOnline) return;
        if (validationError) { setError(validationError); return; }
        busyRef.current = true;
        setSaving(true);
        setError(null);
        try {
            const saved = await api.createMyFood(labelFoodPayload(fields));
            if (!mounted.current) return;
            setSavedTitle(saved.name);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['mobile-my-foods'] }),
                queryClient.invalidateQueries({ queryKey: SAVED_FOODS_LIBRARY_QUERY_KEY })
            ]);
        } catch (failure) {
            if (mounted.current) setError(getSafeActionErrorMessage(failure, 'Food could not be saved. Your details are still here. Try again.'));
        } finally {
            if (mounted.current) setSaving(false);
            busyRef.current = false;
        }
    }

    async function leave() {
        if (busyRef.current) return;
        if (!savedTitle && (hasDetails || fields.title) && !await confirmDiscardChanges()) return;
        if (router.canGoBack()) router.back();
        else router.replace('/my-foods');
    }

    if (isLoading) return <LoadingState label="Restoring session..." />;
    if (!user) return <Redirect href="/login" />;

    if (savedTitle) {
        return (
            <Screen contentWidth="form" safeTop>
                <AppSection>
                    <SectionHeader headingLevel={1} title="Food saved" description={`"${savedTitle}" is ready to use from Saved foods or food search.`} />
                    <AppButton title="View saved foods" onPress={() => router.replace('/my-foods')} />
                    {params.from === 'barcode' && <AppButton title="Back to barcode" variant="secondary" onPress={() => void leave()} />}
                </AppSection>
            </Screen>
        );
    }

    return (
        <Screen contentWidth="form" safeTop>
            <AppSection>
                <SectionHeader
                    headingLevel={1}
                    title="Scan nutrition label"
                    description="Photograph the Nutrition Facts panel, including serving size and calories. Review the details and give your food a title before saving."
                />
                <AppText variant="muted">Use a clear, upright photo of one English label. Keep the whole panel in focus and avoid glare.</AppText>
                <AppText variant="caption">Your Calibrate server reads the photo without storing it.</AppText>
                {!isOnline && (
                    <AppNotice tone="warning" accessibilityRole="alert">
                        <AppText>Connect to the internet to scan or save. You can still edit the details.</AppText>
                    </AppNotice>
                )}
                {!nutritionLabelScanning && <AppNotice tone="warning"><AppText>Nutrition label scanning is unavailable on this server. You can enter food details manually below.</AppText></AppNotice>}
                {nutritionLabelScanning && <View style={styles.actions}>
                    <AppButton title="Take photo" variant="secondary" disabled={busy || !isOnline} onPress={() => void scan('camera')} />
                    <AppButton title="Choose photo" variant="secondary" disabled={busy || !isOnline} onPress={() => void scan('library')} />
                </View>}
                {draft && !scanning && <AppText accessibilityLiveRegion="polite">Label read. Review the details below before saving.</AppText>}
                {photo && <Image accessibilityLabel="Nutrition label photo" source={{ uri: photo.uri }} style={styles.photo} resizeMode="contain" />}
                {scanning && (
                    <View>
                        <AppText accessibilityLiveRegion="polite">Reading label...</AppText>
                        {photo && <AppButton title="Cancel scan" variant="ghost" onPress={cancelScan} />}
                    </View>
                )}
                {error && (
                    <AppNotice tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
                        <AppText>{error}</AppText>
                    </AppNotice>
                )}
            </AppSection>
            <AppSection style={[styles.reviewSection, { borderTopColor: theme.colors.outlineVariant }]}>
                <SectionHeader title="Review saved food" description="Check the calories and serving size against the label. You can correct or enter any value below." />
                {draft?.serving_text && <AppText>Serving size on label: {draft.serving_text}</AppText>}
                {Boolean(draft?.warnings.length) && (
                    <AppNotice tone="warning" accessibilityRole="alert">
                        {draft?.warnings.map((warning) => <AppText key={warning}>{warning}</AppText>)}
                    </AppNotice>
                )}
                <TextField label="Food title" required maxLength={120} value={fields.title} editable={!busy} onChangeText={(value) => updateField('title', value)} placeholder="e.g. Crunchy peanut butter" />
                <TextField label="Serving quantity" required value={fields.quantity} editable={!busy} keyboardType="decimal-pad" inputMode="decimal" onChangeText={(value) => updateField('quantity', value)} helperText="Use a decimal for fractions, e.g. 0.5 for 1/2." />
                <TextField label="Serving unit" required maxLength={48} value={fields.unit} editable={!busy} onChangeText={(value) => updateField('unit', value)} placeholder="e.g. tbsp (32 g), cup, or g" />
                <TextField label="Calories per serving" required value={fields.calories} editable={!busy} keyboardType="decimal-pad" inputMode="decimal" onChangeText={(value) => updateField('calories', value)} helperText="Calories for the serving quantity and unit above." />
                <AppButton title="Save food" busy={saving} busyLabel="Saving food..." disabled={busy || !isOnline || Boolean(validationError)} onPress={() => void save()} />
                <AppButton title="Cancel" variant="ghost" disabled={busy} onPress={() => void leave()} />
            </AppSection>
        </Screen>
    );
}

const styles = StyleSheet.create({
    reviewSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.lg },
    photo: { width: '100%', height: LABEL_PREVIEW_HEIGHT },
    actions: { gap: spacing.sm }
});
