/** @file Protect the unified release graph: server health and native handoff gate OTA, store completion does not. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

/** Parse workflow YAML as data so assertions cover actual job dependencies and permission scopes. */
function workflow(name) {
  return parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

test('isolated OTA tooling checkouts contain the complete local import graph', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-tooling-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = new Set();
  let checkouts = 0;
  for (const job of Object.values(workflow('expo-ota-update').jobs)) {
    for (const step of job.steps ?? []) {
      const sparse = step.with?.['sparse-checkout'];
      if (!sparse?.includes('/scripts/expo-runtime.mjs')) continue;
      checkouts += 1;
      if (seen.has(sparse)) continue;
      seen.add(sparse);
      const checkout = path.join(root, String(checkouts));
      const files = sparse.trim().split(/\s+/).filter((file) => file.startsWith('/scripts/') && file.endsWith('.mjs'));
      for (const file of files) {
        const destination = path.join(checkout, file.slice(1));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(new URL(`..${file}`, import.meta.url), destination);
      }
      const urls = files.map((file) => pathToFileURL(path.join(checkout, file.slice(1))).href);
      execFileSync(process.execPath, ['--input-type=module', '--eval',
        `await Promise.all(${JSON.stringify(urls)}.map(url => import(url)));`], { cwd: checkout, stdio: 'pipe' });
    }
  }
  assert.equal(checkouts, 4, 'both environment resolvers and source exporters stay isolated');
});

test('the replacement graph retains the existing WireGuard deployment worker and named secrets', () => {
  const { jobs } = workflow('release-components');
  assert.equal(jobs.deploy.uses, './.github/workflows/deploy-self-hosted.yml');
  assert.deepEqual(Object.keys(jobs.deploy.secrets).sort(), ['DEPLOY_TOKEN', 'DEPLOY_WG_ENDPOINT', 'DEPLOY_WG_PRIVATE_KEY']);
  assert.match(jobs.deployment_intent.if, /outputs.server == 'true'/);
  assert.match(jobs.deployment_intent.if, /image_complete/);
  assert.equal(jobs.deploy.permissions.contents, 'read');
});

test('OTA depends on native handoff and selected deployment, never the submission monitor', () => {
  const { jobs } = workflow('release-components');
  assert.deepEqual(jobs.ota.needs, ['state', 'record_deploy', 'queue_phone']);
  assert.match(jobs.ota.if, /outputs.server != 'true'/);
  assert.match(jobs.ota.if, /outputs.native != 'true'/);
  assert.match(jobs.ota.if, /needs.queue_phone.result == 'success'/);
  assert.equal(jobs.finish_native.needs, 'queue_phone');
  assert.equal(jobs.finish_native.with.operation, 'finish');
  assert.ok(jobs.finish.needs.includes('ota'));
  assert.ok(jobs.finish.needs.includes('finish_native'));
});

test('native build and attestation retain separate credential and permission boundaries', () => {
  const { jobs } = workflow('native-build');
  assert.equal(jobs['build-internal'].environment, 'native-release-signing');
  assert.equal(jobs['build-internal'].permissions.contents, 'read');
  assert.equal(jobs.attest.environment, undefined);
  assert.equal(jobs.attest.permissions['id-token'], 'write');
  assert.equal(jobs.attest.permissions.contents, 'read');
  assert.ok(jobs.attest.steps.some((step) => step.uses?.startsWith('actions/attest@')));
});

test('submission installs tools and verifies retained binaries before admitting Expo authentication', () => {
  const steps = workflow('native-submit').jobs.submit.steps;
  const install = steps.findIndex((step) => step.run?.includes('npm ci'));
  const verify = steps.findIndex((step) => step.run?.includes('native-release-artifacts.mjs restore'));
  const submit = steps.findIndex((step) => step.env?.EXPO_TOKEN);
  assert.ok(install >= 0 && verify > install && submit > verify);
  assert.match(steps[install].run, /--ignore-scripts/);
});

