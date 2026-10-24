/** @file Regression coverage for wear build task guard: Wear signing guards classify the build variant before incidental task suffixes. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const wearBuild = readFileSync(new URL('../wear/app/build.gradle.kts', import.meta.url), 'utf8');

test('Wear signing guards classify the build variant before incidental task suffixes', () => {
  const classifier = wearBuild.match(
    /fun wearTaskBuildType\(taskName: String\): WearTaskBuildType\? = when \{[\s\S]*?\n\}/
  )?.[0];

  assert.ok(classifier, 'Wear build must keep one explicit task build-type classifier');
  assert.ok(
    classifier.indexOf('taskName.contains("Release")') < classifier.indexOf('taskName.contains("Debug")'),
    'release must win before incidental DebugSymbols text'
  );
  assert.match(wearBuild, /"stripReleaseDebugSymbols" to WearTaskBuildType\.RELEASE/);
  assert.match(wearBuild, /"stripInternalDebugSymbols" to WearTaskBuildType\.INTERNAL/);
  assert.match(wearBuild, /"stripDebugDebugSymbols" to WearTaskBuildType\.DEBUG/);
  assert.match(
    wearBuild,
    /taskBuildType == WearTaskBuildType\.DEBUG \|\| taskBuildType == WearTaskBuildType\.INTERNAL/
  );
  assert.match(wearBuild, /taskBuildType == WearTaskBuildType\.RELEASE && !hasReleaseSigning/);
});
