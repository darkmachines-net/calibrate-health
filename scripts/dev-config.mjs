/** @file Worktree-specific development configuration, stable ports, and allowlisted environment projection. */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WEB_PUSH_SUBJECT = "mailto:dev@calibrate.local";
const PORT_BANDS = {
  backend: 20_000,
  postgres: 30_000,
  web: 40_000,
};
const PORT_SLOTS = 10_000;

const DEV_ENV_FILENAME = ".dev.env";
const DEV_COMPOSE_FILENAME = "compose.dev.yaml";

/**
 * Convert a worktree name into a Docker-safe identifier.
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "calibrate-health";
}

/**
 * Return a stable short hash for worktree-local resources.
 * @param {string} value
 * @returns {string}
 */
export function stableHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Parse a dotenv file without executing it.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
export function readDotenv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Check whether a host TCP port can be bound.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Find one collision-free port from each service's disjoint band.
 * @param {number} startingOffset
 * @param {(port: number) => Promise<boolean>} portAvailable
 * @returns {Promise<{ backendPort: number, postgresPort: number, webPort: number }>}
 */
export async function allocatePorts(startingOffset, portAvailable = isPortAvailable) {
  for (let attempt = 0; attempt < PORT_SLOTS; attempt += 1) {
    const offset = (startingOffset + attempt) % PORT_SLOTS;
    const ports = {
      backendPort: PORT_BANDS.backend + offset,
      postgresPort: PORT_BANDS.postgres + offset,
      webPort: PORT_BANDS.web + offset,
    };
    const available = await Promise.all([
      portAvailable(ports.backendPort),
      portAvailable(ports.postgresPort),
      portAvailable(ports.webPort),
    ]);
    if (available.every(Boolean)) {
      return ports;
    }
  }

  throw new Error("Unable to allocate an available port set for this worktree.");
}

/**
 * Return a positive TCP port override or null.
 * @param {string | undefined} rawValue
 * @param {string} variableName
 * @returns {number | null}
 */
function parsePortOverride(rawValue, variableName) {
  if (!rawValue) {
    return null;
  }
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be a whole-number TCP port from 1 through 65535.`);
  }
  return port;
}

/**
 * Generate a URL-safe local secret.
 * @param {(size: number) => Buffer} randomBytes
 * @returns {string}
 */
function generateSecret(randomBytes) {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate VAPID keys without depending on the backend package install.
 * @returns {{ publicKey: string, privateKey: string }}
 */
function generateWebPushVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  if (!publicJwk.x || !publicJwk.y || !privateJwk.d) {
    throw new Error("Failed to export generated VAPID keys.");
  }

  const decode = (value) => Buffer.from(value, "base64url");
  return {
    publicKey: Buffer.concat([
      Buffer.from([0x04]),
      decode(publicJwk.x),
      decode(publicJwk.y),
    ]).toString("base64url"),
    privateKey: decode(privateJwk.d).toString("base64url"),
  };
}

/**
 * Normalize the configured food provider.
 * @param {string} value
 * @returns {string}
 */
function normalizeFoodProvider(value) {
  const normalized = value.trim().toLowerCase();
  return ["fatsecret", "openfoodfacts", "usda"].includes(normalized)
    ? normalized
    : "";
}

/**
 * Serialize generated environment values without exposing shell syntax.
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function serializeDotenv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n")}\n`;
}

/**
 * Persist a file atomically only when its content changed.
 * @param {string} filePath
 * @param {string} content
 */
