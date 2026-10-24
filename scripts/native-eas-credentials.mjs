/** @file native eas credentials: Downloads exact-app signing and assigned Play credentials into a validated external EAS staging workspace. */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTERNAL_PROJECT_ID, loadLocalSigningEnvironment, requireExternalFile } from './native-internal-release.mjs';
import { NATIVE_RELEASE_APPLICATION_ID } from './native-release-evidence.mjs';
import { resolveLockedEasCliInvocation } from './native-ota-update.mjs';
import { createGoogleServiceAccountAssertion } from './native-play-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EAS_PLAY_CREDENTIAL_FILE = 'play-service-account.json';
const QUERY = `query LocalNativeCredentials($projectId: String!, $applicationIdentifier: String!, $downloadPlay: Boolean!) {
  app {
    byId(appId: $projectId) {
      id
      androidAppCredentials(filter: {applicationIdentifier: $applicationIdentifier, legacyOnly: false}) {
        applicationIdentifier
        androidAppBuildCredentialsList {
          isDefault
          androidKeystore { keystore keystorePassword keyAlias keyPassword }
        }
        googleServiceAccountKeyForSubmissions @include(if: $downloadPlay) { keyJson }
      }
    }
  }
}`;

function authenticatedQuery(root) {
  const { entryPoint } = resolveLockedEasCliInvocation(root, []);
  // Keep the internal EAS API adapter with the pinned CLI that supplies its authentication.
  const require = createRequire(path.join(root, 'tools/eas-cli/package.json'));
  const build = path.resolve(path.dirname(entryPoint), '../build');
  const SessionManager = require(path.join(build, 'user/SessionManager.js')).default;
  const { createGraphqlClient } = require(path.join(build, 'commandUtils/context/contextUtils/createGraphqlClient.js'));
  const session = new SessionManager();
  const accessToken = session.getAccessToken();
  const sessionSecret = accessToken ? null : session.getSessionSecret();
  if (!accessToken && !sessionSecret) throw new Error('Sign in through native:configure before downloading credentials.');
  const client = createGraphqlClient({ accessToken, sessionSecret });
  return (query, variables) => client.query(query, variables, { noRetry: true }).toPromise();
}

/** Downloads exact-app signing and assigned Play credentials into a validated external EAS staging workspace. */
export async function downloadEasCredentials({ root, directory, downloadPlay = true, query }) {
  const staging = fs.realpathSync(directory);
  if (!path.basename(staging).startsWith('eas-android-')) throw new Error('Invalid EAS credential staging directory.');
  requireExternalFile(root, path.join(staging, 'app.json'), 'EAS credential workspace');
  const request = query ?? authenticatedQuery(root);
  let response;
  try {
    response = await request(QUERY, { projectId: INTERNAL_PROJECT_ID, applicationIdentifier: NATIVE_RELEASE_APPLICATION_ID, downloadPlay });
  } catch {
    throw new Error('EAS credential lookup failed. Check Expo access and retry native:configure.');
  }
  // Never include server errors or response bodies: they can contain credential data.
  if (response?.error) throw new Error('EAS credential lookup failed. Check Expo access and retry native:configure.');
  const app = response?.data?.app?.byId;
  const credentials = app?.androidAppCredentials;
  if (app?.id !== INTERNAL_PROJECT_ID || !Array.isArray(credentials) || credentials.length !== 1 ||
      credentials[0]?.applicationIdentifier !== NATIVE_RELEASE_APPLICATION_ID) {
    throw new Error('EAS did not return the exact linked project and Android application credentials.');
  }
  const builds = credentials[0].androidAppBuildCredentialsList;
  const defaults = Array.isArray(builds) ? builds.filter((build) => build?.isDefault === true) : [];
  if (defaults.length !== 1 || !defaults[0].androidKeystore) {
    throw new Error('EAS must have exactly one default Android build credential with a keystore for this app.');
  }
  const keystore = defaults[0].androidKeystore;
  const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
  if (!nonEmpty(keystore.keystore) || !nonEmpty(keystore.keystorePassword) || !nonEmpty(keystore.keyAlias) ||
      (keystore.keyPassword != null && !nonEmpty(keystore.keyPassword))) {
    throw new Error('EAS returned incomplete Android signing credentials.');
  }
  const bytes = Buffer.from(keystore.keystore, 'base64');
  if (!bytes.length || bytes.toString('base64') !== keystore.keystore) {
    throw new Error('EAS returned an invalid Android keystore encoding.');
  }
  const assigned = downloadPlay ? credentials[0].googleServiceAccountKeyForSubmissions : null;
  let account;
  if (assigned !== null) {
    try {
      account = JSON.parse(assigned.keyJson);
      createGoogleServiceAccountAssertion(account);
    } catch {
      throw new Error('The assigned EAS Play service-account key is invalid. Update it in EAS and retry native:configure.');
    }
  }
  const keystoreDirectory = path.join(staging, 'credentials/android');
  fs.mkdirSync(keystoreDirectory, { recursive: true, mode: 0o700 });
  const keystorePath = path.join(keystoreDirectory, 'keystore.jks');
  fs.writeFileSync(keystorePath, bytes, { flag: 'wx', mode: 0o600 });
  const signingFile = path.join(staging, 'credentials.json');
  const signing = { keystorePath, keystorePassword: keystore.keystorePassword,
    keyAlias: keystore.keyAlias, keyPassword: keystore.keyPassword ?? keystore.keystorePassword };
  fs.writeFileSync(signingFile, JSON.stringify({ android: { keystore: signing } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  loadLocalSigningEnvironment(root, signingFile, {});
  if (account) {
    fs.writeFileSync(path.join(staging, EAS_PLAY_CREDENTIAL_FILE), JSON.stringify(account, null, 2) + '\n', {
      flag: 'wx', mode: 0o600
    });
  }
  return { playDownloaded: Boolean(account) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === '--skip-play')) {
      throw new Error('Expected an EAS credential staging directory and optional --skip-play.');
    }
    const result = await downloadEasCredentials({ root: ROOT, directory: process.argv[2], downloadPlay: process.argv[3] !== '--skip-play' });
    console.log(JSON.stringify(result));
  } catch {
    console.error('[native] EAS credential download failed. Check the default signing key, assigned Play key, and Expo access, then retry native:configure.');
    process.exitCode = 1;
  }
}
