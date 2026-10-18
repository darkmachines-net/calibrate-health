/** @file Calibrate application input boundaries and version-mirror normalization; selection and orchestration live in the toolkit. */
import { trackedIdentity } from '@mchartier/expo-release';
const IGNORED = /(^|\/)(__tests__|__mocks__|fixtures|e2e|docs)(\/|$)|(^|\/)src\/(test|androidTest)\/|\.(test|spec)\.[^/]+$|(^|\/)(README[^/]*|AGENTS\.md)$/i;
const SERVER_FILES = /^(backend\/|shared\/|packages\/|mobile\/|Dockerfile\.app$|\.dockerignore$|package(?:-lock)?\.json$|scripts\/expo-(?:cli-environment|web-build|web-release)\.mjs$)/;
const PHONE_FILES = /^(mobile\/|shared\/|packages\/api-client\/|package(?:-lock)?\.json$)/;
const VERSION_MIRRORS = /^(shared\/(release|client-diagnostic-versions)\.json|docs\/openapi\/v1\.yaml|packages\/api-client\/src\/generated\/v1\.ts)$|(^|\/)package(?:-lock)?\.json$/;

/** Release mirrors change versions without changing the application inputs they describe. */
function applicationContent(file, text) {
  if (file === 'shared/release.json') {
    const value = JSON.parse(text);
    return JSON.stringify({ api: value.server.api, major: value.server.version.split('.')[0],
      application_id: value.android.application_id, channels: value.android.channels,
      minimum_phone: value.android.mobile.minimum_supported_version,
      minimum_wear: value.android.wear.minimum_supported_version });
  }
  if (file === 'shared/client-diagnostic-versions.json') {
    const value = JSON.parse(text);
    delete value.previous_web_release;
    delete value.supported_versions.web;
    return JSON.stringify(value);
  }
  if (/(^|\/)package(?:-lock)?\.json$/.test(file)) {
    const value = JSON.parse(text);
    delete value.version;
    if (value.scripts) value.scripts = Object.fromEntries(Object.entries(value.scripts)
      .filter(([name]) => /^(pre|post)?(install|prepare|build(?::.*)?|start(?::.*)?)$/.test(name)));
    for (const [name, entry] of Object.entries(value.packages ?? {})) {
      if (!name.includes('node_modules')) delete entry.version;
    }
    return JSON.stringify(value);
  }
  if (file === 'docs/openapi/v1.yaml' || file === 'packages/api-client/src/generated/v1.ts') {
    return text.replace(/(version: ?)["']?\d+\.\d+\.\d+["']?/g, '$1<version>');
  }
  return text;
}

/** Classify source inputs conservatively, separating native-only modules from browser entrypoints. */
function affectsComponent(file, component) {
  if (IGNORED.test(file)) return false;
  if (component === 'server') {
    return SERVER_FILES.test(file) && !/\.(native|android|ios)\.[^/]+$/.test(file)
      && !/^mobile\/(android|ios|gradle|plugins|modules)\//.test(file);
  }
  if (component === 'ota') {
    if (file === 'shared/client-diagnostic-versions.json') return false;
    return PHONE_FILES.test(file) && !/\.web\.[^/]+$/.test(file)
      && !/^mobile\/(public|android|ios|gradle)\//.test(file);
  }
  throw new Error(`Unknown component: ${component}`);
}


/** Hash Calibrate's server, OTA or Wear inputs using the shared tracked-source reader. */
export function applicationIdentity(root, source, component) {
  return trackedIdentity(root, source, {
    include: file => component === 'wear' ? file.startsWith('wear/') && !IGNORED.test(file) : affectsComponent(file, component),
    content: file => (component === 'wear' ? file === 'wear/app/build.gradle.kts' : VERSION_MIRRORS.test(file)) ? 'text' : 'blob',
    normalize: (file, text) => component === 'wear' && file === 'wear/app/build.gradle.kts'
      ? text.replace(/versionCode = \d+/g, 'versionCode = <reserved>').replace(/versionName = "[^"]+"/g, 'versionName = "<reserved>"')
      : applicationContent(file, text)
  });
}
