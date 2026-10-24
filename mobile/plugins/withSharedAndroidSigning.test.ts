/** @file Regression coverage for with Shared Android Signing: withSharedAndroidSigning config plugin. */

const signingPlugin = require('./withSharedAndroidSigning') as {
    injectSharedAndroidSigning(source: string): string;
};

const GENERATED_GRADLE = `plugins {
    id 'com.android.application'
}

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}
`;

describe('withSharedAndroidSigning config plugin', () => {
    it('replaces only release debug signing and remains idempotent', () => {
        const once = signingPlugin.injectSharedAndroidSigning(GENERATED_GRADLE);
        const twice = signingPlugin.injectSharedAndroidSigning(once);

        expect(twice).toBe(once);
        expect(twice).toContain('debug {\n            signingConfig signingConfigs.debug');
        expect(twice).toContain('if (calibrateHasSharedReleaseSigning) {');
        expect(twice).toContain('signingConfig signingConfigs.calibrateSharedRelease');
        expect(twice.match(/calibrate: shared phone\/watch release signing/g)).toHaveLength(1);
        expect(twice).toContain("task.name.toLowerCase().contains('release')");
        expect(twice).toContain('CALIBRATE_ANDROID_SIGNING_STORE_FILE');
    });

    it('fails when the generated release signing shape is unknown', () => {
        expect(() => signingPlugin.injectSharedAndroidSigning(
            GENERATED_GRADLE.replace('signingConfig signingConfigs.debug\n            minifyEnabled', 'minifyEnabled'),
        )).toThrow('generated release debug signing was not found');
    });
});
