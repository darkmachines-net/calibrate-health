/** @file Regression coverage for database utils: resolveDatabaseUrl prefers DATABASE_URL when present. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDatabaseUrl,
  resolvePrismaSchema,
  buildPgOptionsForSchema,
  parseDatabaseUrlToPgConfig,
  resolvePgSslConfig,
  resolveDatabaseConnection,
  resolvePrismaCliUrl
} = require('../src/config/databaseUtils');

test('resolveDatabaseUrl prefers DATABASE_URL when present', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/app?schema=public&sslmode=require'
  };

  assert.equal(resolveDatabaseUrl(env), env.DATABASE_URL);
});

test('resolveDatabaseUrl composes from DB_* variables and encodes values', () => {
  const env = {
    DB_HOST: 'db.example.com',
    DB_PORT: '5434',
    DB_NAME: 'calorie tracker',
    DB_USER: 'user@name',
    DB_PASSWORD: 'p@ss word',
    DB_SSLMODE: 'verify-full',
    DB_SCHEMA: 'health-data'
  };

  const expected =
    'postgresql://user%40name:p%40ss%20word@db.example.com:5434/calorie%20tracker?schema=health-data&sslmode=verify-full';

  assert.equal(resolveDatabaseUrl(env), expected);
});

test('resolveDatabaseUrl throws when required DB_* values are missing', () => {
  assert.throws(
    () => resolveDatabaseUrl({ DB_HOST: 'db.internal' }),
    /missing: DB_NAME, DB_USER, DB_PASSWORD/
  );
});

test('resolvePrismaSchema prefers the URL schema and warns on mismatch', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);

  try {
    const schema = resolvePrismaSchema('postgresql://user:pass@localhost:5432/app?schema=private', {
      DB_SCHEMA: 'public'
    });

    assert.equal(schema, 'private');
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /DATABASE_URL schema \(private\) does not match DB_SCHEMA \(public\); using DATABASE_URL value\./
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('resolvePrismaSchema falls back to DB_SCHEMA when URL is invalid', () => {
  const schema = resolvePrismaSchema('not-a-url', { DB_SCHEMA: 'private' });
  assert.equal(schema, 'private');
});

test('buildPgOptionsForSchema returns search_path config with quoting', () => {
  assert.deepEqual(buildPgOptionsForSchema(undefined), {});
  assert.deepEqual(buildPgOptionsForSchema('public'), { options: '-c search_path=public' });
  assert.deepEqual(buildPgOptionsForSchema('app_data'), { options: '-c search_path=app_data,public' });
  assert.deepEqual(buildPgOptionsForSchema('app-data'), { options: '-c search_path="app-data",public' });
});

test('parseDatabaseUrlToPgConfig decodes URL components', () => {
  const config = parseDatabaseUrlToPgConfig('postgresql://user:p%40ss@localhost:5433/app_db');

  assert.deepEqual(config, {
    host: 'localhost',
    port: 5433,
    database: 'app_db',
    user: 'user',
    password: 'p@ss'
  });
});

test('parseDatabaseUrlToPgConfig rejects invalid URLs or protocols', () => {
  assert.throws(
    () => parseDatabaseUrlToPgConfig('not-a-url'),
    /DATABASE_URL is not a valid URL/
  );
  assert.throws(
    () => parseDatabaseUrlToPgConfig('mysql://user:pass@localhost:5432/app'),
    /DATABASE_URL must use the postgres protocol/
  );
});

test('resolvePgSslConfig maps sslmode values', () => {
  assert.equal(resolvePgSslConfig('postgresql://localhost/app', { DB_SSLMODE: 'disable' }), false);
  assert.deepEqual(resolvePgSslConfig('postgresql://localhost/app', { DB_SSLMODE: 'require' }), {
    rejectUnauthorized: false
  });
  assert.equal(resolvePgSslConfig('postgresql://localhost/app', { DB_SSLMODE: 'verify-full' }), true);
  assert.deepEqual(
    resolvePgSslConfig('postgresql://localhost/app?sslmode=require', {}),
    { rejectUnauthorized: false }
  );
  assert.equal(resolvePgSslConfig('postgresql://localhost/app', {}), undefined);
});

const tcpEnv = { DATABASE_URL: 'postgresql://user:p%40ss@localhost:5433/app?schema=private&sslmode=verify-full' };

test('blank SSL values cannot silently weaken URL TLS in runtime or CLI', () => {
  for (const blank of ['', ' ', '\t\r\n']) {
    const env = { ...tcpEnv, DB_SSLMODE: blank, PGSSLMODE: 'verify-full' };
    assert.throws(() => resolvePgSslConfig(env.DATABASE_URL, env), /must not be blank/);
    assert.throws(() => resolveDatabaseConnection(env), /must not be blank/);
    assert.throws(() => resolvePrismaCliUrl(env, ['migrate', 'deploy']), /must not be blank/);
    assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: `postgresql://localhost/app?sslmode=${encodeURIComponent(blank)}` }), /must not be blank/);
    assert.throws(() => resolveDatabaseConnection({ DB_HOST: 'localhost', DB_NAME: 'app', DB_USER: 'user', DB_PASS: 'pass', DB_SSLMODE: blank }), /must not be blank/);
  }
});

test('explicit SSL modes keep precedence and normalize identically for runtime and CLI', () => {
  const modes = { disable: false, require: { rejectUnauthorized: false }, 'verify-ca': true, 'verify-full': true, prefer: true, allow: true };
  for (const [mode, ssl] of Object.entries(modes)) {
    for (const urlMode of [undefined, ...Object.keys(modes)]) {
      const DATABASE_URL = `postgresql://localhost/app${urlMode ? `?sslmode=${urlMode}` : ''}`;
      const env = { DATABASE_URL, DB_SSLMODE: ` ${mode.toUpperCase()} ` };
      const resolved = resolveDatabaseConnection(env);
      assert.deepEqual(resolved.poolConfig.ssl, ssl);
      assert.equal(new URL(resolvePrismaCliUrl(env, ['migrate'])).searchParams.get('sslmode'), mode);
    }
    const urlOnly = resolveDatabaseConnection({ DATABASE_URL: `postgresql://localhost/app?sslmode=${encodeURIComponent(` ${mode.toUpperCase()} `)}` });
    assert.deepEqual(urlOnly.poolConfig.ssl, ssl);
    assert.equal(new URL(urlOnly.url).searchParams.get('sslmode'), mode);
  }
  assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: 'postgresql://localhost/app?sslmode=verify-full&sslmode=disable' }), /Conflicting sslmode/);
  assert.equal(new URL(resolveDatabaseConnection({ DATABASE_URL: 'postgresql://localhost/app?sslmode=VERIFY-FULL&sslmode=verify-full' }).url).searchParams.getAll('sslmode').length, 1);
  assert.equal(resolveDatabaseConnection({ DATABASE_URL: 'postgresql://localhost/app' }).poolConfig.ssl, undefined);
  for (const mode of ['verifyfull', 'false', '0']) {
    assert.throws(() => resolveDatabaseConnection({ ...tcpEnv, DB_SSLMODE: mode }), /must be one of/);
    assert.throws(() => resolvePrismaCliUrl({ DATABASE_URL: `postgresql://localhost/app?sslmode=${mode}` }, ['migrate']), /must be one of/);
  }
  assert.throws(() => resolveDatabaseConnection({ ...tcpEnv, DB_SOCKET_DIR: '/socket', DB_SSLMODE: ' ' }), /must not be blank/);
});

test('shared configuration preserves TCP, schema, SSL and unset pg defaults', () => {
  const { poolConfig, schema, url } = resolveDatabaseConnection(tcpEnv);
  assert.deepEqual(poolConfig, {
    host: 'localhost', port: 5433, database: 'app', user: 'user', password: 'p@ss',
    ssl: true, options: '-c search_path=private,public'
  });
  assert.equal(schema, 'private');
  assert.equal(resolvePrismaCliUrl(tcpEnv, ['migrate', 'deploy']), url);
  const config = resolveDatabaseConnection({ DATABASE_URL: 'postgresql://localhost/app?arbitrary=ignored' });
  assert.equal(config.poolConfig.arbitrary, undefined);
  assert.equal(config.poolConfig.connectionString, undefined);
});

test('bounded opt-in settings have equivalent runtime milliseconds and CLI seconds', () => {
  const env = { ...tcpEnv, DB_POOL_MAX: '3', DB_POOL_ACQUIRE_TIMEOUT_SECONDS: '5', DB_POOL_IDLE_TIMEOUT_SECONDS: '30' };
  const { poolConfig, url } = resolveDatabaseConnection(env);
  assert.equal(poolConfig.max, 3);
  assert.equal(poolConfig.connectionTimeoutMillis, 5000);
  assert.equal(poolConfig.idleTimeoutMillis, 30000);
  const params = new URL(resolvePrismaCliUrl(env, ['migrate', 'deploy'])).searchParams;
  assert.equal(params.get('connection_limit'), '3');
  assert.equal(params.get('pool_timeout'), '5');
  assert.equal(params.get('connect_timeout'), '5');
  assert.equal(params.get('max_idle_connection_lifetime'), '30');
  assert.deepEqual(resolveDatabaseConnection({ DATABASE_URL: url }).poolConfig, poolConfig);
});

test('pool settings reject invalid numbers and contradictory sources without echoing secrets', () => {
  for (const [key, param, limit] of [
    ['DB_POOL_MAX', 'connection_limit', 100],
    ['DB_POOL_ACQUIRE_TIMEOUT_SECONDS', 'pool_timeout', 300],
    ['DB_POOL_IDLE_TIMEOUT_SECONDS', 'max_idle_connection_lifetime', 3600]
  ]) {
    for (const value of ['', ' ', '0', '-1', '1.5', 'Infinity', 'NaN', '1e2', '3junk', String(limit + 1)]) {
      assert.throws(() => resolveDatabaseConnection({ ...tcpEnv, [key]: value }), /must be an integer/);
      assert.throws(() => resolvePrismaCliUrl({ DATABASE_URL: `${tcpEnv.DATABASE_URL}&${param}=${value}` }, ['migrate']), /must be an integer/);
    }
    for (const value of ['1', String(limit)]) assert.doesNotThrow(() => resolveDatabaseConnection({ ...tcpEnv, [key]: value }));
    assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: `${tcpEnv.DATABASE_URL}&${param}=2`, [key]: '3' }), /Conflicting/);
    assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: `${tcpEnv.DATABASE_URL}&${param}=2&${param}=3` }), /Conflicting/);
  }
  assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: `${tcpEnv.DATABASE_URL}&pool_timeout=2&connect_timeout=3` }), /Conflicting/);
});

test('socket opt-in shares escaped credentials, schema and socket path with CLI', () => {
  const env = { DB_SOCKET_DIR: '/cloudsql/example:region:db', DB_NAME: 'app db', DB_USERNAME: 'user@name', DB_PASS: 'p@ss:/?#', DB_SCHEMA: 'app-data', DB_SSLMODE: 'disable' };
  const { poolConfig, url, schema } = resolveDatabaseConnection(env);
  assert.equal(poolConfig.host, env.DB_SOCKET_DIR);
  assert.equal(poolConfig.password, env.DB_PASS);
  assert.equal(poolConfig.user, env.DB_USERNAME);
  assert.equal(poolConfig.database, env.DB_NAME);
  assert.equal(poolConfig.ssl, false);
  assert.equal(schema, 'app-data');
  assert.equal(new URL(url).searchParams.get('host'), env.DB_SOCKET_DIR);
  assert.equal(resolvePrismaCliUrl(env, ['migrate', 'deploy']), url);
  assert.deepEqual(resolveDatabaseConnection({ DATABASE_URL: url, DB_SOCKET_DIR: env.DB_SOCKET_DIR }).poolConfig, poolConfig);
  for (const override of [{ DB_HOST: 'tcp' }, { DB_SOCKET_DIR: 'relative' }, { DB_SOCKET_DIR: '' }, { DB_SSLMODE: 'verify-full' }]) {
    assert.throws(() => resolveDatabaseConnection({ ...env, ...override }), /DB_SOCKET_DIR/);
  }
  assert.throws(() => resolveDatabaseConnection({ DATABASE_URL: url }), /DB_SOCKET_DIR/);
  assert.throws(() => resolveDatabaseConnection({ ...env, DATABASE_URL: tcpEnv.DATABASE_URL.replace('localhost', 'remote') }), /conflicts/);
  assert.throws(() => resolveDatabaseConnection({ ...env, DATABASE_URL: `${url}&host=/different` }), /conflicts/);
});

test('CLI honors existing direct URL precedence, schema fallback and explicit SSL override', () => {
  const env = { DATABASE_URL: 'postgresql://direct:secret@localhost/app', DB_HOST: 'ignored', DB_NAME: 'ignored', DB_USER: 'ignored', DB_SCHEMA: 'private', DB_SSLMODE: 'verify-full' };
  const { poolConfig, url } = resolveDatabaseConnection(env);
  assert.equal(poolConfig.user, 'direct');
  assert.equal(poolConfig.database, 'app');
  assert.equal(poolConfig.ssl, true);
  assert.equal(new URL(url).searchParams.get('schema'), 'private');
  assert.equal(new URL(url).searchParams.get('sslmode'), 'verify-full');
  for (const command of ['generate', 'format', 'validate']) {
    assert.match(resolvePrismaCliUrl({ DB_POOL_MAX: 'invalid' }, [command]), /localhost:5432\/postgres/);
  }
  assert.throws(() => resolvePrismaCliUrl({}, ['migrate', 'deploy']), /missing:/);
});

test('actual Prisma config entrypoint matches runtime settings and supports credential-free generation', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(DB_|DATABASE_URL$|DOTENV_)/i.test(key)));
  const scenarios = [
    { ...tcpEnv, DB_POOL_MAX: '3', DB_POOL_ACQUIRE_TIMEOUT_SECONDS: '5', DB_POOL_IDLE_TIMEOUT_SECONDS: '30' },
    { DB_SOCKET_DIR: '/cloudsql/example:region:db', DB_NAME: 'app', DB_USER: 'user', DB_PASS: 'p@ss', DB_SSLMODE: 'disable' },
    {},
    ...['disable', 'require', 'verify-ca', 'verify-full', 'prefer', 'allow'].map((mode) => ({ ...tcpEnv, DB_SSLMODE: ` ${mode.toUpperCase()} ` }))
  ];
  for (const env of scenarios) {
    const args = Object.keys(env).length ? ['migrate', 'deploy'] : ['generate'];
    const script = `process.argv = ${JSON.stringify(['node', 'prisma', ...args])}; console.log(JSON.stringify(require('./prisma.config').default.datasource));`;
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...baseEnv, ...env, DOTENV_CONFIG_PATH: path.join(__dirname, 'nonexistent-synthetic.env') }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).url, resolvePrismaCliUrl(env, args));
  }
  for (const blank of ['', ' \t']) {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', "process.argv = ['node', 'prisma', 'migrate', 'deploy']; require('./prisma.config');"], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...baseEnv, ...tcpEnv, DB_SSLMODE: blank, PGSSLMODE: 'verify-full', DOTENV_CONFIG_PATH: path.join(__dirname, 'nonexistent-synthetic.env') }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be blank/);
  }
});
