/** @file with Health Connect: Upgrade prior generated redirects and keep the ACTION_VIEW rewrite idempotent. */

const {
  AndroidConfig,
  withAndroidManifest,
  withMainActivity,
} = require('@expo/config-plugins');

const HEALTH_CONNECT_PROVIDER_PACKAGE = 'com.google.android.apps.healthdata';
const HEALTH_CONNECT_READ_PERMISSIONS = [
  'android.permission.health.READ_STEPS',
  'android.permission.health.READ_ACTIVE_CALORIES_BURNED',
  'android.permission.health.READ_TOTAL_CALORIES_BURNED',
  'android.permission.health.READ_EXERCISE',
  'android.permission.health.READ_WEIGHT',
];
const PERMISSION_RATIONALE_ACTION = 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE';
const VIEW_PERMISSION_USAGE_ACTION = 'android.intent.action.VIEW_PERMISSION_USAGE';
const HEALTH_PERMISSIONS_CATEGORY = 'android.intent.category.HEALTH_PERMISSIONS';
const VIEW_PERMISSION_USAGE_ALIAS = 'ViewPermissionUsageActivity';
const PERMISSION_DELEGATE_IMPORT =
  'import dev.matinzd.healthconnect.permissions.HealthConnectPermissionDelegate';
const PERMISSION_DELEGATE_CALL = 'HealthConnectPermissionDelegate.setPermissionDelegate(this)';
const INTENT_IMPORT = 'import android.content.Intent';
const URI_IMPORT = 'import android.net.Uri';
const PRIVACY_DEEP_LINK = 'calibrate://health-connect-privacy';

function privacyIntentRedirect(intentName) {
  return `if (${intentName}?.action == "${PERMISSION_RATIONALE_ACTION}" || ${intentName}?.action == "${VIEW_PERMISSION_USAGE_ACTION}") {\n      ${intentName}.action = Intent.ACTION_VIEW\n      ${intentName}.data = Uri.parse("${PRIVACY_DEEP_LINK}")\n    }`;
}

/** Upgrade prior generated redirects and keep the ACTION_VIEW rewrite idempotent. */
function normalizePrivacyRedirectActions(source) {
  const actionAssignment = /^\s*intent\.action = Intent\.ACTION_VIEW\r?\n/gm;
  const deepLinkAssignment = /^(\s*)intent\.data = Uri\.parse\("calibrate:\/\/health-connect-privacy"\)$/gm;
  return source
    .replace(actionAssignment, '')
    .replace(deepLinkAssignment, (match, indentation) =>
      `${indentation}intent.action = Intent.ACTION_VIEW\n${match}`,
    );
}

function hasAction(intentFilter, actionName) {
  return intentFilter.action?.some((action) => action.$?.['android:name'] === actionName) ?? false;
}

function ensureProviderQuery(androidManifest) {
  const queries = androidManifest.manifest.queries ?? [];
  const hasProvider = queries.some((query) =>
    query.package?.some((entry) => entry.$?.['android:name'] === HEALTH_CONNECT_PROVIDER_PACKAGE),
  );

  if (!hasProvider) {
    const providerQuery = queries[0] ?? {};
    providerQuery.package = providerQuery.package ?? [];
    providerQuery.package.push({ $: { 'android:name': HEALTH_CONNECT_PROVIDER_PACKAGE } });
    if (queries.length === 0) queries.push(providerQuery);
  }
  androidManifest.manifest.queries = queries;
}

function ensurePermissionRationaleIntent(mainActivity) {
  const intentFilters = mainActivity['intent-filter'] ?? [];
  if (!intentFilters.some((intentFilter) => hasAction(intentFilter, PERMISSION_RATIONALE_ACTION))) {
    intentFilters.push({
      action: [{ $: { 'android:name': PERMISSION_RATIONALE_ACTION } }],
    });
  }
  mainActivity['intent-filter'] = intentFilters;
}

