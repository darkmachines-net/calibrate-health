/** @file Browser nutrition-label image selection and upload preparation within the user gesture. */

export type LabelImageSource = 'camera' | 'library';
export type LabelImage = { uri: string; upload: Blob };
export class LabelImageError extends Error {}
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Keep file selection in the tap event so mobile browsers can offer the rear camera. */
export function chooseLabelImage(source: LabelImageSource): Promise<LabelImage | null> {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp';
        if (source === 'camera') input.setAttribute('capture', 'environment');
        input.hidden = true;
        document.body.appendChild(input);
        input.oncancel = () => { input.remove(); resolve(null); };
        input.onchange = () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return resolve(null);
            if (file.size > MAX_IMAGE_BYTES) return reject(new LabelImageError('Choose a photo smaller than 8 MB.'));
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                return reject(new LabelImageError('Choose a JPEG, PNG, or WebP photo.'));
            }
            resolve({ uri: URL.createObjectURL(file), upload: file });
        };
        input.click();
    });
}

/** Releases the browser object URL allocated for a selected label image. */
export function releaseLabelImage(image: LabelImage): void {
    URL.revokeObjectURL(image.uri);
}
