/** @file Public native command dispatcher for setup, configuration, build, installation, submission, and OTA. */

/** Expose concise local native build, install, submit, and fingerprint OTA commands. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  NATIVE_ENVIRONMENT_KEYS, nativeSetupEnvironment, parseNativeSetupArguments,
  readNativeUserEnvironment, setupNative
} from './native-setup.mjs';
import {
  localInternalEnvironment, parseLocalInternalArgs, runLocalInternalCli, verifyLocalInternalArtifacts
} from './native-internal-release.mjs';
import { parseNativeOtaArgs, runNativeOtaUpdate } from './native-ota-update.mjs';
import { parseNativeReleaseDeviceArgs, runNativeReleaseDevices } from './native-release-devices.mjs';
import { configureNative, parseNativeConfigureArguments, resolveNativeCredentialFile } from './native-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIONS = {
  build: 'Build signed phone and Wear APKs/AABs for manual upload, install or submit.',
  ota: 'Publish compatible phone JavaScript/assets through Expo.',
  install: 'Install and verify the last build on a local phone and watch.',
  submit: 'Upload the last verified AABs through Play API to internal and wear:internal.',
  configure: 'Download EAS Android signing and assigned Play credentials for local releases.',
  setup: 'Install/check Windows native tools and repository dependencies.'
};
const EXAMPLES = {
  build: '',
  ota: '--dry-run --message "Describe this update"',
  install: '[--phone-serial SERIAL] [--watch-serial SERIAL] [--no-launch] [--replace-incompatible]',
  submit: '',
  configure: '[--service-account-file C:\\secure\\healthtracker\\play-testing.json]',
  setup: '[--check] [--skip-deps] [--accept-licenses]'
};

/** Map public native actions to their documented npm entrypoints. */
function npmScript(action) {
  return action === 'ota' ? 'ota:publish' : 'native:' + action;
}

/** Describe release actions without inspecting credentials or local build state. */
function help(action) {
  if (action) {
    const lines = [ACTIONS[action], '  npm run ' + npmScript(action) +
      (EXAMPLES[action] ? ' -- ' + EXAMPLES[action] : '')];
    if (action === 'build') lines.push(
      'Requires installed tools/dependencies, external signing credentials, and a clean committed checkout.',
      'Uses native:configure settings; --credentials-file FILE overrides signing for this run.',
      'Run npm run native:setup for machine/worktree setup.',
      'For a new Play release, commit unused native version codes first; see scripts/README.md#local-native-workflow.',
      'Prebuild, signing, phone/Wear APK/AAB builds, and verification are included.'
    );
    if (action === 'submit') lines.push(
      'Requires Play Console onboarding and an external testing service-account file.',
      'Uses native:configure settings; --service-account-file FILE overrides Play credentials for this run.',
      'No confirmation flag or prompt. Coordinate other Console/API writers before submitting.',
      'Re-verifies and uploads the retained build, commits the internal release, and reads it back.',
      'No install, OTA publish, or separate status command is required between build and submit.'
    );
    if (action === 'configure') lines.push(
      'Automatically downloads the default Android signing key and assigned Play key for net.darkmachines.healthtracker.',
      'No credential menus or manual exit. EAS prompts only for login or first-time signing-key setup when needed.',
      'Keeps the downloaded credentials outside the repository and saves their paths across checkouts.',
      'Requires Expo authentication and network access, but no Android SDK. An unassigned Play key permits build/install only.',
      '--service-account-file FILE uses a local Play key instead of downloading it from EAS for this configuration.'
    );
    if (action === 'ota') lines.push(
      'Options: --message TEXT, --dry-run, --non-interactive, --baseline FILE, --channel NAME, --environment NAME.',
      'Run without --dry-run to publish. Updates target the source fingerprint runtime on the selected channel.'
    );
    if (action === 'install') lines.push(
      'Never rebuilds. By default upgrades in place; a signing-key change requires confirmation.',
      '--replace-incompatible explicitly allows uninstalling an incompatible signer and erasing its app data.'
    );
    if (action === 'setup') lines.push(
      '--check is read-only; --skip-deps limits setup to Android tools.',
      '--accept-licenses accepts the SDK licenses for packages being installed.'
    );
    return lines.join('\n');
  }
  return [
    'Local releases: npm run <script> -- [options]',
    '',
    ...Object.entries(ACTIONS).map(([name, description]) => '  ' + npmScript(name).padEnd(17) + description),
    '',
    'Build once, then choose manual AAB upload, install, or submit.',
    'Local builds use calibratehealth.darkmachines.net and Expo channel internal.',
    'Production store releases use the protected GitHub workflow.',
    'Run npm run <script> -- --help for options. See scripts/README.md#local-native-workflow.'
  ].join('\n');
}

