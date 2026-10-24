#!/usr/bin/env node
/** @file Owns the current worktree's Docker Compose lifecycle, database, and supported development commands. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevConfig } from "./dev-config.mjs";
import { ensureDockerRuntime } from "./docker-runtime.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
export const MINIMUM_COMPOSE_VERSION = [2, 22, 0];

/**
 * Parse a Docker Compose semantic version.
 * @param {string} value
 * @returns {number[]}
 */
export function parseComposeVersion(value) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [];
  }
  return match.slice(1).map(Number);
}

/**
 * Check whether an installed Compose version meets the minimum.
 * @param {number[]} installed
 * @param {number[]} minimum
 * @returns {boolean}
 */
export function isVersionAtLeast(installed, minimum = MINIMUM_COMPOSE_VERSION) {
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = installed[index] ?? 0;
    if (actual > minimum[index]) return true;
    if (actual < minimum[index]) return false;
  }
  return true;
}

/**
 * Run a command with inherited output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, capture?: boolean }} options
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? defaultRepoRoot,
    env: options.env ?? process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr || result.stdout || "");
    }
    throw new Error(`${command} exited with status ${result.status ?? 1}.`);
  }
  return options.capture ? String(result.stdout || "").trim() : "";
}

/**
 * Validate the Compose runtime needed by compose watch.
 */
export function ensureComposeVersion() {
  const rawVersion = run("docker", ["compose", "version", "--short"], { capture: true });
  const installed = parseComposeVersion(rawVersion);
  if (!isVersionAtLeast(installed)) {
    throw new Error(
      `Docker Compose 2.22.0 or newer is required; found ${rawVersion || "an unknown version"}.`
    );
  }
}

/**
 * Build the common Compose argument prefix.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 * @returns {string[]}
 */
function composePrefix(config) {
  return [
    "compose",
    "--env-file",
    config.devEnvPath,
    "-f",
    config.composeFilePath,
    "--project-name",
    config.COMPOSE_PROJECT_NAME,
  ];
}

/**
 * Run Docker Compose for the current worktree.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnvironment]
 */
function runCompose(config, args, extraEnvironment = {}) {
  run("docker", [...composePrefix(config), ...args], {
    cwd: config.repoRoot,
    env: { ...process.env, ...extraEnvironment },
  });
}

/**
 * Run a host-side development task with the current worktree database injected.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 * @param {string[]} args
 */
function runDevEnvironmentTask(config, args) {
  run(process.execPath, [path.join(config.repoRoot, "scripts", "dev-env.mjs"), ...args], {
    cwd: config.repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: config.hostDatabaseUrl,
      BACKEND_PORT: String(config.backendPort),
      WEB_PORT: String(config.webPort),
    },
  });
}

/**
 * Ensure Docker and Compose are usable.
 */
async function ensureContainerRuntime() {
  await ensureDockerRuntime();
  ensureComposeVersion();
}

/**
 * Start only the current worktree database.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 */
function startDatabase(config) {
  runCompose(config, ["up", "-d", "--wait", "postgres"]);
}

/**
 * Prepare images and the database without starting the application services.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 */
function prepareStack(config) {
  runCompose(config, ["build", "backend"]);
  startDatabase(config);
  runDevEnvironmentTask(config, ["db:migrate"]);
}

/**
 * Print stable local URLs without exposing secrets.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 */
function printSummary(config) {
  console.log(
    [
      "",
      `[dev-stack] Worktree: ${path.basename(config.repoRoot)} (${config.WORKTREE_HASH})`,
      `[dev-stack] Web: http://localhost:${config.webPort}`,
      `[dev-stack] API: http://localhost:${config.backendPort}`,
      `[dev-stack] Postgres: 127.0.0.1:${config.postgresPort}`,
      `[dev-stack] Compose project: ${config.COMPOSE_PROJECT_NAME}`,
    ].join("\n")
  );
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/dev-stack.mjs <command>",
      "",
      "Commands:",
      "  configure       Generate worktree-local ports and secrets.",
      "  setup           Install host deps, build images, migrate, and seed.",
      "  dev             Prepare and run the stack with Compose Watch.",
      "  dev:manual-auth Run the stack without seeded-user auto-login.",
      "  down            Remove containers/network and retain database data.",
      "  status          Show service state and local URLs.",
      "  db:migrate      Apply migrations and seed the current database.",
      "  db:migrate:create [args]  Create a Prisma development migration.",
      "  db:reset        Reset and reseed the current database.",
      "  db:seed         Seed the current database.",
      "  db:studio       Open Prisma Studio for the current database.",
      "  ci              Run the host local-CI workflow with this database.",
      "  reset-test-user Reset the seeded account onboarding state.",
    ].join("\n")
  );
}

/** Dispatches the requested Compose lifecycle operation against the current worktree's resolved configuration. */
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const passthrough = argv.slice(1);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const workspacePath = path.resolve(process.env.CODEX_WORKTREE_PATH || defaultRepoRoot);
  const config = await resolveDevConfig({ workspacePath });

  if (!fs.existsSync(config.composeFilePath)) {
    throw new Error(`Development Compose file not found: ${config.composeFilePath}`);
  }

  if (command === "configure") {
    printSummary(config);
    return;
  }

  await ensureContainerRuntime();

  if (command === "setup") {
    prepareStack(config);
    printSummary(config);
    return;
  }
  if (command === "dev" || command === "dev:manual-auth") {
    prepareStack(config);
    const manualAuth = command === "dev:manual-auth";
    printSummary(config);
    runCompose(
      config,
      ["up", "--watch", "--remove-orphans", "postgres", "backend", "web"],
      manualAuth
        ? {
            AUTO_LOGIN_TEST_USER: "false",
            EXPO_PUBLIC_CALIBRATE_AUTO_LOGIN_TEST_USER: "false",
          }
        : {}
    );
    return;
  }
  if (command === "down") {
    runCompose(config, ["down", "--remove-orphans"]);
    return;
  }
  if (command === "status") {
    runCompose(config, ["ps"]);
    printSummary(config);
    return;
  }

  startDatabase(config);

  if (command === "db:migrate") {
    runDevEnvironmentTask(config, ["db:migrate"]);
  } else if (command === "db:reset") {
    runDevEnvironmentTask(config, ["db:reset"]);
  } else if (command === "db:seed") {
    runDevEnvironmentTask(config, ["db:seed"]);
  } else if (command === "db:migrate:create") {
    runDevEnvironmentTask(config, ["db:migrate:create", ...passthrough]);
  } else if (command === "db:studio") {
    runDevEnvironmentTask(config, ["db:studio", ...passthrough]);
  } else if (command === "ci") {
    runDevEnvironmentTask(config, ["ci"]);
  } else if (command === "reset-test-user") {
    run(process.execPath, [path.join(config.repoRoot, "scripts", "reset-test-user-onboarding.mjs")], {
      cwd: config.repoRoot,
      env: { ...process.env, BACKEND_PORT: String(config.backendPort) },
    });
  } else {
    printHelp();
    throw new Error(`Unknown development stack command: ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(`[dev-stack] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