test('OTA exports, attestations, and both credential stages remain separate on both channels', () => {
  const parsed = workflow('expo-ota-update');
  const { jobs } = parsed;
  assert.equal(parsed.on.workflow_call.inputs.native_build_ref, undefined);
  assert.equal(parsed.on.workflow_dispatch.inputs.native_build_ref, undefined);
  assert.equal(parsed.permissions.contents, 'read');
  const preflight = jobs['preflight-release-target'];
  assert.equal(preflight.permissions.contents, 'read');
  assert.doesNotMatch(JSON.stringify(preflight), /EXPO_TOKEN|secrets\./);
  assert.match(JSON.stringify(preflight), /merge-base --is-ancestor/);
  const approval = jobs['approve-production'];
  assert.equal(approval.environment, 'production');
  assert.equal(approval.permissions.contents, 'read');
  assert.ok(approval.needs.includes('publish-internal'));
  assert.match(approval.if, /!inputs.publish_internal \|\| needs.publish-internal.result == 'success'/);
  assert.match(approval.if, /needs.preflight-release-target.result == 'success'/);
  assert.equal(Object.values(jobs).filter(job => job.environment === 'production').length, 1);
  for (const channel of ['internal', 'production']) {
    const build = jobs[`build-${channel}-update`];
    assert.doesNotMatch(JSON.stringify(build), /EXPO_TOKEN|secrets\.|contents.*write/);
    assert.match(JSON.stringify(build), /expo-runtime\.mjs/);
    assert.match(JSON.stringify(build), /--runtime-file/);
    assert.match(JSON.stringify(build), /--platform android/);
    const retain = jobs[`retain-${channel}`];
    assert.equal(retain.permissions['id-token'], 'write');
    assert.doesNotMatch(JSON.stringify(retain), /EXPO_TOKEN|secrets\./);
    assert.ok(retain.steps.some(step => step.uses?.startsWith('actions/attest@')));
    const publish = jobs[`publish-${channel}`];
    assert.ok(publish.needs.includes(`retain-${channel}`));
    assert.match(JSON.stringify(publish), /expo-ota-store\.mjs restore/);
    assert.match(JSON.stringify(publish), /expo-ota-publish\.mjs/);
    for (const name of [`resolve-${channel}-environment`, `publish-${channel}`]) {
      const job = jobs[name];
      const auth = job.steps.findIndex(step => step.env?.EXPO_TOKEN);
      const install = job.steps.findIndex(step => step.run?.includes('npm ci'));
      assert.ok(install >= 0 && auth > install);
      assert.match(job.steps[auth - 1].run, /verify-current-release-workflow/);
      assert.equal(job.steps.filter(step => step.env?.EXPO_TOKEN).length, 1);
      assert.doesNotMatch(job.steps.map(step => step.run ?? '').join('\n'), /Install source dependencies|\.bin\/expo" export/);
      for (const step of job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))) {
        assert.equal(step.with.ref, '${{ job.workflow_sha }}');
        assert.equal(step.with['persist-credentials'], false);
      }
    }
  }
});

test('draft release inspection has push access only in isolated tooling jobs', () => {
  const { jobs } = workflow('expo-ota-update');
  const inspection = jobs['inspect-retained-exports'];
  assert.equal(inspection.permissions.contents, 'write');
  assert.equal(inspection.permissions.actions, 'read');
  assert.match(inspection.steps[0].run, /GITHUB_REF.*refs\/heads\/master/);
  const read = inspection.steps.find(step => step.run?.includes('expo-ota-store.mjs inspect'));
  assert.match(read.if, /inputs.release_record_id != ''/);
  assert.equal(jobs['preflight-release-target'].needs, 'inspect-retained-exports');
  assert.equal(jobs['preflight-release-target'].permissions.contents, 'read');
  for (const channel of ['internal', 'production']) {
    assert.equal(jobs['preflight-release-target'].outputs[`${channel}_retained`],
      '${{ needs.inspect-retained-exports.outputs.' + channel + '_retained }}');
  }
  const recovery = workflow('recover-release').jobs.inspect;
  assert.equal(recovery.permissions.contents, 'write');
  for (const job of [inspection, recovery]) {
    assert.doesNotMatch(JSON.stringify(job), /EXPO_TOKEN|secrets\.|npm ci/);
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with.ref, '${{ job.workflow_sha }}');
    assert.equal(checkouts[0].with['persist-credentials'], false);
    assert.equal(checkouts[0].with['sparse-checkout'], 'scripts');
  }
});

