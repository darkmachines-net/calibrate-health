/** @file Regression coverage for xcode uuid compatibility: Expo xcode generates valid CommonJS project identifiers without the legacy UUID dependency. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

/** Prove the security override still satisfies the Expo config plugin that owns the xcode dependency. */
test('patched UUID remains compatible with xcode CommonJS project identifiers', () => {
  const configPluginPackage = require.resolve('@expo/config-plugins/package.json');
  const requireFromConfigPlugin = createRequire(configPluginPackage);
  const xcodeEntry = requireFromConfigPlugin.resolve('xcode');
  const requireFromXcode = createRequire(xcodeEntry);
  const xcode = requireFromXcode('xcode');
  const uuidPackage = requireFromXcode('uuid/package.json');
  const project = xcode.project('fixture.pbxproj');
  /** SDK 58 uses xcode's built-in UUID generation without the retired uuid override. */
  project.hash = { project: { objects: {} } };

  /** SDK 58 uses xcode's built-in UUID generation without the retired uuid override. */
  assert.equal(uuidPackage.version, '11.1.1');
  /** SDK 58 uses xcode's built-in UUID generation without the retired uuid override. */
  assert.match(project.generateUuid(), /^[0-9A-F]{24}$/);
});
