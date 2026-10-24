/** @file Regression coverage for xcode uuid compatibility: Expo xcode generates valid CommonJS project identifiers without the legacy UUID dependency. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

/** SDK 58 uses xcode's built-in UUID generation without the retired uuid override. */
test('Expo xcode generates valid CommonJS project identifiers without the legacy UUID dependency', () => {
  const configPluginPackage = require.resolve('@expo/config-plugins/package.json');
  const requireFromConfigPlugin = createRequire(configPluginPackage);
  const xcodeEntry = requireFromConfigPlugin.resolve('xcode');
  const requireFromXcode = createRequire(xcodeEntry);
  const xcode = requireFromXcode('xcode');
  const xcodePackage = requireFromXcode('xcode/package.json');
  const project = xcode.project('fixture.pbxproj');
  /** SDK 58 uses xcode's built-in UUID generation without the retired uuid override. */
  project.hash = { project: { objects: {} } };

  assert.equal(xcodePackage.dependencies.uuid, undefined);
  assert.match(project.generateUuid(), /^[0-9A-F]{24}$/);
});