function ensureViewPermissionUsageAlias(mainApplication, mainActivityName) {
  const aliases = mainApplication['activity-alias'] ?? [];
  const existingAlias = aliases.find(
    (alias) => alias.$?.['android:name'] === VIEW_PERMISSION_USAGE_ALIAS,
  );
  const alias = existingAlias ?? { $: {}, 'intent-filter': [] };

  alias.$ = {
    ...alias.$,
    'android:name': VIEW_PERMISSION_USAGE_ALIAS,
    'android:exported': 'true',
    'android:targetActivity': mainActivityName,
    'android:permission': 'android.permission.START_VIEW_PERMISSION_USAGE',
  };

  const intentFilters = alias['intent-filter'] ?? [];
  if (!intentFilters.some((intentFilter) => hasAction(intentFilter, VIEW_PERMISSION_USAGE_ACTION))) {
    intentFilters.push({
      action: [{ $: { 'android:name': VIEW_PERMISSION_USAGE_ACTION } }],
      category: [{ $: { 'android:name': HEALTH_PERMISSIONS_CATEGORY } }],
    });
  }
  alias['intent-filter'] = intentFilters;

  if (!existingAlias) aliases.push(alias);
  mainApplication['activity-alias'] = aliases;
}

/** Add the least-privilege read-only Health Connect manifest contract. */
function applyHealthConnectManifest(androidManifest) {
  AndroidConfig.Permissions.ensurePermissions(
    androidManifest,
    HEALTH_CONNECT_READ_PERMISSIONS,
  );
  ensureProviderQuery(androidManifest);

  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
  const mainActivityName = mainActivity.$['android:name'];
  ensurePermissionRationaleIntent(mainActivity);
  ensureViewPermissionUsageAlias(mainApplication, mainActivityName);
  return androidManifest;
}

/** Register the library permission delegate after ReactActivity has initialized. */
function injectPermissionDelegate(mainActivitySource) {
  let source = mainActivitySource;
  for (const requiredImport of [PERMISSION_DELEGATE_IMPORT, INTENT_IMPORT, URI_IMPORT]) {
    if (source.includes(requiredImport)) continue;
    const packageDeclaration = /^package\s+[^\r\n]+\r?\n/m;
    if (!packageDeclaration.test(source)) {
      throw new Error('Unable to add Health Connect imports: MainActivity has no package declaration.');
    }
    source = source.replace(packageDeclaration, (match) => `${match}\n${requiredImport}\n`);
  }

  const superOnCreate = /^(\s*)super\.onCreate\([^\r\n]*\)\s*;?\s*$/m;
  if (!superOnCreate.test(source)) {
    throw new Error('Unable to register the Health Connect permission delegate: MainActivity has no super.onCreate call.');
  }
  if (!source.includes(PRIVACY_DEEP_LINK)) {
    source = source.replace(
      superOnCreate,
      (match, indentation) => `${indentation}${privacyIntentRedirect('intent')}\n${match}`,
    );
  }
  if (!source.includes(PERMISSION_DELEGATE_CALL)) {
    source = source.replace(
      superOnCreate,
      (match, indentation) => `${match}\n${indentation}${PERMISSION_DELEGATE_CALL}`,
    );
  }

  if (!source.includes('override fun onNewIntent(intent: Intent)')) {
    const mainComponentMarker = /^\s*override fun getMainComponentName/m;
    if (!mainComponentMarker.test(source)) {
      throw new Error('Unable to route the Health Connect privacy intent: MainActivity has no main-component override.');
    }
    const override = `  override fun onNewIntent(intent: Intent) {\n    ${privacyIntentRedirect('intent')}\n    super.onNewIntent(intent)\n  }\n\n`;
    source = source.replace(mainComponentMarker, `${override}  override fun getMainComponentName`);
  }
  return normalizePrivacyRedirectActions(source);
}

/** Adds Health Connect manifest and permission-delegate integration, requiring Kotlin MainActivity output. */
const withHealthConnect = (config) => {
  config = withAndroidManifest(config, (manifestConfig) => {
    manifestConfig.modResults = applyHealthConnectManifest(manifestConfig.modResults);
    return manifestConfig;
  });

  return withMainActivity(config, (activityConfig) => {
    if (activityConfig.modResults.language !== 'kt') {
      throw new Error('Health Connect requires a Kotlin MainActivity.');
    }
    activityConfig.modResults.contents = injectPermissionDelegate(
      activityConfig.modResults.contents,
    );
    return activityConfig;
  });
};

module.exports = withHealthConnect;
module.exports.HEALTH_CONNECT_READ_PERMISSIONS = HEALTH_CONNECT_READ_PERMISSIONS;
module.exports.applyHealthConnectManifest = applyHealthConnectManifest;
module.exports.injectPermissionDelegate = injectPermissionDelegate;
