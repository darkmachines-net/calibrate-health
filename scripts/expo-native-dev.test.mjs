/** @file Check worktree API selection and credential-free shared Metro configuration for isolated dev clients. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { developmentServer } from "@mchartier/expo-release/development";
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

test("shared Metro startup keeps the worktree API, development identity and explicit connection settings", () => {
  const options = parseExpoNativeDevArgs(["--platform", "ios", "--port", "8082", "--host", "192.168.1.20", "--clear"]);
  assert.deepEqual(options, { platform: "ios", port: "8082", host: "192.168.1.20", clear: true });
  assert.throws(() => parseExpoNativeDevArgs(["--port"]), /requires a value/);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = developmentServer(root, {
    ...options, publicEnvironment: { EXPO_PUBLIC_CALIBRATE_SERVER_URL: "http://127.0.0.1:25536" },
  });
  assert.equal(server.command, process.execPath);
  assert.equal(server.cwd, path.join(root, "mobile"));
  assert.deepEqual(server.args.slice(1), ["start", "--dev-client", "--lan", "--port", "8082", "--clear"]);
  assert.equal(server.env.EXPO_PUBLIC_CALIBRATE_SERVER_URL, "http://127.0.0.1:25536");
  assert.equal(server.env.EXPO_RELEASE_VARIANT, "development");
  assert.equal(server.env.EAS_BUILD_PROFILE, "development");
  assert.equal(server.env.EXPO_NO_DOTENV, "1");
  assert.equal(server.env.REACT_NATIVE_PACKAGER_HOSTNAME, "192.168.1.20");
  assert.ok(!Object.keys(server.env).some(key => /TOKEN|SECRET|PASSWORD/.test(key)));
  assert.throws(() => developmentServer(root, { port: 80 }), /port must be/);
});
