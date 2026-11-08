#!/usr/bin/env node
/** @file Start the isolated Expo development client with the current worktree backend and public native OAuth configuration. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { developmentServer } from "@mchartier/expo-release/development";
import { createExpoCliEnvironment } from "./expo-cli-environment.mjs";
import { readDotenv, resolveDevConfig } from "./dev-config.mjs";

const NATIVE_PLATFORMS = new Set(["android", "ios"]);
const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");

/** Parse the simulator backend and shared Metro connection options; the toolkit validates ports and LAN hosts. */
export function parseExpoNativeDevArgs(argv) {
  let platform = "android";
  const connection = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--clear" || option === "--web") {
      connection[option.slice(2)] = true;
      continue;
    }
    if (option === "--port" || option === "--host") {
      const value = argv[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
      connection[option.slice(2)] = value;
      continue;
    }
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
  return { platform, ...connection };
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

/** Resolve the local API and start Metro with the toolkit's development identity and credential-free environment. */
export async function main() {
  const { platform, ...connection } = parseExpoNativeDevArgs(process.argv.slice(2));
  const repoRoot = path.resolve(process.env.CODEX_WORKTREE_PATH || defaultRepoRoot);
  const config = await resolveDevConfig({ workspacePath: repoRoot });
  const backendUrl = resolveExpoNativeBackendUrl({
    repoRoot,
    backendPort: config.backendPort,
    platform,
  });
  const server = developmentServer(repoRoot, {
    ...connection,
    publicEnvironment: {
      EXPO_PUBLIC_CALIBRATE_SERVER_URL: backendUrl,
      ...resolveNativeOAuthEnvironment(repoRoot),
    },
  });

  console.log(`[expo-native:${platform}] API: ${backendUrl}`);
  console.log(`[expo-native:${platform}] Start \`npm run dev\` separately if the Compose stack is not running.`);

  const result = spawnSync(
    server.command,
    server.args,
    {
      cwd: server.cwd,
      env: createExpoCliEnvironment(repoRoot, server.env),
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

/** Forward only public OAuth client IDs, preferring host values over root .env for local native builds. */
export function resolveNativeOAuthEnvironment(repoRoot, environment = process.env) {
  const repoEnvironment = readDotenv(path.join(repoRoot, ".env"));
  const values = {};
  for (const key of ["EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID", "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", "EXPO_PUBLIC_GOOGLE_IOS_DEVELOPMENT_CLIENT_ID"]) {
    const value = environment[key]?.trim() || repoEnvironment[key]?.trim();
    if (value) values[key] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(`[expo-native] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
