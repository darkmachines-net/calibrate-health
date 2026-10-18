/** @file Install the verified retained local phone/Wear build through Calibrate's device checks. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, verifyLocalBuild, hashIdentity, sourceEnvironment, sourceGit } from '@mchartier/expo-release';
import { readNativeUserEnvironment, NATIVE_ENVIRONMENT_KEYS } from './native-setup.mjs';
import { parseNativeReleaseDeviceArgs, runNativeReleaseDevices } from './native-release-devices.mjs';

/** Require an explicit common receipt and only device-install options before touching connected devices. */
export async function installRetainedNative(argv, { root = process.cwd(), environment = process.env, install = runNativeReleaseDevices } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return 'npm run native:install -- --receipt FILE [--phone-serial SERIAL] [--watch-serial SERIAL] [--no-launch] [--replace-incompatible]';
  if (argv[0] !== '--receipt' || !argv[1] || argv[1].startsWith('--')) throw new Error('Choose the retained build with --receipt FILE.');
  const args = argv.slice(2); const allowed = new Set(['--phone-serial', '--watch-serial', '--no-launch', '--replace-incompatible']);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || seen.has(key)) throw new Error(`Unknown or duplicate install option: ${key}`);
    seen.add(key);
    if (key.endsWith('-serial') && (!args[++index] || args[index].startsWith('--'))) throw new Error(`${key} needs a serial.`);
  }
  const receipt = await verifyLocalBuild(path.resolve(root, argv[1]));
  if (receipt.source.commit !== sourceGit(root, ['rev-parse', 'HEAD']) || hashIdentity(receipt.plan.config) !== hashIdentity(readConfig(root))) {
    throw new Error('Install from the original source checkout and release configuration.');
  }
  const retainedFiles = {};
  for (const target of ['phone', 'wear']) {
    const artifact = receipt.artifacts.find(value => value.target === target);
    if (!artifact) throw new Error('Install requires the retained phone/Wear pair.');
    for (const format of ['apk', 'aab']) {
      if (!artifact.receipt.manifest.files.some(value => value.path === `native.${format}`)) throw new Error(`Missing retained ${target} ${format}.`);
      retainedFiles[`${target === 'wear' ? 'watch' : 'phone'}-${format}`] = path.join(artifact.directory, `native.${format}`);
    }
  }
  const clean = sourceEnvironment(environment);
  if (process.platform === 'win32') {
    const saved = readNativeUserEnvironment(environment);
    for (const key of NATIVE_ENVIRONMENT_KEYS) if (!clean[key] && saved[key]) clean[key] = saved[key];
  }
  return install({ repositoryRoot: root, environment: clean, retainedFiles,
    config: parseNativeReleaseDeviceArgs(['--skip-build', ...args]) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  installRetainedNative(process.argv.slice(2)).then(result => { if (typeof result === 'string') console.log(result); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
