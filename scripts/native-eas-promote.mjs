/** @file Promote an attested EAS-submitted native pair by exact Play version codes and AAB hashes, never release names. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGooglePlayPublisher, resolveGooglePlayAccessToken, NATIVE_PLAY_TRACKS } from './native-play-release.mjs';

/** Require one completed singleton release; mutable EAS/Console names carry no source authority. */
function completedCode(track, code) {
  const matches = (track.releases ?? []).filter((release) => (release.versionCodes ?? []).map(String).includes(String(code)));
  if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].versionCodes.length !== 1) {
    throw new Error(`Track ${track.track} must contain one completed release for code ${code}.`);
  }
  return matches[0];
}

/** Reconstruct immutable code/hash bindings from the attested build metadata before modifying a track. */
function verifyPlayBundles(metadata, bundles) {
  for (const role of ['phone', 'wear']) {
    const code = metadata.native[`${role}_code`];
    const artifact = metadata.artifacts.find((item) => item.id === `${role}-aab`);
    const matches = (bundles.bundles ?? []).filter((bundle) => Number(bundle.versionCode) === code);
    if (matches.length !== 1 || matches[0].sha256?.toLowerCase() !== artifact?.sha256) throw new Error(`Play ${role} bundle differs from the attested build.`);
  }
}

/** Promote both roles in one edit and verify the exact resulting codes after commit. */
export async function promoteEasPair({ metadata, destination, publisher }) {
  if (!['closed', 'production'].includes(destination)) throw new Error('Promotion destination must be closed or production.');
  const sourceStage = destination === 'closed' ? 'internal' : 'closed';
  const edit = await publisher.createEdit();
  let committed = false;
  try {
    verifyPlayBundles(metadata, await publisher.listBundles(edit));
    const changes = [];
    for (const [role, trackRole] of [['phone', 'phone'], ['wear', 'watch']]) {
      const code = metadata.native[`${role}_code`];
      const source = await publisher.getTrack(edit, NATIVE_PLAY_TRACKS[sourceStage][trackRole]);
      const release = completedCode(source, code);
      const target = await publisher.getTrack(edit, NATIVE_PLAY_TRACKS[destination][trackRole]);
      const releases = target.releases ?? [];
      if (releases.some((item) => item.status !== 'completed')) throw new Error('Finish the existing destination rollout before promotion.');
      const existing = releases.some((item) => (item.versionCodes ?? []).map(String).includes(String(code)));
      if (existing) completedCode(target, code);
      else if (releases.some((item) => (item.versionCodes ?? []).some((value) => Number(value) >= code))) {
        throw new Error('Refusing to replace a newer Play version.');
      }
      changes.push({ track: NATIVE_PLAY_TRACKS[destination][trackRole], release, existing, code });
    }
    if (changes.every((item) => item.existing)) return { alreadyComplete: true };
    if (changes.some((item) => item.existing)) throw new Error('Destination contains only half of the native pair; reconcile before promotion.');
    for (const item of changes) await publisher.updateTrack(edit, item.track, {
      name: item.release.name, status: 'completed', versionCodes: [String(item.code)]
    });
    await publisher.commitEdit(edit);
    committed = true;
  } finally {
    if (!committed) await publisher.deleteEdit(edit);
  }
  const readback = await publisher.createEdit();
  try {
    verifyPlayBundles(metadata, await publisher.listBundles(readback));
    completedCode(await publisher.getTrack(readback, NATIVE_PLAY_TRACKS[destination].phone), metadata.native.phone_code);
    completedCode(await publisher.getTrack(readback, NATIVE_PLAY_TRACKS[destination].watch), metadata.native.wear_code);
  } finally {
    await publisher.deleteEdit(readback);
  }
  return { alreadyComplete: false };
}

/** Admit Play credentials only after the workflow has independently verified retained native attestations. */
async function main() {
  const [metadataFile, destination] = process.argv.slice(2);
  if (process.env.CONFIRM_PLAY_CONSOLE_CLEAN !== 'true') throw new Error('Confirm Console coordination before Play promotion.');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const credentialsFile = path.join(process.env.RUNNER_TEMP, 'native-promotion-account.json');
  try {
    if (process.env.SERVICE_ACCOUNT_JSON_BASE64) fs.writeFileSync(credentialsFile, Buffer.from(process.env.SERVICE_ACCOUNT_JSON_BASE64, 'base64'), { mode: 0o600 });
    const accessToken = await resolveGooglePlayAccessToken({
      serviceAccountFile: process.env.SERVICE_ACCOUNT_JSON_BASE64 ? credentialsFile : undefined,
      environment: { GOOGLE_PLAY_ACCESS_TOKEN: process.env.ACCESS_TOKEN }
    });
    const publisher = createGooglePlayPublisher({ applicationId: metadata.application_id, accessToken });
    console.log(JSON.stringify(await promoteEasPair({ metadata, destination, publisher })));
  } finally {
    fs.rmSync(credentialsFile, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
