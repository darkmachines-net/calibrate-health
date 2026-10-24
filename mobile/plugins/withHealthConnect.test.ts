/** @file Regression coverage for with Health Connect: withHealthConnect config plugin. */

const healthConnectPlugin = require('./withHealthConnect') as {
    HEALTH_CONNECT_READ_PERMISSIONS: string[];
    applyHealthConnectManifest: (manifest: any) => any;
    injectPermissionDelegate: (source: string) => string;
};

function createManifest() {
    return {
        manifest: {
            $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
            queries: [],
            application: [
                {
                    $: { 'android:name': '.MainApplication' },
                    activity: [
                        {
                            $: { 'android:name': '.MainActivity', 'android:exported': 'true' },
                            'intent-filter': [
                                {
                                    action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }]
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    };
}

describe('withHealthConnect config plugin', () => {
    it('adds only the initial Health Connect read permissions and required discovery/rationale entries', () => {
        const manifest = createManifest();

        healthConnectPlugin.applyHealthConnectManifest(manifest);
        healthConnectPlugin.applyHealthConnectManifest(manifest);

        const healthPermissions = manifest.manifest['uses-permission']
            .map((entry: any) => entry.$['android:name'])
            .filter((name: string) => name.startsWith('android.permission.health.'));
        expect(healthPermissions).toEqual(healthConnectPlugin.HEALTH_CONNECT_READ_PERMISSIONS);

        const providerQueries = manifest.manifest.queries.flatMap((query: any) => query.package ?? []);
        expect(manifest.manifest.queries).toHaveLength(1);
        expect(providerQueries).toEqual([
            { $: { 'android:name': 'com.google.android.apps.healthdata' } }
        ]);

        const mainActivity = manifest.manifest.application[0].activity[0];
        const rationaleFilters = mainActivity['intent-filter'].filter((intentFilter: any) =>
            intentFilter.action?.some(
                (action: any) => action.$['android:name'] === 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE'
            )
        );
        expect(rationaleFilters).toHaveLength(1);

        const aliases = manifest.manifest.application[0]['activity-alias'];
        expect(aliases).toHaveLength(1);
        expect(aliases[0].$).toEqual({
            'android:name': 'ViewPermissionUsageActivity',
            'android:exported': 'true',
            'android:targetActivity': '.MainActivity',
            'android:permission': 'android.permission.START_VIEW_PERMISSION_USAGE'
        });
        expect(aliases[0]['intent-filter']).toEqual([
            {
                action: [{ $: { 'android:name': 'android.intent.action.VIEW_PERMISSION_USAGE' } }],
                category: [{ $: { 'android:name': 'android.intent.category.HEALTH_PERMISSIONS' } }]
            }
        ]);
    });

    it('injects the permission delegate import and registration once', () => {
        const source = `package net.darkmachines.healthtracker

import android.os.Bundle

class MainActivity {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

        const once = healthConnectPlugin.injectPermissionDelegate(source);
        const twice = healthConnectPlugin.injectPermissionDelegate(once);

        expect(twice.match(/import dev\.matinzd\.healthconnect\.permissions\.HealthConnectPermissionDelegate/g)).toHaveLength(1);
        expect(twice.match(/HealthConnectPermissionDelegate\.setPermissionDelegate\(this\)/g)).toHaveLength(1);
        expect(twice.match(/calibrate:\/\/health-connect-privacy/g)).toHaveLength(2);
        expect(twice.match(/\.action = Intent\.ACTION_VIEW/g)).toHaveLength(2);
        expect(twice.match(/override fun onNewIntent\(intent: Intent\)/g)).toHaveLength(1);
        expect(twice.indexOf('calibrate://health-connect-privacy')).toBeLessThan(
            twice.indexOf('super.onCreate(null)')
        );
        expect(twice.indexOf('super.onCreate(null)')).toBeLessThan(
            twice.indexOf('HealthConnectPermissionDelegate.setPermissionDelegate(this)')
        );

        const legacyGeneratedSource = once.replace(/^\s*intent\.action = Intent\.ACTION_VIEW\r?\n/gm, '');
        const upgraded = healthConnectPlugin.injectPermissionDelegate(legacyGeneratedSource);
        expect(upgraded.match(/\.action = Intent\.ACTION_VIEW/g)).toHaveLength(2);
    });
});
