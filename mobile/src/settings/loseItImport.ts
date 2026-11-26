/** @file Coordinates Lose It export preview and non-destructive execution with inferred export units. */

import {
    type LoseItImportFile,
    type LoseItImportOptions,
    type LoseItImportPreview,
    type LoseItImportSummary
} from '@calibrate/api-client';
import { WEIGHT_UNITS, type WeightUnit } from '@calibrate/shared';

type LoseItImportApi = {
    previewLoseItImport: (file: LoseItImportFile) => Promise<LoseItImportPreview>;
    executeLoseItImport: (file: LoseItImportFile, options: LoseItImportOptions) => Promise<LoseItImportSummary>;
};

/**
 * Preview a Lose It export to infer its weight unit, then execute the import with non-destructive
 * conflict defaults (`MERGE` food logs, `KEEP` existing weigh-ins, and body-fat import enabled).
 */
export async function importLoseItArchive(
    api: LoseItImportApi,
    file: LoseItImportFile,
    fallbackWeightUnit: WeightUnit = WEIGHT_UNITS.KG
): Promise<LoseItImportSummary> {
    const preview = await api.previewLoseItImport(file);
    const weightUnit = preview.weightUnitGuess === WEIGHT_UNITS.LB || preview.weightUnitGuess === WEIGHT_UNITS.KG
        ? preview.weightUnitGuess
        : fallbackWeightUnit;
    return api.executeLoseItImport(file, {
        weight_unit: weightUnit,
        food_conflict_mode: 'MERGE',
        weight_conflict_mode: 'KEEP',
        include_body_fat: true
    });
}
