/** @file Regression coverage for expo native dev: native Expo defaults to the current worktree backend from the Android emulator. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseExpoNativeDevArgs,
  resolveExpoNativeBackendUrl,
} from "./expo-native-dev.mjs";

test("native Expo defaults to the current worktree backend from the Android emulator", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-expo-native-"));
  try {
    assert.equal(
      resolveExpoNativeBackendUrl({
        repoRoot,
        backendPort: 25_536,
        environment: {},
      }),
      "http://10.0.2.2:25536"
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native Expo targets the current worktree backend from the iOS simulator", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-expo-native-"));
  try {
    assert.equal(
      resolveExpoNativeBackendUrl({
        repoRoot,
        backendPort: 25_536,
        platform: "ios",
        environment: {},
      }),
      "http://127.0.0.1:25536"
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("native Expo parses Android and iOS platform options", () => {
  assert.deepEqual(parseExpoNativeDevArgs([]), { platform: "android" });
  assert.deepEqual(parseExpoNativeDevArgs(["--platform", "ios"]), { platform: "ios" });
  assert.deepEqual(parseExpoNativeDevArgs(["-p", "ANDROID"]), { platform: "android" });
  assert.throws(() => parseExpoNativeDevArgs(["--platform"]), /android or ios/);
  assert.throws(() => parseExpoNativeDevArgs(["--platform", "web"]), /android or ios/);
  assert.throws(() => parseExpoNativeDevArgs(["--bad"]), /Unknown native Expo option/);
});

test("native Expo preserves an explicit physical-device server URL", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-expo-native-"));
  try {
    fs.writeFileSync(
      path.join(repoRoot, ".env"),
      "EXPO_PUBLIC_CALIBRATE_SERVER_URL=http://192.168.0.10:3000\n"
    );
    assert.equal(
      resolveExpoNativeBackendUrl({
        repoRoot,
        backendPort: 25_536,
        environment: {},
      }),
      "http://192.168.0.10:3000"
    );
    assert.equal(
      resolveExpoNativeBackendUrl({
        repoRoot,
        backendPort: 25_536,
        environment: {
          EXPO_PUBLIC_CALIBRATE_SERVER_URL: "https://calibrate.example.test",
        },
      }),
      "https://calibrate.example.test"
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
