/** @file expo Project: Resolve the stable Expo project identity required for reliable push-token registration. */

export const EXPO_PROJECT_ID_ENV = 'EXPO_PUBLIC_EAS_PROJECT_ID';

type ExpoProjectConstants = {
    easConfig?: { projectId?: string | null } | null;
    expoConfig?: {
        extra?: {
            eas?: { projectId?: string | null } | null;
        } | null;
    } | null;
};

/** Resolve the stable Expo project identity required for reliable push-token registration. */
export function resolveExpoProjectId(
    constants: ExpoProjectConstants,
    environmentProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID
): string | null {
    const candidates = [
        constants.easConfig?.projectId,
        constants.expoConfig?.extra?.eas?.projectId,
        environmentProjectId
    ];

    for (const candidate of candidates) {
        const projectId = candidate?.trim();
        if (projectId) return projectId;
    }

    return null;
}
