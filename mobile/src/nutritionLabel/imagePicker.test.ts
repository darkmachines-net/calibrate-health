/** @file Regression coverage for image Picker: native capture requests camera access and uploads the opaque file URI. */

import { chooseLabelImage, LabelImageError } from './imagePicker';

const mockPermission = jest.fn();
const mockCamera = jest.fn();
const mockLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: (...args: unknown[]) => mockPermission(...args),
    launchCameraAsync: (...args: unknown[]) => mockCamera(...args),
    launchImageLibraryAsync: (...args: unknown[]) => mockLibrary(...args)
}));

beforeEach(() => {
    jest.clearAllMocks();
    mockPermission.mockResolvedValue({ granted: true });
    mockCamera.mockResolvedValue({
        canceled: false, assets: [{ uri: 'file:///camera.jpg', mimeType: 'image/jpeg', fileSize: 2000 }]
    });
});

test('native capture requests camera access and uploads the opaque file URI', async () => {
    expect(await chooseLabelImage('camera')).toEqual({
        uri: 'file:///camera.jpg',
        upload: { uri: 'file:///camera.jpg', name: 'nutrition-label.jpg', type: 'image/jpeg' }
    });
    expect(mockPermission).toHaveBeenCalledTimes(1);
    expect(mockCamera).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: 'images', exif: false }));
});

test('denied permission has an actionable recovery and never launches capture', async () => {
    mockPermission.mockResolvedValue({ granted: false });
    await expect(chooseLabelImage('camera')).rejects.toThrow('Choose a photo instead');
    expect(mockCamera).not.toHaveBeenCalled();
});

test('library selection does not require camera permission and cancellation is harmless', async () => {
    mockLibrary.mockResolvedValue({ canceled: true });
    expect(await chooseLabelImage('library')).toBeNull();
    expect(mockPermission).not.toHaveBeenCalled();
});

test('oversized and unsupported photos fail before upload', async () => {
    for (const asset of [
        { uri: 'file:///huge.jpg', mimeType: 'image/jpeg', fileSize: 9 * 1024 * 1024 },
        { uri: 'file:///photo.heic', mimeType: 'image/heic', fileSize: 200 }
    ]) {
        mockLibrary.mockResolvedValue({ canceled: false, assets: [asset] });
        await expect(chooseLabelImage('library')).rejects.toBeInstanceOf(LabelImageError);
    }
});