/** Validate every option before reading settings or dispatching native workers. */
export function parseNativeArguments(argv) {
  const [action, ...args] = argv;
  if (!action || action === '--help' || action === '-h') return { action: 'help' };
  if (!Object.hasOwn(ACTIONS, action)) throw new Error('Unknown native action: ' + action + '. Run npm run to list scripts.');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help', helpAction: action };
  // Validate before reading user settings, credentials, artifacts, or invoking any worker.
  let config;
  if (action === 'configure') config = parseNativeConfigureArguments(args);
  else if (action === 'setup') config = parseNativeSetupArguments(args);
  else if (action === 'ota') config = parseNativeOtaArgs(args);
  else if (action === 'install') {
    const allowed = new Set(['--phone-serial', '--watch-serial', '--no-launch', '--replace-incompatible']);
    const seen = new Set();
    for (let index = 0; index < args.length; index += 1) {
      const option = args[index];
      if (!allowed.has(option) || seen.has(option)) throw new Error('Unknown or duplicate install option: ' + option);
      seen.add(option);
      if (option.endsWith('-serial')) {
        if (!args[++index] || args[index].startsWith('--')) throw new Error(option + ' requires a value.');
      }
    }
    config = parseNativeReleaseDeviceArgs(['--skip-build', ...args]);
  } else {
    const internalArgs = [...args];
    if (action === 'submit' && !internalArgs.includes('--confirm-play-console-clean')) internalArgs.push('--confirm-play-console-clean');
    config = parseLocalInternalArgs([action, ...internalArgs], { requireCredentials: false });
  }
  return { action, args, config };
}

/** Keep signing, Expo, and Play credentials scoped to the chosen local action. */
export async function runNative(argv = [], options = {}) {
  const { action, args, config, helpAction } = parseNativeArguments(argv);
  if (action === 'help') return help(helpAction);
  const root = options.root ?? ROOT;
  const inherited = options.environment ?? process.env;
  // The local entry point admits credentials only at their consuming stage.
  // Keep the stricter credential-free contract on the protected CI workers.
  const environment = nativeSetupEnvironment(inherited);
  if (['configure', 'ota'].includes(action) && inherited.EXPO_TOKEN) environment.EXPO_TOKEN = inherited.EXPO_TOKEN;
  const configurationOptions = { root, environment, platform: options.platform ?? process.platform };
  if (action === 'configure') return (options.configure ?? configureNative)(config, configurationOptions);
  let internalArgs = [action, ...args];
  if (['build', 'submit'].includes(action)) {
    const field = action === 'build' ? 'credentialsFile' : 'serviceAccountFile';
    const flag = action === 'build' ? '--credentials-file' : '--service-account-file';
    const file = (options.resolveCredentialFile ?? resolveNativeCredentialFile)(field, config.values[flag], configurationOptions);
    internalArgs = [action, flag, file];
    if (action === 'submit') internalArgs.push('--confirm-play-console-clean');
  }
  if (action === 'setup') return (options.setup ?? setupNative)(args, { root, environment });
  if (['build', 'install', 'submit'].includes(action) &&
      (options.platform ?? process.platform) === 'win32') {
    const saved = (options.readUserEnvironment ?? readNativeUserEnvironment)(environment);
    for (const key of NATIVE_ENVIRONMENT_KEYS) {
      if (!environment[key] && saved[key]) environment[key] = saved[key];
    }
  }
  if (action === 'ota') {
    return (options.ota ?? runNativeOtaUpdate)({ repositoryRoot: root, environment, config });
  }
  if (action === 'install') {
    const local = localInternalEnvironment(environment);
    await (options.verifyArtifacts ?? verifyLocalInternalArtifacts)({ root, environment: local });
    return (options.devices ?? runNativeReleaseDevices)({ repositoryRoot: root, environment: local, config });
  }
  if (action === 'submit') (options.log ?? console.log)(
    '[native] Submitting the paired internal release. Play commits can include other pending Console changes; coordinate other Console/API writers.'
  );
  return (options.internal ?? runLocalInternalCli)(
    internalArgs, { root, environment }
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runNative(process.argv.slice(2)).then((result) => {
    const action = process.argv[2];
    if (typeof result === 'string') console.log(result);
    else if (!['setup', 'ota', 'install'].includes(action) && result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
    if (result?.ok === false) process.exitCode = 1;
  }).catch((error) => {
    console.error('[native] ' + error.message);
    process.exitCode = 1;
  });
}
