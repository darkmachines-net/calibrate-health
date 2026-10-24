/** @file Current release contract: metadata-only stamping, stable native fingerprints and fixed destination configuration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { stamp } from './release-hooks.mjs';
import { sourceEnvironment } from '@mchartier/expo-release';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(root,'release.config.json')));
const allocation={server:true,native:true,bump:'major',versions:{server:'0.99.0',mobile:'1.0.0'},pair:[101,102]};

test('version stamping changes only declared application metadata', t => {
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'release-metadata-'));
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  for(const file of config.metadataFiles){const destination=path.join(copy,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file),destination);}
  stamp(copy,allocation);
  const app=JSON.parse(fs.readFileSync(path.join(copy,'mobile/app.json')));
  assert.equal(app.expo.version,'1.0.0');
  const release=JSON.parse(fs.readFileSync(path.join(copy,'shared/release.json')));
  assert.equal(release.server.version,'0.99.0');assert.equal(release.android.mobile.version_code,101);assert.equal(release.android.wear.version_code,102);
  const diagnostics=JSON.parse(fs.readFileSync(path.join(copy,'shared/client-diagnostic-versions.json')));
  assert.ok(diagnostics.supported_versions.android_phone.includes('1.0.0'));
});

test('OTA patch stamps the bundle version without manufacturing a new binary build number', t => {
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'release-ota-metadata-'));
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  for(const file of config.metadataFiles){const destination=path.join(copy,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file),destination);}
  stamp(copy,{...allocation,server:false,native:false,bump:'patch',versions:{mobile:'1.1.2'}});
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy,'mobile/release-version.json'))).version,'1.1.2');
  assert.deepEqual(fs.readFileSync(path.join(copy,'shared/release.json')),fs.readFileSync(path.join(root,'shared/release.json')));
});

test('the real Expo SDK ignores stamped versions but retains native compatibility', {timeout:180000}, () => {
  const app=path.join(root,'mobile'),require=createRequire(path.join(app,'package.json'));
  const sdk=require.resolve('@expo/fingerprint');
  const platforms=['android'];
  const env=sourceEnvironment(config.profiles.production.publicEnvironment);
  const fingerprint=platform=>JSON.parse(execFileSync(process.execPath,['-e',
    'require(process.argv[1]).createFingerprintAsync(process.cwd(),{platforms:[process.argv[2]],silent:true}).then(x=>console.log(JSON.stringify(x)))',sdk,platform],
    {cwd:app,env:{...env,EAS_BUILD_PLATFORM:platform},encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}));
  const before=Object.fromEntries(platforms.map(p=>[p,fingerprint(p)]));
  const originals=new Map(config.metadataFiles.map(file=>[file,fs.readFileSync(path.join(root,file))]));
  try {
    stamp(root,allocation);
    for(const platform of platforms){const after=fingerprint(platform);assert.equal(after.hash,before[platform].hash);
      assert.ok(after.sources.some(source=>source.id=== 'expoAutolinkingConfig:'+platform || source.reasons.some(reason=>reason.includes('Autolinking'))));}
  } finally {for(const [file,bytes] of originals)fs.writeFileSync(path.join(root,file),bytes);}
});

test('configured identity, approval environments and destinations remain explicit', () => {
  assert.equal(config.schemaVersion,3);assert.equal(config.server.deployment.service,'calibratehealth');
  assert.ok(config.profiles.production.approvalEnvironment);assert.equal(config.profiles.production.deployEnvironment,'self-hosted-testing');
  const eas=JSON.parse(fs.readFileSync(path.join(root,'mobile/eas.json')));
  assert.equal(eas.cli.version,'25.3.0');
  assert.deepEqual(config.mobile.targets.map(t=>t.id),['phone','wear']);
  assert.equal(eas.submit.phone.android.track,'internal');assert.equal(eas.submit.wear.android.track,'wear:internal');
  assert.equal(config.server.metadataOnNative,true);
});
