/** @file Lazy native camera/library label capture with cancellation, permission, and upload asset normalization. */

import type { ImagePickerAsset } from 'expo-image-picker';

export type LabelImageSource = 'camera' | 'library';
export type LabelImage = {
    uri: string;
    upload: Blob | { uri: string; name: string; type: string };
};
export class LabelImageError extends Error {}
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function fromAsset(asset: ImagePickerAsset): LabelImage {
    if (asset.fileSize && asset.fileSize > MAX_IMAGE_BYTES) {
        throw new LabelImageError('Choose a photo smaller than 8 MB.');
    }
    const mimeType = asset.mimeType ?? 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        throw new LabelImageError('Choose a JPEG, PNG, or WebP photo.');
    }
    return {
        uri: asset.uri,
        upload: { uri: asset.uri, name: asset.fileName ?? 'nutrition-label.jpg', type: mimeType }
    };
}

/** Lazily opens native camera or library selection, returning null on cancellation and actionable permission errors. */
export async function chooseLabelImage(source: LabelImageSource): Promise<LabelImage | null> {
    // Load the native picker only when capture or selection is requested.
    const picker: typeof import('expo-image-picker') = require('expo-image-picker');
    if (source === 'camera') {
        const permission = await picker.requestCameraPermissionsAsync();
        if (!permission.granted) {
            throw new LabelImageError('Camera access was not granted. Choose a photo instead, or enable camera access in device settings.');
        }
    }
    const options = { mediaTypes: 'images' as const, quality: 0.9, exif: false };
    const result = source === 'camera'
        ? await picker.launchCameraAsync(options)
        : await picker.launchImageLibraryAsync(options);
    return result.canceled ? null : fromAsset(result.assets[0]);
}

/** Leaves native image URI lifetime to the operating system. */
export function releaseLabelImage(_image: LabelImage): void {
    // Native picker URIs are managed by the operating system.
}
