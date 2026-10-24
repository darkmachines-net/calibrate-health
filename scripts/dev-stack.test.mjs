/** @file Regression coverage for dev stack: Compose version parsing enforces the watch-capable minimum. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isVersionAtLeast,
  MINIMUM_COMPOSE_VERSION,
  parseComposeVersion,
} from "./dev-stack.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Compose version parsing enforces the watch-capable minimum", () => {
  assert.deepEqual(parseComposeVersion("Docker Compose version v2.38.2-desktop.1"), [2, 38, 2]);
  assert.equal(isVersionAtLeast([2, 22, 0]), true);
  assert.equal(isVersionAtLeast([2, 21, 9]), false);
  assert.deepEqual(MINIMUM_COMPOSE_VERSION, [2, 22, 0]);
});

test("root development scripts use one host stack launcher", () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
  );
  assert.equal(rootPackage.scripts.dev, "node scripts/dev-stack.mjs dev");
  assert.equal(rootPackage.scripts["dev:setup"], "node scripts/dev-stack.mjs setup");
  assert.equal(rootPackage.scripts["dev:down"], "node scripts/dev-stack.mjs down");
  assert.equal(rootPackage.scripts["dev:status"], "node scripts/dev-stack.mjs status");
  assert.equal(rootPackage.scripts["dev:expo"], "node scripts/expo-native-dev.mjs");
  assert.equal(rootPackage.scripts["ci:local"], "node scripts/dev-stack.mjs ci");
  assert.equal(rootPackage.scripts.setup, "node scripts/dev-env.mjs setup:host");
  assert.equal(rootPackage.devDependencies["@devcontainers/cli"], undefined);
});

test("development Compose defines isolated services without source or dependency volumes", () => {
  const compose = fs.readFileSync(path.join(repositoryRoot, "compose.dev.yaml"), "utf8");
  assert.match(compose, /^\s{2}postgres:/m);
  assert.match(compose, /^\s{2}backend:/m);
  assert.match(compose, /^\s{2}web:/m);
  assert.match(compose, /127\.0\.0\.1:\$\{POSTGRES_PORT\}:5432/);
  assert.match(compose, /SESSION_COOKIE_NAME: \$\{SESSION_COOKIE_NAME\}/);
  assert.match(compose, /NODE_PATH: \/workspace\/mobile\/node_modules/);
  assert.match(compose, /develop:\s*\n\s+watch:/);
  assert.doesNotMatch(compose, /^\s+-\s+\.:\/workspace/m);
  assert.doesNotMatch(compose, /^\s+-\s+[^\n]*node_modules:/m);
});

test("development image contains both dependency trees and no devcontainer runtime", () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile.dev"), "utf8");
  assert.match(dockerfile, /FROM node:22\.14\.0-bookworm/);
  assert.match(dockerfile, /RUN npm ci --no-audit --fund=false/);
  assert.match(dockerfile, /RUN npm --prefix backend ci --no-audit --fund=false/);
  assert.doesNotMatch(dockerfile, /devcontainer/i);

  for (const removedPath of [
    ".devcontainer/devcontainer.json",
    ".devcontainer/docker-compose.yml",
    "scripts/codex-worktree-env.mjs",
    "scripts/devcontainer-worktree.mjs",
    "scripts/devcontainer-cli-cache.mjs",
  ]) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, removedPath)), false, removedPath);
  }
});

test("Codex setup stays on the host and actions use ordinary npm scripts", () => {
  const setup = fs.readFileSync(
    path.join(repositoryRoot, ".codex", "local-environment.setup.mjs"),
    "utf8"
  );
  const environment = fs.readFileSync(
    path.join(repositoryRoot, ".codex", "environments", "environment.toml"),
    "utf8"
  );
  assert.match(setup, /scripts", "dev-env\.mjs"\), "setup:host"/);
  assert.match(setup, /scripts", "dev-stack\.mjs"\), "configure"/);
  assert.doesNotMatch(setup, /devcontainer/i);
  assert.match(environment, /command = "npm run dev"/);
  assert.match(environment, /command = "npm test"/);
  assert.doesNotMatch(environment, /devcontainer|codex-worktree-env/i);
});
