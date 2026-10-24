/** @file Regression coverage for with Optional Camera Hardware: withOptionalCameraHardware config plugin. */

jest.mock('@expo/config-plugins', () => ({
    withAndroidManifest: (config: any, action: (config: any) => any) => action(config)
}));

const withOptionalCameraHardware = require('./withOptionalCameraHardware') as (config: any) => any;
const OPTIONAL_CAMERA_FEATURES = [
    'android.hardware.camera.any',
    'android.hardware.camera',
    'android.hardware.camera.autofocus',
    'android.hardware.camera.flash'
];

function applyOptionalCameraHardware(manifest: any) {
    return withOptionalCameraHardware({ modResults: manifest }).modResults;
}

describe('withOptionalCameraHardware config plugin', () => {
    it('marks all camera capabilities optional without duplicating generated features', () => {
        const manifest = {
            manifest: {
                'uses-feature': [
                    {
                        $: {
                            'android:name': 'android.hardware.camera',
                            'android:required': 'true'
                        }
                    }
                ]
            }
        };

        applyOptionalCameraHardware(manifest);
        applyOptionalCameraHardware(manifest);

        const cameraFeatures = manifest.manifest['uses-feature'].filter((entry: any) =>
            OPTIONAL_CAMERA_FEATURES.includes(entry.$['android:name'])
        );
        expect(cameraFeatures).toHaveLength(OPTIONAL_CAMERA_FEATURES.length);
        expect(cameraFeatures.map((entry: any) => entry.$['android:name']).sort())
            .toEqual([...OPTIONAL_CAMERA_FEATURES].sort());
        expect(cameraFeatures.every((entry: any) => entry.$['android:required'] === 'false')).toBe(true);
    });

    it('preserves unrelated hardware declarations', () => {
        const manifest = {
            manifest: {
                'uses-feature': [{
                    $: {
                        'android:name': 'android.hardware.sensor.stepcounter',
                        'android:required': 'false'
                    }
                }]
            }
        };

        applyOptionalCameraHardware(manifest);

        expect(manifest.manifest['uses-feature']).toContainEqual({
            $: {
                'android:name': 'android.hardware.sensor.stepcounter',
                'android:required': 'false'
            }
        });
    });
});