test('paired builds admit signing after prebuild; promotions reuse verified artifacts and serialize Play writes', () => {
  const build = workflow('native-build').jobs;
  const signer = build['build-internal'];
  assert.doesNotMatch(JSON.stringify(signer), /EXPO_TOKEN|PLAY_|id-token/);
  const preparation = signer.steps.findIndex(step => step.run?.includes('native-release-build.mjs prepare'));
  const credentials = signer.steps.findIndex(step => JSON.stringify(step.env ?? {}).includes('secrets.CALIBRATE_ANDROID'));
  assert.ok(preparation >= 0 && credentials > preparation);
  assert.match(JSON.stringify(signer), /verify-artifacts/);
  assert.match(JSON.stringify(signer), /native-release-artifacts.mjs capture/);
  assert.doesNotMatch(JSON.stringify(build.attest), /secrets\.|EXPO_TOKEN|PLAY_/);
  const promotions = workflow('native-release');
  assert.doesNotMatch(JSON.stringify(promotions), /native-release-build|build-prepared|create-github-app-token|TAG_SIGNING|native-release-attestation|native-release-tags/);
  assert.match(JSON.stringify(promotions), /require-native-submitted/);
  assert.match(JSON.stringify(promotions), /native-eas-promote.mjs/);
  for (const name of ['cut-release-handler', 'publish-release-handler', 'native-release']) {
    assert.equal(workflow(name).concurrency.group, 'calibrate-server-release-publication');
    assert.equal(workflow(name).concurrency['cancel-in-progress'], false);
  }
});

test('no-op and client-only cuts avoid an empty version PR; recovery never calls the native builder', () => {
  const { jobs } = workflow('cut-release');
  assert.match(jobs.reserve.if, /noop/);
  assert.match(jobs.prepare.if, /outputs.server == 'true'/);
  assert.match(jobs.publish.if, /outputs.server != 'true' \|\| needs.finalize.result == 'success'/);
  assert.match(jobs.publish.with.release_commit, /inputs.source_sha/);
  const graph = workflow('release-components').jobs;
  assert.equal(graph.state.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0,
    'Historical recovery sources must remain available for the protected ancestry check');
  assert.match(graph.native_build.if, /!inputs.recovery/);
  assert.match(graph.native_build.if, /native_build_complete != 'true'/);
  assert.match(graph.retain_native.if, /inputs.recovery/);
  const nativeDownload = graph.retain_native.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(nativeDownload.with['run-id'], '${{ needs.state.outputs.producing_run_id }}');
  assert.match(graph.server_image.if, /image_complete != 'true'/);
  assert.equal(workflow('recover-release').jobs.resume.with.recovery, true);
  assert.doesNotMatch(JSON.stringify(workflow('publish-release')), /native-trust|\.release-trust|native_build_ref/);
  assert.equal(jobs.reserve.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with['artifact-ids'], '${{ needs.select.outputs.plan_artifact_id }}');
  const planDownload = jobs.reserve.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(planDownload.with['merge-multiple'], true, 'ID-based downloads must flatten the single plan into the path consumed by begin');
  assert.match(jobs.reserve.steps.at(-1).run, /release-plan\/release-plan\.json/);
});