function writeFileIfChanged(filePath, content) {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

/**
 * Resolve and optionally persist the current worktree's Compose configuration.
 * @param {{
 *   workspacePath?: string,
 *   environment?: NodeJS.ProcessEnv,
 *   portAvailable?: (port: number) => Promise<boolean>,
 *   randomBytes?: (size: number) => Buffer,
 *   persist?: boolean,
 * }} options
 */
export async function resolveDevConfig({
  workspacePath = defaultRepoRoot,
  environment = process.env,
  portAvailable = isPortAvailable,
  randomBytes = crypto.randomBytes,
  persist = true,
} = {}) {
  const repoRoot = fs.realpathSync(workspacePath);
  const repoEnv = readDotenv(path.join(repoRoot, ".env"));
  const devEnvPath = path.join(repoRoot, DEV_ENV_FILENAME);
  const existing = readDotenv(devEnvPath);
  const worktreeHash = stableHash(repoRoot);
  const canReuseGeneratedValues = existing.WORKTREE_HASH === worktreeHash;
  const readUserValue = (key) => environment[key] || repoEnv[key] || "";
  const readPersistentValue = (key) =>
    canReuseGeneratedValues && existing[key] ? existing[key] : "";

  const requestedPorts = {
    backendPort: parsePortOverride(
      readUserValue("CALIBRATE_DEV_BACKEND_PORT"),
      "CALIBRATE_DEV_BACKEND_PORT"
    ),
    postgresPort: parsePortOverride(
      readUserValue("CALIBRATE_DEV_POSTGRES_PORT"),
      "CALIBRATE_DEV_POSTGRES_PORT"
    ),
    webPort: parsePortOverride(
      readUserValue("CALIBRATE_DEV_WEB_PORT"),
      "CALIBRATE_DEV_WEB_PORT"
    ),
  };

  let ports;
  if (
    canReuseGeneratedValues &&
    !Object.values(requestedPorts).some((value) => value !== null)
  ) {
    ports = {
      backendPort: Number(existing.BACKEND_PORT),
      postgresPort: Number(existing.POSTGRES_PORT),
      webPort: Number(existing.WEB_PORT),
    };
  } else if (Object.values(requestedPorts).every((value) => value !== null)) {
    ports = requestedPorts;
  } else if (Object.values(requestedPorts).some((value) => value !== null)) {
    throw new Error(
      "Set all three CALIBRATE_DEV_BACKEND_PORT, CALIBRATE_DEV_POSTGRES_PORT, and CALIBRATE_DEV_WEB_PORT overrides together."
    );
  } else {
    const offset = Number.parseInt(worktreeHash, 16) % PORT_SLOTS;
    ports = await allocatePorts(offset, portAvailable);
  }

  const fatsecretClientId = readUserValue("FATSECRET_CLIENT_ID");
  const fatsecretClientSecret = readUserValue("FATSECRET_CLIENT_SECRET");
  const configuredUsdaApiKey = readUserValue("USDA_API_KEY");
  const explicitFoodProvider = normalizeFoodProvider(readUserValue("FOOD_DATA_PROVIDER"));
  const foodDataProvider =
    explicitFoodProvider ||
    (fatsecretClientId && fatsecretClientSecret ? "fatsecret" : "usda");
  const usdaApiKey =
    configuredUsdaApiKey || (foodDataProvider === "usda" ? "DEMO_KEY" : "");

  let webPushPublicKey =
    readUserValue("WEB_PUSH_PUBLIC_KEY") || readPersistentValue("WEB_PUSH_PUBLIC_KEY");
  let webPushPrivateKey =
    readUserValue("WEB_PUSH_PRIVATE_KEY") || readPersistentValue("WEB_PUSH_PRIVATE_KEY");
  if (!webPushPublicKey || !webPushPrivateKey) {
    const generated = generateWebPushVapidKeys();
    webPushPublicKey = generated.publicKey;
    webPushPrivateKey = generated.privateKey;
  }

  const projectSlug = `${slugify(path.basename(repoRoot))}-${worktreeHash}`;
  const postgresUser = readPersistentValue("POSTGRES_USER") || "calibrate";
  const postgresPassword =
    readPersistentValue("POSTGRES_PASSWORD") || generateSecret(randomBytes);
  const postgresDatabase = readPersistentValue("POSTGRES_DB") || "fitness_app";
  const sessionSecret =
    readPersistentValue("SESSION_SECRET") || generateSecret(randomBytes);
  const databaseCredentials =
    `${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}`;
  const databaseName = encodeURIComponent(postgresDatabase);

  const values = {
    WORKTREE_HASH: worktreeHash,
    COMPOSE_PROJECT_NAME: projectSlug,
    DEV_IMAGE_NAME: `${projectSlug}-dev`,
    BACKEND_PORT: ports.backendPort,
    POSTGRES_PORT: ports.postgresPort,
    WEB_PORT: ports.webPort,
    POSTGRES_USER: postgresUser,
    POSTGRES_PASSWORD: postgresPassword,
    POSTGRES_DB: postgresDatabase,
    SESSION_SECRET: sessionSecret,
    SESSION_COOKIE_NAME: `cal.${worktreeHash}.sid`,
    AUTO_LOGIN_TEST_USER: "true",
    EXPO_PUBLIC_CALIBRATE_AUTO_LOGIN_TEST_USER: "true",
    MCP_ENABLED: readUserValue("MCP_ENABLED") || "false",
    MCP_PUBLIC_URL:
      readUserValue("MCP_PUBLIC_URL") || `http://localhost:${ports.backendPort}/mcp`,
    FOOD_DATA_PROVIDER: foodDataProvider,
    ADMIN_USER_IDS: readUserValue("ADMIN_USER_IDS") || "",
    WEIGHT_TREND_MODEL: readUserValue("WEIGHT_TREND_MODEL") || "v2",
    FATSECRET_CLIENT_ID: fatsecretClientId,
    FATSECRET_CLIENT_SECRET: fatsecretClientSecret,
    USDA_API_KEY: usdaApiKey,
    WEB_PUSH_PUBLIC_KEY: webPushPublicKey,
    WEB_PUSH_PRIVATE_KEY: webPushPrivateKey,
    WEB_PUSH_SUBJECT:
      readUserValue("WEB_PUSH_SUBJECT") ||
      readPersistentValue("WEB_PUSH_SUBJECT") ||
      DEFAULT_WEB_PUSH_SUBJECT,
    NATIVE_PUSH_MODE: readUserValue("NATIVE_PUSH_MODE") || "disabled",
    EXPO_PUBLIC_EAS_PROJECT_ID: readUserValue("EXPO_PUBLIC_EAS_PROJECT_ID"),
    EXPO_UPDATES_CHANNEL: readUserValue("EXPO_UPDATES_CHANNEL"),
    REMINDER_SEND_LOCAL_HOUR: readUserValue("REMINDER_SEND_LOCAL_HOUR") || "9",
    REMINDER_JOB_INTERVAL_MINUTES:
      readUserValue("REMINDER_JOB_INTERVAL_MINUTES") || "15",
    CALIBRATE_DIAGNOSTICS_ENABLED:
      readUserValue("CALIBRATE_DIAGNOSTICS_ENABLED") || "false",
    CALIBRATE_DIAGNOSTICS_METRICS_TOKEN:
      readUserValue("CALIBRATE_DIAGNOSTICS_METRICS_TOKEN"),
    ALLOW_INSECURE_WEAR_PAIRING:
      readUserValue("ALLOW_INSECURE_WEAR_PAIRING") || "false",
  };

  if (persist) {
    writeFileIfChanged(
      devEnvPath,
      [
        "# Generated by scripts/dev-config.mjs. Do not commit or edit by hand.",
        serializeDotenv(values).trimEnd(),
        "",
      ].join("\n")
    );
  }

  return {
    ...values,
    backendPort: Number(values.BACKEND_PORT),
    postgresPort: Number(values.POSTGRES_PORT),
    webPort: Number(values.WEB_PORT),
    repoRoot,
    devEnvPath,
    composeFilePath: path.join(repoRoot, DEV_COMPOSE_FILENAME),
    hostDatabaseUrl:
      `postgresql://${databaseCredentials}@127.0.0.1:${values.POSTGRES_PORT}` +
      `/${databaseName}?schema=public`,
    internalDatabaseUrl:
      `postgresql://${databaseCredentials}@postgres:5432/${databaseName}?schema=public`,
  };
}
