import type { PoolConfig } from 'pg';

type PgSslConfig = PoolConfig['ssl'];

type PgConnectionConfig = Pick<PoolConfig, 'host' | 'port' | 'database' | 'user' | 'password'>;

/**
 * Resolve the Prisma/pg connection string for the current runtime.
 *
 * Local development prefers `DATABASE_URL` directly (via `.env`). For hosted
 * runtimes we often inject DB components (host/user/password/name) as
 * separate environment variables, so we can compose a URL without storing the
 * full connection string as a secret.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const directUrl = env.DATABASE_URL;
  if (directUrl) return directUrl;

  const host = env.DB_SOCKET_DIR ? 'localhost' : env.DB_HOST;
  const port = env.DB_PORT ?? '5432';
  const dbName = env.DB_NAME;
  const username = env.DB_USER ?? env.DB_USERNAME;
  const password = env.DB_PASSWORD ?? env.DB_PASS;
  const sslmode = env.DB_SSLMODE ?? 'require';
  const schema = env.DB_SCHEMA ?? 'public';

  if (!host || !dbName || !username || !password) {
    const missing: string[] = [];
    if (!host) missing.push('DB_HOST');
    if (!dbName) missing.push('DB_NAME');
    if (!username) missing.push('DB_USER');
    if (!password) missing.push('DB_PASSWORD');

    throw new Error(
      `DATABASE_URL is not set and could not be composed (missing: ${missing.join(', ')}).`
    );
  }

  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  const encodedDbName = encodeURIComponent(dbName);
  const encodedSchema = encodeURIComponent(schema);
  const encodedSslMode = encodeURIComponent(sslmode);

  return `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${encodedDbName}?schema=${encodedSchema}&sslmode=${encodedSslMode}`;
}

/**
 * Resolve the Prisma schema name for the current connection.
 *
 * Prisma models live in a specific Postgres schema selected via the `schema` query param
 * (or DB_SCHEMA when we compose DATABASE_URL). When using driver adapters we need to pass
 * the schema explicitly to the adapter; it is not derived from the pg Pool config.
 */
export function resolvePrismaSchema(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const envSchemaRaw = env.DB_SCHEMA?.trim();
  const envSchema = envSchemaRaw ? envSchemaRaw : undefined;

  let urlSchema: string | undefined;
  try {
    urlSchema = new URL(databaseUrl).searchParams.get('schema')?.trim() || undefined;
  } catch {
    urlSchema = undefined;
  }

  if (urlSchema && envSchema && urlSchema !== envSchema) {
    console.warn(
      `DATABASE_URL schema (${urlSchema}) does not match DB_SCHEMA (${envSchema}); using DATABASE_URL value.`
    );
  }

  return urlSchema ?? envSchema;
}

const PG_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Quote a Postgres identifier for use in settings like search_path.
 */
function quotePgIdentifier(identifier: string): string {
  if (PG_IDENTIFIER_PATTERN.test(identifier)) return identifier;
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Configure node-postgres so raw SQL helpers (e.g. session store) resolve tables in the same schema as Prisma.
 */
export function buildPgOptionsForSchema(schema: string | undefined): Pick<PoolConfig, 'options'> {
  if (!schema) return {};

  const primarySchema = quotePgIdentifier(schema);
  const searchPath = schema === 'public' ? 'public' : `${primarySchema},public`;
  return { options: `-c search_path=${searchPath}` };
}

/**
 * Parse a Postgres connection string into discrete node-postgres connection fields.
 *
 * We intentionally avoid passing `connectionString` to node-postgres because query params like
 * `sslmode=require` overwrite the explicit `ssl` config we need for managed Postgres compatibility.
 *
 * Note: Query params are not forwarded to pg (except via explicit config elsewhere). For Prisma,
 * the `schema` param is handled separately via the adapter options (see resolvePrismaSchema) and
 * by setting pg search_path for raw SQL helpers (see buildPgOptionsForSchema).
 */
export function parseDatabaseUrlToPgConfig(databaseUrl: string): PgConnectionConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DATABASE_URL is not a valid URL (${message}).`, { cause: error });
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must use the postgres protocol (received "${url.protocol}").`);
  }

  const host = url.hostname;
  const port = url.port ? Number.parseInt(url.port, 10) : undefined;
  const databasePath = url.pathname.replace(/^\/+/, '');

  return {
    host: host || undefined,
    port: port && Number.isFinite(port) ? port : undefined,
    database: databasePath ? decodeURIComponent(databasePath) : undefined,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  };
}

/**
 * Translate Postgres `sslmode` values into node-postgres SSL options.
 *
 * libpq treats `sslmode=require` as "encrypt the connection, but do not verify
 * certificates". node-postgres verifies by default when SSL is enabled, which
 * can fail against managed Postgres unless you provide the provider CA bundle. For `require` we
 * intentionally disable verification to match libpq semantics.
 */
