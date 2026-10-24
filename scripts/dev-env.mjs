#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoEnvPath = path.join(repoRoot, ".env");
if (fs.existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

const backendRequire = createRequire(path.join(repoRoot, "backend", "package.json"));
const DEV_SEED_USER_EMAIL = "test@calibratehealth.app";
const DATABASE_WAIT_TIMEOUT_MS = 120_000;
const DATABASE_WAIT_RETRY_MS = 2_000;
const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const packageLockHashCache = new Map();
let cachedNpmVersion = null;

const packages = [
  {
    name: "mobile-workspace",
    directory: repoRoot,
    installArgs: ["ci", "--prefer-offline", "--no-audit", "--fund=false"],
    requiredPaths: [
      "node_modules/expo/package.json",
      "node_modules/@playwright/test/cli.js",
      "mobile/node_modules/expo-router/package.json",
    ],
  },
  {
    name: "backend",
    directory: path.join(repoRoot, "backend"),
    installArgs: ["ci", "--prefer-offline", "--no-audit", "--fund=false"],
    requiredPaths: [
      "node_modules/ts-node/package.json",
      "node_modules/prisma/package.json",
    ],
  },
];

/**
 * Resolve npm without asking Windows Node to spawn npm.cmd directly or through a shell.
 * @param {string} command
 * @param {string[]} args
 */
function resolveCommand(command, args) {
  if (command !== "npm") {
    return { command, args, shell: false };
  }

  const inheritedNpmCli = process.env.npm_execpath;
  const installedNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const npmCli = inheritedNpmCli || (fs.existsSync(installedNpmCli) ? installedNpmCli : "");
  if (npmCli) {
    return { command: process.execPath, args: [npmCli, ...args], shell: false };
  }

  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
      shell: false,
    };
  }
  return { command: "npm", args, shell: false };
}

/**
 * Run a subprocess and inherit its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} options
 */
function run(command, args, options = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    shell: resolved.shell,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}.`);
  }
}

/**
 * Run a subprocess asynchronously so independent package installs can overlap.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} options
 */
function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: options.cwd ?? repoRoot,
      stdio: "inherit",
      shell: resolved.shell,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${suffix}.`));
    });
  });
}

/**
 * Capture a command's combined output while keeping failures inspectable.
 * @param {string} command
 * @param {string[]} args
 */
function runCaptured(command, args) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: resolved.shell,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output) {
    process.stdout.write(output);
  }
  return { status: result.status ?? 1, output };
}

/**
 * Return captured stdout or an empty string.
 * @param {string} command
 * @param {string[]} args
 */
function readCommand(command, args) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: resolved.shell,
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : "";
}

function npmVersion() {
  if (cachedNpmVersion === null) {
    cachedNpmVersion = readCommand("npm", ["--version"]) || "unknown-npm";
  }
  return cachedNpmVersion;
}

/**
 * Time one visible development task.
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} task
 * @returns {Promise<T>}
 */
