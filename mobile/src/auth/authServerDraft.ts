/** @file auth Server Draft: Normalize Expo Router's scalar-or-array query value into one usable server draft. */

/** Normalize Expo Router's scalar-or-array query value into one usable server draft. */
export function readAuthServerDraft(value: string | string[] | undefined): string | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate?.trim() ? candidate : null;
}
