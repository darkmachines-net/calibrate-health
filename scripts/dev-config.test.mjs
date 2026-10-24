/** @file Regression coverage for dev config: worktree identifiers are stable and Docker-safe. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allocatePorts,
  readDotenv,
  resolveDevConfig,
  serializeDotenv,
  slugify,
  stableHash,
} from "./dev-config.mjs";

test("worktree identifiers are stable and Docker-safe", () => {
  assert.equal(slugify("Calibrate Health / Feature"), "calibrate-health-feature");
  assert.equal(slugify("!!!"), "calibrate-health");
  assert.equal(stableHash("C:/worktree"), stableHash("C:/worktree"));
  assert.match(stableHash("C:/worktree"), /^[a-f0-9]{8}$/);
});

test("port allocation keeps services in disjoint bands and skips collisions", async () => {
  const unavailable = new Set([20_123, 30_123, 40_123]);
  const ports = await allocatePorts(123, async (port) => !unavailable.has(port));
  assert.deepEqual(ports, {
    backendPort: 20_124,
    postgresPort: 30_124,
    webPort: 40_124,
  });
});

test("dotenv serialization preserves values that contain spaces and symbols", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-dev-config-"));
  try {
    const filePath = path.join(temporaryDirectory, ".env");
    fs.writeFileSync(
      filePath,
      serializeDotenv({
        SIMPLE: "value",
        SYMBOLS: "space # equals=value",
        ESCAPED: 'quote="value" path=C:\\dev',
      })
    );
    assert.deepEqual(readDotenv(filePath), {
      SIMPLE: "value",
      SYMBOLS: "space # equals=value",
      ESCAPED: 'quote="value" path=C:\\dev',
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("generated worktree configuration is isolated, persistent, and secret-safe", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-worktree-"));
  const deterministicRandom = (size) => Buffer.alloc(size, 7);
  try {
    fs.writeFileSync(
      path.join(temporaryDirectory, ".env"),
      [
        "FATSECRET_CLIENT_ID=client",
        "FATSECRET_CLIENT_SECRET=secret",
        "WEB_PUSH_SUBJECT=mailto:test@example.com",
        "WEIGHT_TREND_MODEL=v1",
        "ADMIN_USER_IDS=7,12",
        "ADMIN_EMAILS=operator@example.com",
        "",
      ].join("\n")
    );

    const first = await resolveDevConfig({
      workspacePath: temporaryDirectory,
      environment: {},
      portAvailable: async () => true,
      randomBytes: deterministicRandom,
    });
    assert.equal(first.FOOD_DATA_PROVIDER, "fatsecret");
    assert.equal(first.WEIGHT_TREND_MODEL, "v1");
    assert.equal(first.ADMIN_USER_IDS, "7,12");
    assert.equal(first.ADMIN_EMAILS, undefined);
    assert.equal(first.WEB_PUSH_SUBJECT, "mailto:test@example.com");
    assert.equal(first.SESSION_COOKIE_NAME, `cal.${first.WORKTREE_HASH}.sid`);
    assert.match(first.hostDatabaseUrl, new RegExp(`127\\.0\\.0\\.1:${first.POSTGRES_PORT}`));
    assert.match(first.internalDatabaseUrl, /@postgres:5432/);

    const second = await resolveDevConfig({
      workspacePath: temporaryDirectory,
      environment: {},
      portAvailable: async () => {
        throw new Error("persisted ports should be reused");
      },
      randomBytes: () => {
        throw new Error("persisted secrets should be reused");
      },
    });
    assert.equal(second.SESSION_SECRET, first.SESSION_SECRET);
    assert.equal(second.POSTGRES_PASSWORD, first.POSTGRES_PASSWORD);
    assert.equal(second.BACKEND_PORT, first.BACKEND_PORT);

    const generated = fs.readFileSync(path.join(temporaryDirectory, ".dev.env"), "utf8");
    assert.doesNotMatch(generated, /GITHUB_TOKEN|CALIBRATE_GH_PAT/);
    assert.doesNotMatch(generated, /ADMIN_EMAILS/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("port overrides must be supplied as one complete set", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "calibrate-ports-"));
  try {
    await assert.rejects(
      resolveDevConfig({
        workspacePath: temporaryDirectory,
        environment: { CALIBRATE_DEV_BACKEND_PORT: "21000" },
        persist: false,
      }),
      /Set all three/
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