async function timed(label, task) {
  const startedAt = Date.now();
  console.log(`\n[dev-env] ${label}...`);
  try {
    return await task();
  } finally {
    console.log(`[dev-env] ${label} finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
}

function printDone(message) {
  console.log(`\n[dev-env] DONE: ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Hash package inputs and the host runtime used to install them.
 * @param {string} packageDirectory
 */
function packageLockHash(packageDirectory) {
  const cached = packageLockHashCache.get(packageDirectory);
  if (cached) {
    return cached;
  }

  const hash = crypto.createHash("sha256");
  for (const filename of ["package-lock.json", "package.json"]) {
    const filePath = path.join(packageDirectory, filename);
    if (fs.existsSync(filePath)) {
      hash.update(fs.readFileSync(filePath));
    }
  }
  hash.update(process.versions.node.split(".")[0]);
  hash.update(npmVersion().split(".")[0] || "unknown-npm");
  const digest = hash.digest("hex").slice(0, 16);
  packageLockHashCache.set(packageDirectory, digest);
  return digest;
}

function installSentinelPath(packageDirectory) {
  return path.join(packageDirectory, "node_modules", ".calibrate-install-complete.json");
}

function dependencyStatus(packageConfig) {
  for (const requiredPath of packageConfig.requiredPaths) {
    if (!fs.existsSync(path.join(packageConfig.directory, requiredPath))) {
      return { current: false, reason: `missing ${requiredPath}` };
    }
  }

  const sentinelPath = installSentinelPath(packageConfig.directory);
  if (!fs.existsSync(sentinelPath)) {
    return { current: false, reason: "no host install sentinel" };
  }

  try {
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, "utf8"));
    const expectedCommand = `npm ${packageConfig.installArgs.join(" ")}`;
    if (
      sentinel.package === packageConfig.name &&
      sentinel.lockHash === packageLockHash(packageConfig.directory) &&
      sentinel.installCommand === expectedCommand
    ) {
      return { current: true, reason: "host dependency cache hit" };
    }
    return { current: false, reason: "lockfile, runtime, or install command changed" };
  } catch {
    return { current: false, reason: "invalid host install sentinel" };
  }
}

function writeInstallSentinel(packageConfig) {
  const sentinelPath = installSentinelPath(packageConfig.directory);
  fs.writeFileSync(
    sentinelPath,
    `${JSON.stringify(
      {
        package: packageConfig.name,
        lockHash: packageLockHash(packageConfig.directory),
        installCommand: `npm ${packageConfig.installArgs.join(" ")}`,
        node: process.versions.node,
        npm: npmVersion(),
        installedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

async function ensurePackageDependencies(packageConfig) {
  const status = dependencyStatus(packageConfig);
  if (status.current) {
    console.log(`[dev-env] ${packageConfig.name} dependencies are current (${status.reason}).`);
    return;
  }

  console.log(`[dev-env] ${packageConfig.name} dependency cache miss: ${status.reason}.`);
  await runAsync("npm", packageConfig.installArgs, { cwd: packageConfig.directory });
  writeInstallSentinel(packageConfig);
}

async function ensureDependencies() {
  await timed("Install host dependencies", async () => {
    await Promise.all(
      packages.map((packageConfig) =>
        timed(`${packageConfig.name} dependencies`, () =>
          ensurePackageDependencies(packageConfig)
        )
      )
    );
  });
}

async function generatePrismaClient() {
  await timed("Generate Prisma client", () => run("npm", ["run", "prisma:generate"]));
}

async function ensurePlaywrightChromium() {
  await timed("Install Playwright Chromium", () =>
    run(process.execPath, [playwrightCli, "install", "chromium"])
  );
}

async function setupHost() {
  await ensureDependencies();
  await ensurePlaywrightChromium();
  await generatePrismaClient();
  printDone("Host dependencies, Playwright Chromium, and Prisma client are ready.");
}

function canConnectToDatabase(databaseUrl) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port || 5432),
      timeout: 3_000,
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForDatabase() {
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) {
    throw new Error("DATABASE_URL is required for worktree database commands.");
  }

  await timed("Wait for database", async () => {
    const databaseUrl = new URL(rawDatabaseUrl);
    const deadline = Date.now() + DATABASE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await canConnectToDatabase(databaseUrl)) {
        return;
      }
      await sleep(DATABASE_WAIT_RETRY_MS);
    }
    throw new Error(
      `Timed out waiting for database at ${databaseUrl.hostname}:${databaseUrl.port || 5432}.`
    );
  });
}

function runMigrateDeploy() {
  const result = runCaptured("npm", ["--prefix", "backend", "run", "db:migrate"]);
  if (result.status === 0) {
    return;
  }
  if (result.output.includes("P3005")) {
    console.error(
      [
        "",
        "[dev-env] Prisma found tables without migration history.",
        "[dev-env] Run `npm run dev:reset` to recreate this disposable worktree database.",
      ].join("\n")
    );
  }
  throw new Error(`Database migration exited with status ${result.status}.`);
}

async function isDevSeedPresent() {
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) {
    return false;
  }

  try {
    const { Client } = backendRequire("pg");
    const client = new Client({ connectionString: rawDatabaseUrl });
    await client.connect();
    try {
      const result = await client.query(
        `
          SELECT 1
          FROM "User" u
          WHERE u.email = $1
            AND EXISTS (SELECT 1 FROM "Goal" g WHERE g.user_id = u.id)
            AND EXISTS (SELECT 1 FROM "BodyMetric" m WHERE m.user_id = u.id)
            AND EXISTS (SELECT 1 FROM "FoodLog" f WHERE f.user_id = u.id)
          LIMIT 1
        `,
        [DEV_SEED_USER_EMAIL]
      );
      return result.rowCount > 0;
    } finally {
      await client.end();
    }
  } catch {
    return false;
  }
}

async function seedDatabase({ force = false } = {}) {
  if (!force && (await isDevSeedPresent())) {
    console.log("[dev-env] Dev seed data already exists; skipping seed.");
    return;
  }
  run("npm", ["--prefix", "backend", "run", "db:seed"]);
}

async function migrateDatabase() {
  await setupHost();
  await waitForDatabase();
  await timed("Migrate database", () => runMigrateDeploy());
  await timed("Seed database", () => seedDatabase());
  printDone("Database migrations are applied and seed data is ready.");
}

async function resetDatabase() {
  await setupHost();
  await waitForDatabase();
  await timed("Reset database", () =>
    run("npm", ["--prefix", "backend", "run", "db:reset", "--", "--force"])
  );
  await timed("Seed database", () => seedDatabase({ force: true }));
  printDone("Database was reset and seed data is ready.");
}

async function runDatabaseCommand(command, args = []) {
  await setupHost();
  await waitForDatabase();
  run("npm", ["--prefix", "backend", "run", command, ...(args.length ? ["--", ...args] : [])]);
}

async function ci() {
  await setupHost();
  await timed("Lint with zero warnings", () => {
    run("npm", ["run", "test:lint"]);
    run("node", ["--test", "scripts/ci-test-gate.test.mjs"]);
    run("npm", ["run", "lint:eslint"]);
  });
  await timed("Validate release configuration", () => {
    run("npm", ["run", "release:check"]);
    run("npm", ["run", "test:release"]);
    run("npm", ["run", "test:native-release"]);
    run("npm", ["run", "test:dev-script"]);
    run("npm", ["run", "test:wear:emulator:unit"]);
    run("npm", ["run", "test:db:upgrade:unit"]);
    run("npm", ["run", "test:deploy"]);
    run("npm", ["run", "api:contract:check"]);
    run("npm", ["run", "test:db:upgrade"]);
    run("npm", ["run", "test:weight-trend:postgres"]);
  });
  await timed("Build backend", () => run("npm", ["--prefix", "backend", "run", "build"]));
  await timed("Build Expo web", () => {
    run("npm", ["run", process.platform === "win32" ? "test:ux" : "test:ux:a11y"]);
    run("npm", ["run", "test:expo-web:release"]);
  });
  await timed("Type-check mobile", () =>
    run("npm", ["--prefix", "mobile", "run", "typecheck"])
  );
  await timed("Type-check API client", () =>
    run("npm", ["--prefix", "packages/api-client", "run", "typecheck"])
  );
  await timed("Run backend tests", () => run("npm", ["--prefix", "backend", "test"]));
  await timed("Run mobile tests", () =>
    run("npm", ["--prefix", "mobile", "test", "--", "--runInBand"])
  );
  printDone("Full local CI passed.");
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/dev-env.mjs <command>",
      "",
      "Commands:",
      "  deps                  Install host dependencies when needed.",
      "  setup:host            Install host deps and generate Prisma.",
      "  db:migrate            Apply migrations and seed.",
      "  db:migrate:create     Create a Prisma development migration.",
      "  db:reset              Reset and reseed the database.",
      "  db:seed               Seed the database.",
      "  db:studio             Run Prisma Studio.",
      "  ci                    Run the local equivalent of PR CI.",
    ].join("\n")
  );
}

const command = process.argv[2];
const passthrough = process.argv.slice(3);

try {
  if (!command || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "deps") {
    await ensureDependencies();
    printDone("Host dependencies are ready.");
  } else if (command === "setup:host") {
    await setupHost();
  } else if (command === "db:migrate") {
    await migrateDatabase();
  } else if (command === "db:migrate:create") {
    await runDatabaseCommand("db:migrate:dev", passthrough);
  } else if (command === "db:reset") {
    await resetDatabase();
  } else if (command === "db:seed") {
    await runDatabaseCommand("db:seed");
  } else if (command === "db:studio") {
    await runDatabaseCommand("db:studio", passthrough);
  } else if (command === "ci") {
    await ci();
  } else {
    printHelp();
    throw new Error(`Unknown host development command: ${command}`);
  }
} catch (error) {
  console.error(`[dev-env] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
