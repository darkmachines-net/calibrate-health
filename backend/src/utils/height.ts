/** @file height: Resolve a height update into a millimeter value for storage. */

export type HeightResolution = {
  provided: boolean;
  value: number | null;
  valid: boolean;
};

/**
 * Resolve a height update into a millimeter value for storage.
 *
 * Inputs come from API PATCH payloads, where:
 * - "provided" means the caller attempted to set height (including clearing it with null/"")
 * - "value" is the normalized millimeter value to store (or null to clear)
 * - "valid" indicates whether the provided inputs are coherent (positive numeric height)
 */
export function resolveHeightMmUpdate(opts: {
  height_mm?: unknown;
  height_cm?: unknown;
  height_feet?: unknown;
  height_inches?: unknown;
}): HeightResolution {
  const { height_mm, height_cm, height_feet, height_inches } = opts;

  if (height_mm !== undefined) {
    if (height_mm === null || height_mm === '') return { provided: true, value: null, valid: true };
    const parsed = Number(height_mm);
    if (!Number.isFinite(parsed) || parsed <= 0) return { provided: true, value: null, valid: false };
    return { provided: true, value: Math.round(parsed), valid: true };
  }

  if (height_cm !== undefined) {
    if (height_cm === null || height_cm === '') return { provided: true, value: null, valid: true };
    const parsed = Number(height_cm);
    if (!Number.isFinite(parsed) || parsed <= 0) return { provided: true, value: null, valid: false };
    return { provided: true, value: Math.round(parsed * 10), valid: true };
  }

  if (height_feet !== undefined || height_inches !== undefined) {
    const feetNum = height_feet === undefined || height_feet === '' ? 0 : Number(height_feet);
    const inchesNum = height_inches === undefined || height_inches === '' ? 0 : Number(height_inches);
    if (!Number.isFinite(feetNum) || !Number.isFinite(inchesNum)) return { provided: true, value: null, valid: false };
    const totalInches = feetNum * 12 + inchesNum;
    if (totalInches <= 0) return { provided: true, value: null, valid: false };
    const mm = totalInches * 25.4;
    return { provided: true, value: Math.round(mm), valid: true };
  }

  return { provided: false, value: null, valid: true };
}

