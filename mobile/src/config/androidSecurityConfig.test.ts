/** @file Regression coverage for android Security Config: Android privacy configuration. */

const appConfig = require('../../app.json') as {
    expo: {
        android: { allowBackup?: boolean; blockedPermissions?: string[] };
        plugins: Array<string | [string, Record<string, unknown>]>;
    };
};

describe('Android privacy configuration', () => {
    it('disables OS backup and blocks unrelated sensitive permissions', () => {
        expect(appConfig.expo.android.allowBackup).toBe(false);
        expect(appConfig.expo.android.blockedPermissions).toEqual(expect.arrayContaining([
            'android.permission.READ_EXTERNAL_STORAGE',
            'android.permission.RECORD_AUDIO',
            'android.permission.SYSTEM_ALERT_WINDOW',
            'android.permission.WRITE_EXTERNAL_STORAGE'
        ]));
        expect(appConfig.expo.plugins).toContainEqual([
            'expo-secure-store',
            { configureAndroidBackup: false }
        ]);
        expect(appConfig.expo.plugins).toContainEqual([
            'expo-build-properties',
            { android: { minSdkVersion: 26, usesCleartextTraffic: false } }
        ]);
    });
});