function resolveSslMode(databaseUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  let values: string[];
  if (env.DB_SSLMODE !== undefined) {
    values = [env.DB_SSLMODE];
  } else {
    try {
      values = new URL(databaseUrl).searchParams.getAll('sslmode');
    } catch {
      return undefined;
    }
  }
  const modes = values.map((value) => value.trim().toLowerCase());
  if (modes.some((mode) => !mode)) {
    throw new Error('DB_SSLMODE / sslmode must not be blank; omit it or specify an explicit SSL mode.');
  }
  const supportedModes = ['disable', 'require', 'verify-ca', 'verify-full', 'prefer', 'allow'];
  if (modes.some((mode) => !supportedModes.includes(mode))) {
    throw new Error(`DB_SSLMODE / sslmode must be one of: ${supportedModes.join(', ')}.`);
  }
  if (modes.some((mode) => mode !== modes[0])) {
    throw new Error('Conflicting sslmode URL settings.');
  }
  return modes[0];
}

export function resolvePgSslConfig(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env
): PgSslConfig | undefined {
  const sslmode = resolveSslMode(databaseUrl, env);
  if (sslmode === undefined) return undefined;
  if (sslmode === 'disable') return false;

  if (sslmode === 'require') {
    return { rejectUnauthorized: false };
  }

  // For verify-ca/verify-full/etc, fall back to pg's default verification behavior.
  return true;
}

/** One allowlisted connection contract for the shared pg pool and Prisma CLI. */
export function resolveDatabaseConnection(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  schema: string | undefined;
  poolConfig: PoolConfig;
} {
  const socket = env.DB_SOCKET_DIR;
  // eslint-disable-next-line no-control-regex -- Socket paths must reject NUL and line breaks.
  if (socket !== undefined && (!socket.startsWith('/') || socket.trim() !== socket || /[\x00\r\n\\]/.test(socket))) {
    throw new Error('DB_SOCKET_DIR must be an absolute POSIX socket directory.');
  }
  const databaseUrl = resolveDatabaseUrl(env);
  const fields = parseDatabaseUrlToPgConfig(databaseUrl);
  const url = new URL(databaseUrl);
  const schema = resolvePrismaSchema(databaseUrl, env);
  const ssl = resolvePgSslConfig(databaseUrl, env);
  const poolConfig: PoolConfig = { ...fields, ssl, ...buildPgOptionsForSchema(schema) };
  if (schema) url.searchParams.set('schema', schema);
  const sslmode = resolveSslMode(databaseUrl, env);
  if (sslmode !== undefined) url.searchParams.set('sslmode', sslmode);

  // Seconds keep Prisma's integer URL settings and pg's millisecond settings exact.
  const settings = [
    { env: 'DB_POOL_MAX', params: ['connection_limit'], key: 'max', limit: 100, scale: 1 },
    { env: 'DB_POOL_ACQUIRE_TIMEOUT_SECONDS', params: ['pool_timeout', 'connect_timeout'], key: 'connectionTimeoutMillis', limit: 300, scale: 1000 },
    { env: 'DB_POOL_IDLE_TIMEOUT_SECONDS', params: ['max_idle_connection_lifetime'], key: 'idleTimeoutMillis', limit: 3600, scale: 1000 }
  ] as const;
  for (const setting of settings) {
    const values = [env[setting.env], ...setting.params.flatMap((param) => url.searchParams.getAll(param))]
      .filter((value): value is string => value !== undefined);
    if (!values.length) continue;
    const numbers = values.map((value) => {
      const number = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > setting.limit) {
        throw new Error(`${setting.env} / ${setting.params.join(', ')} must be an integer from 1 to ${setting.limit}.`);
      }
      return number;
    });
    if (numbers.some((number) => number !== numbers[0])) {
      throw new Error(`Conflicting ${setting.env} / ${setting.params.join(', ')} settings.`);
    }
    poolConfig[setting.key] = numbers[0] * setting.scale;
    for (const param of setting.params) url.searchParams.set(param, String(numbers[0]));
  }

  const urlHosts = url.searchParams.getAll('host');
  if (socket !== undefined) {
    if ((!env.DATABASE_URL && env.DB_HOST) || fields.host !== 'localhost' || urlHosts.some((host) => host !== socket)) {
      throw new Error('DB_SOCKET_DIR conflicts with TCP host or DATABASE_URL host; use localhost as the socket URL placeholder.');
    }
    if (ssl !== false) {
      throw new Error('DB_SOCKET_DIR requires explicit sslmode=disable (or DB_SSLMODE=disable); transport security belongs to the socket provider.');
    }
    poolConfig.host = socket;
    url.searchParams.set('host', socket);
  } else if (urlHosts.length || decodeURIComponent(fields.host ?? '').startsWith('/')) {
    throw new Error('Socket/query host requires explicit DB_SOCKET_DIR opt-in. Use the URL authority for TCP.');
  }

  return { url: url.toString(), schema, poolConfig };
}

/** Schema-only commands remain usable without any live database credentials. */
export function resolvePrismaCliUrl(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): string {
  const schemaOnly = argv.some((arg) => ['generate', 'format', 'validate'].includes(arg.toLowerCase()));
  if (!env.DATABASE_URL && schemaOnly) {
    return 'postgresql://postgres:postgres@localhost:5432/postgres?schema=public';
  }
  return resolveDatabaseConnection(env).url;
}
