/** @file Metro bundler configuration for shared workspace sources and Expo platform resolution. */

const path = require('node:path');
const fs = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');
const apiClientRoot = path.resolve(workspaceRoot, 'packages/api-client');
const sharedRoot = path.resolve(workspaceRoot, 'shared');
const hoistedRuntimeModules = [
  '@babel/runtime',
  '@expo/image-utils',
  '@expo/vector-icons',
  '@ide/backoff',
  '@radix-ui/react-compose-refs',
  '@radix-ui/react-tabs',
  '@tanstack/react-query',
  '@tanstack/query-core',
  '@ungap/structured-clone',
  'abort-controller',
  'anser',
  'ansi-regex',
  'asap',
  'assert',
  'available-typed-arrays',
  'base64-js',
  'badgin',
  'buffer',
  'call-bind',
  'call-bind-apply-helpers',
  'call-bound',
  'client-only',
  'color',
  'color-convert',
  'color-name',
  'color-string',
  'debug',
  'decode-uri-component',
  'define-data-property',
  'define-properties',
  'dunder-proto',
  'es-define-property',
  'es-errors',
  'es-object-atoms',
  'event-target-shim',
  'escape-string-regexp',
  'fast-deep-equal',
  'filter-obj',
  'flow-enums-runtime',
  'for-each',
  'hoist-non-react-statics',
  'ieee754',
  'inherits',
  'invariant',
  'is-arrayish',
  'is-arguments',
  'is-generator-function',
  'is-callable',
  'is-nan',
  'is-regex',
  'is-typed-array',
  'function-bind',
  'generator-function',
  'get-intrinsic',
  'get-proto',
  'gopd',
  'has-property-descriptors',
  'has-symbols',
  'has-tostringtag',
  'hasown',
  'math-intrinsics',
  'memoize-one',
  'metro-source-map',
  'nanoid',
  'nullthrows',
  'object-is',
  'object-keys',
  'object.assign',
  'possible-typed-array-names',
  'promise',
  'punycode',
  'query-string',
  'react-devtools-core',
  'react-fast-compare',
  'react-freeze',
  'react-refresh',
  'react-native-gesture-handler',
  'react-native-health-connect',
  'react-native-is-edge-to-edge',
  'react-native-reanimated',
  'react-native-safe-area-context',
  'react-native-screens',
  'react-native-svg',
  'react-native-worklets',
  'regenerator-runtime',
  'scheduler',
  'semver',
  'server-only',
  'safe-regex-test',
  'set-function-length',
  'sf-symbols-typescript',
  'shallowequal',
  'simple-swizzle',
  'split-on-first',
  'stacktrace-parser',
  'strict-uri-encode',
  'use-latest-callback',
  'use-sync-external-store',
  'util',
  'vaul',
  'warn-once',
  'webidl-conversions',
  'which-typed-array',
  'whatwg-fetch',
  'whatwg-url-without-unicode',
  'yargs'
];
function resolveWorkspaceModuleRoot(moduleName) {
  const modulePathParts = moduleName.split('/');
  const mobileModuleRoot = path.resolve(projectRoot, 'node_modules', ...modulePathParts);
  if (fs.existsSync(mobileModuleRoot)) return mobileModuleRoot;

  const workspaceModuleRoot = path.resolve(workspaceRoot, 'node_modules', ...modulePathParts);
  return fs.existsSync(workspaceModuleRoot) ? workspaceModuleRoot : null;
}

const hoistedRuntimeRoots = Object.fromEntries(
  // Nested-only dependencies resolve through their owning package and must not become invalid watch roots.
  hoistedRuntimeModules
    .map((moduleName) => [moduleName, resolveWorkspaceModuleRoot(moduleName)])
    .filter((entry) => entry[1] !== null)
);
const config = getDefaultConfig(projectRoot);

// Watch only the workspace packages imported by mobile; watching the repo root makes Metro traverse backend/frontend
// node_modules and can trip over stale Windows temp links from unrelated installs. Some RN runtime polyfills are
// hoisted by npm workspaces, so map only those packages instead of watching the full root node_modules.
config.watchFolders = [apiClientRoot, sharedRoot, ...Object.values(hoistedRuntimeRoots)];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@calibrate/api-client': apiClientRoot,
  '@calibrate/shared': sharedRoot,
  ...hoistedRuntimeRoots
};
config.resolver.blockList = [
  ...config.resolver.blockList,
  // npm executable shims are not runtime modules, and Linux-created shims can be unreadable to Metro on Windows.
  /[\\/]node_modules[\\/]\.bin(?:[\\/].*)?$/
];

module.exports = config;
