/** @file Paired Android/iOS metadata, stable fingerprints, separate development identities and beta/production destinations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { stamp } from './release-hooks.mjs';
import { applicationIdentity } from './release-inputs.mjs';
import { checkRepository, validateManifest, validateClientDiagnosticVersionContract } from './release-metadata.mjs';
import { sourceEnvironment } from '@mchartier/expo-release';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(root,'release.config.json')));
const allocation={server:true,native:true,bump:'major',versions:{server:'0.99.0',mobile:'1.0.0'},pair:[101,102]};

test('version stamping keeps every current mirror and diagnostic platform consistent', async t => {
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'release-metadata-'));
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  for(const file of [...config.metadataFiles,'mobile/eas.json']){const destination=path.join(copy,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(root,file),destination);}
  stamp(copy,allocation);
  const app=JSON.parse(fs.readFileSync(path.join(copy,'mobile/app.json')));
  assert.equal(app.expo.version,'1.0.0');
  assert.equal(app.expo.ios.buildNumber,'101');
  const release=JSON.parse(fs.readFileSync(path.join(copy,'shared/release.json')));
  assert.equal(release.server.version,'0.99.0');assert.equal(release.android.mobile.version_code,101);assert.equal(release.android.wear.version_code,102);
  const diagnostics=JSON.parse(fs.readFileSync(path.join(copy,'shared/client-diagnostic-versions.json')));
  for(const platform of ['android_phone','ios','wear_os']) {
    assert.equal(diagnostics.supported_versions[platform][0],'1.0.0');
    assert.equal(new Set(diagnostics.supported_versions[platform]).size,diagnostics.supported_versions[platform].length);
  }
  assert.deepEqual((await checkRepository(copy)).errors,[]);
  delete app.expo.ios;
  fs.writeFileSync(path.join(copy,'mobile/app.json'),JSON.stringify(app));
  assert.ok((await checkRepository(copy)).errors.some(error=>error.includes('expo.ios.buildNumber')));
});

test('legacy duplicate codes, release tags and missing iOS diagnostics are rejected', () => {
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'shared/release.json')));
  manifest.android.mobile.version_code=manifest.android.wear.version_code=8;
  manifest.android.mobile.native_release_tag='v0.13.2';
  const errors=validateManifest(manifest);
  for(const message of ['must be odd','globally unique','native-vMAJOR.MINOR.PATCH'])assert.ok(errors.some(error=>error.includes(message)));
  const diagnostics=JSON.parse(fs.readFileSync(path.join(root,'shared/client-diagnostic-versions.json')));
  delete diagnostics.supported_versions.ios;
  const invalid=validateClientDiagnosticVersionContract(manifest,diagnostics,fs.readFileSync(path.join(root,'backend/openapi/v1.yaml'),'utf8'));
  assert.ok(invalid.some(error=>error.includes('must define exactly')));
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
  const platforms=['android','ios'];
  const env=sourceEnvironment(config.profiles.production.publicEnvironment);
  const fingerprint=platform=>JSON.parse(execFileSync(process.execPath,['-e',
    'require(process.argv[1]).createFingerprintAsync(process.cwd(),{platforms:[process.argv[2]],silent:true}).then(x=>console.log(JSON.stringify(x)))',sdk,platform],
    {cwd:app,env:{...env,EAS_BUILD_PLATFORM:platform},encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}));
  const before=Object.fromEntries(platforms.map(p=>[p,fingerprint(p)]));
  // SDK 58 normalizes React Native autolinking into named module arrays.
  for (const [platform, value] of Object.entries(before)) {
    const expo = JSON.parse(value.sources.find(source => source.id === 'expoAutolinkingConfig:' + platform)?.contents ?? '{}');
    const native = JSON.parse(value.sources.find(source => source.id === 'rncoreAutolinkingConfig:' + platform)?.contents ?? '[]');
    for (const name of platform === 'android' ? ['expo-updates', '@calibrate/wear-pairing'] : ['expo-updates']) {
      assert.ok(expo.modules?.some(module => module.packageName === name), name + ' must contribute to native compatibility');
    }
    if (platform === 'android') assert.ok(native.some(module => module.name === 'react-native-health-connect' && module.platforms?.android),
      'Health Connect Android discovery must contribute to native compatibility');
  }
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
  assert.deepEqual(config.mobile.targets.map(t=>t.id),['phone','wear','ios']);
  assert.equal(config.mobile.targets[2].builder,'eas');
  assert.equal(config.mobile.targets[2].applicationId,'app.calibratehealth.mobile');
  assert.deepEqual(Object.keys(config.profiles),['beta','production']);
  assert.equal(config.profiles.beta.approvalEnvironment,'preview');
  for (const name of ['beta','production']) {
    const profile=config.profiles[name];
    assert.equal(profile.channel,name);assert.equal(profile.easProfile,name);
    assert.equal(profile.signingEnvironment,'native-release-signing');
    assert.equal(profile.submitEnvironment,name === 'beta' ? 'play-internal' : 'play-production');
    assert.equal(profile.deployEnvironment,'self-hosted-testing');assert.equal(profile.submit,true);
    assert.equal(eas.build[name].environment,profile.environment);
    assert.equal(eas.build[name].distribution,'store');assert.equal(eas.build[name].autoIncrement,false);
    assert.equal(profile.publicEnvironment.EXPO_PUBLIC_CALIBRATE_SERVER_URL,'https://calibratehealth.darkmachines.net');
    assert.equal(eas.submit[profile.submitProfiles.ios].ios.ascAppId,'6826924944');
    for (const target of ['phone','wear']) {
      const submit=eas.submit[profile.submitProfiles[target]].android;
      const track=name === 'beta' ? 'internal' : 'production';
      assert.equal(submit.track,target === 'wear' ? 'wear:'+track : track);
      assert.equal(submit.releaseStatus,name === 'beta' ? 'completed' : 'draft');
    }
  }
  assert.equal(config.development.easProfile,'development');
  assert.equal(eas.build.development.developmentClient,true);
  assert.equal(eas.build.development.channel,undefined);
  assert.equal(config.server.metadataOnNative,true);
});

test('platform-specific bundle edits select only their platform while shared edits select both', t => {
  const copy=fs.mkdtempSync(path.join(os.tmpdir(),'release-inputs-'));
  t.after(()=>fs.rmSync(copy,{recursive:true,force:true}));
  /** Run Git only in this disposable source-identity fixture. */
  const git=args=>execFileSync('git',args,{cwd:copy,encoding:'utf8',windowsHide:true}).trim();
  git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  fs.mkdirSync(path.join(copy,'mobile/src'),{recursive:true});
  /** Commit a changed module and return both platform bundle identities. */
  const change=file=>{
    fs.writeFileSync(path.join(copy,'mobile/src',file),'export const changed=true;');
    git(['add','mobile']);git(['commit','-qm','fixture']);
    const sha=git(['rev-parse','HEAD']);
    return ['ota','ios'].map(component=>applicationIdentity(copy,sha,component));
  };
  const initial=change('shared.ts'),ios=change('feature.ios.ts'),android=change('feature.android.ts'),shared=change('other.ts');
  assert.equal(ios[0],initial[0]);assert.notEqual(ios[1],initial[1]);
  assert.notEqual(android[0],ios[0]);assert.equal(android[1],ios[1]);
  assert.notEqual(shared[0],android[0]);assert.notEqual(shared[1],android[1]);
});
