#!/usr/bin/env node
/** @file Native Expo development bundler startup with validated platform and worktree backend configuration. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExpoCliEnvironment } from "./expo-cli-environment.mjs";
import { readDotenv, resolveDevConfig } from "./dev-config.mjs";

const NATIVE_PLATFORMS = new Set(["android", "ios"]);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

/** Parses the native Expo platform option and rejects unsupported or unknown arguments. */
export function parseExpoNativeDevArgs(argv) {
  let platform = "android";
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--platform" && option !== "-p") {
      throw new Error(`Unknown native Expo option: ${option}`);
    }
    const value = argv[index + 1]?.trim().toLowerCase();
    if (!value || !NATIVE_PLATFORMS.has(value)) {
      throw new Error("--platform must be android or ios.");
    }
    platform = value;
    index += 1;
  }
  return { platform };
}

/**
 * Resolve the selected simulator's URL for the backend exposed by this worktree.
 * @param {{
 *   repoRoot: string,
 *   backendPort: number,
 *   platform?: "android" | "ios",
 *   environment?: NodeJS.ProcessEnv,
 * }} options
 */
export function resolveExpoNativeBackendUrl({
  repoRoot,
  backendPort,
  platform = "android",
  environment = process.env,
}) {
  if (!NATIVE_PLATFORMS.has(platform)) {
    throw new Error("Native Expo platform must be android or ios.");
  }
  const repoEnvironment = readDotenv(path.join(repoRoot, ".env"));
  const simulatorHost = platform === "ios" ? "127.0.0.1" : "10.0.2.2";
  return (
    environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL?.trim() ||
    repoEnvironment.EXPO_PUBLIC_CALIBRATE_SERVER_URL?.trim() ||
    `http://${simulatorHost}:${backendPort}`
  );
}

/**
 * Resolve npm's JavaScript CLI so Windows does not need a shell wrapper.
 */
function resolveNpmCommand() {
  const inheritedNpmCli = process.env.npm_execpath;
  const installedNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const npmCli =
    inheritedNpmCli || (fs.existsSync(installedNpmCli) ? installedNpmCli : "");
  if (!npmCli) {
    throw new Error("Unable to locate npm. Run this command through `npm run dev:expo`.");
  }
  return { command: process.execPath, args: [npmCli] };
}

/** Resolves the worktree backend and starts the platform-specific Expo development client workflow. */
export async function main() {
  const { platform } = parseExpoNativeDevArgs(process.argv.slice(2));
  const repoRoot = path.resolve(process.env.CODEX_WORKTREE_PATH || defaultRepoRoot);
  const config = await resolveDevConfig({ workspacePath: repoRoot });
  const backendUrl = resolveExpoNativeBackendUrl({
    repoRoot,
    backendPort: config.backendPort,
    platform,
  });
  const npm = resolveNpmCommand();

  console.log(`[expo-native:${platform}] API: ${backendUrl}`);
  console.log(`[expo-native:${platform}] Start \`npm run dev\` separately if the Compose stack is not running.`);

  const result = spawnSync(
    npm.command,
    [...npm.args, "--prefix", "mobile", "run", "dev"],
    {
      cwd: repoRoot,
      env: createExpoCliEnvironment(repoRoot, {
        ...process.env,
        EXPO_PUBLIC_CALIBRATE_SERVER_URL: backendUrl,
      }),
      stdio: "inherit",
      shell: false,
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Expo ${platform} session exited with status ${result.status ?? 1}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(`[expo-native] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
