/** @file Barcode Result List: Renders selectable provider results while preserving their source and serving information. */

import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { SearchedFoodItem } from '../food/serving';
import { AppText } from '../components/AppText';
import { AppActionRow } from '../components/AppActionRow';
import { spacing, useAppTheme } from '../theme';

type BarcodeResultListProps = {
    candidates: SearchedFoodItem[];
    disabled?: boolean;
    onChoose: (candidate: SearchedFoodItem) => void;
};

/** Renders selectable provider results while preserving their source and serving information. */
export function BarcodeResultList({ candidates, disabled = false, onChoose }: BarcodeResultListProps) {
    const theme = useAppTheme();

    return (
        <View style={styles.results}>
            {candidates.map((candidate) => (
                <AppActionRow
                    key={`${candidate.source ?? 'food'}:${candidate.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Choose ${candidate.name}`}
                    disabled={disabled}
                    onPress={() => onChoose(candidate)}
                    contentStyle={[
                        styles.resultRow,
                        {
                            borderBottomColor: theme.colors.outlineVariant
                        }
                    ]}
                >
                    <View style={styles.resultText}>
                        <AppText variant="body" numberOfLines={2}>{candidate.name}</AppText>
                        <AppText variant="caption" numberOfLines={2}>
                            {candidate.brand
                                ?? `${candidate.measures.length} serving option${candidate.measures.length === 1 ? '' : 's'}`}
                        </AppText>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={theme.colors.onSurfaceVariant} />
                </AppActionRow>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    results: {
        gap: spacing.sm
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderRadius: 0,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingVertical: spacing.md
    },
    resultText: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    }
});
