/** @file Regression coverage for camera Runtime: native barcode camera runtime. */

import { isBarcodeCameraAvailable } from './cameraRuntime';

describe('native barcode camera runtime', () => {
    it('lets CameraView mount instead of relying on the web-only availability probe', async () => {
        await expect(isBarcodeCameraAvailable()).resolves.toBe(true);
    });
});
