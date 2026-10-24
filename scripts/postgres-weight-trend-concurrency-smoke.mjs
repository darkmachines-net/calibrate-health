#!/usr/bin/env node
/** @file postgres weight trend concurrency smoke: Runs weight-trend concurrency checks in a uniquely named isolated PostgreSQL schema and cleans up owned state. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  databaseUrlForSchema,
  migrateDeploy,
} from './postgres-populated-upgrade-smoke.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const backendDirectory = path.join(repositoryRoot, 'backend');
const backendRequire = createRequire(path.join(backendDirectory, 'package.json'));
const ISOLATED_SCHEMA_PATTERN = /^calibrate_upgrade_smoke_[a-z0-9_]+$/;
const WAIT_TIMEOUT_MS = 5000;
const WAIT_POLL_MS = 25;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForQueuedRecomputes(client, namespace, userId, expectedCount) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await client.query(
      'SELECT count(*)::integer AS "waiting_count" ' +
      'FROM pg_locks ' +
      'WHERE "locktype" = \'advisory\' ' +
      'AND "classid" = $1::oid ' +
      'AND "objid" = $2::oid ' +
      'AND NOT "granted"',
      [namespace, userId]
    );
    if (result.rows[0].waiting_count >= expectedCount) return;
    await delay(WAIT_POLL_MS);
  }
  throw new Error('Timed out waiting for ' + expectedCount + ' queued weight-trend recomputations.');
}

/** Runs weight-trend concurrency checks in a uniquely named isolated PostgreSQL schema and cleans up owned state. */
export async function runWeightTrendConcurrencySmoke(rawDatabaseUrl = process.env.DATABASE_URL) {
  if (!rawDatabaseUrl) {
    throw new Error('DATABASE_URL is required for the Postgres weight-trend concurrency smoke test.');
  }

  const schemaName =
    'calibrate_upgrade_smoke_weight_trend_' + process.pid + '_' + crypto.randomBytes(6).toString('hex');
  assert.match(schemaName, ISOLATED_SCHEMA_PATTERN);
  const databaseUrl = databaseUrlForSchema(rawDatabaseUrl, schemaName);
  const { Client } = backendRequire('pg');
  const adminClient = new Client({ connectionString: rawDatabaseUrl });
  const blockerClient = new Client({ connectionString: rawDatabaseUrl });
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let disconnectDatabase;
  let blockerTransactionOpen = false;
  let recomputes = null;

  await adminClient.connect();
  await blockerClient.connect();
  try {
    await adminClient.query('CREATE SCHEMA "' + schemaName + '"');
    migrateDeploy(databaseUrl, path.join(backendDirectory, 'prisma', 'schema.prisma'));

    process.env.DATABASE_URL = databaseUrl;
    backendRequire('ts-node').register({
      project: path.join(backendDirectory, 'tsconfig.json'),
      transpileOnly: true,
      compilerOptions: { module: 'commonjs' },
    });
    const materialization = backendRequire('./src/services/materializedWeightTrend.ts');
    ({ disconnectDatabase } = backendRequire('./src/config/database'));

    const userId = 1_800_000_000 + (process.pid % 100_000_000);
    await adminClient.query(
      'INSERT INTO "' + schemaName + '"."User" ("id", "email", "password_hash", "timezone") ' +
      'VALUES ($1, $2, \'weight-trend-concurrency-smoke\', \'UTC\')',
      [userId, 'weight-trend-concurrency-' + schemaName + '@calibrate.invalid']
    );

    const sourceMetrics = [];
    const asOfDate = new Date('2026-08-01T00:00:00.000Z');
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(asOfDate);
      date.setUTCDate(date.getUTCDate() - (11 - index));
      const metric = {
        id: 1_700_000_000 + index,
        user_id: userId,
        date,
        weight_grams: 81000 - index * 75,
      };
      sourceMetrics.push(metric);
      await adminClient.query(
        'INSERT INTO "' + schemaName + '"."BodyMetric" ("id", "user_id", "date", "weight_grams") ' +
        'VALUES ($1, $2, $3, $4)',
        [metric.id, metric.user_id, metric.date.toISOString().slice(0, 10), metric.weight_grams]
      );
    }

    await blockerClient.query('BEGIN');
    blockerTransactionOpen = true;
    await blockerClient.query(
      'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
      [materialization.WEIGHT_TREND_ADVISORY_LOCK_NAMESPACE, userId]
    );

    recomputes = Promise.all([
      materialization.recomputeAndStoreUserWeightTrends(userId, undefined, asOfDate),
      materialization.recomputeAndStoreUserWeightTrends(userId, undefined, asOfDate),
    ]);
    await waitForQueuedRecomputes(
      adminClient,
      materialization.WEIGHT_TREND_ADVISORY_LOCK_NAMESPACE,
      userId,
      2
    );

    await blockerClient.query('COMMIT');
    blockerTransactionOpen = false;
    await recomputes;
    recomputes = null;

    const expectedRevision = materialization.computeWeightTrendSourceRevision(sourceMetrics);
    const persisted = await adminClient.query(
      'SELECT count(*)::integer AS "row_count", ' +
      'count(DISTINCT "source_revision")::integer AS "revision_count", ' +
      'min("source_revision") AS "source_revision" ' +
      'FROM "' + schemaName + '"."BodyMetricTrend" WHERE "user_id" = $1',
      [userId]
    );
    assert.deepEqual(persisted.rows[0], {
      row_count: sourceMetrics.length,
      revision_count: 1,
      source_revision: expectedRevision,
    });
    console.log(
      '[weight-trend-concurrency-smoke] PASS: two same-user recomputations queued on the advisory lock and produced one ' +
      sourceMetrics.length + '-row source revision.'
    );
  } finally {
    if (blockerTransactionOpen) {
      await blockerClient.query('ROLLBACK').catch(() => {});
    }
    if (recomputes) {
      await Promise.allSettled([recomputes]);
    }
    if (disconnectDatabase) {
      await disconnectDatabase();
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await blockerClient.end();
    if (ISOLATED_SCHEMA_PATTERN.test(schemaName)) {
      await adminClient.query('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
    }
    await adminClient.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWeightTrendConcurrencySmoke().catch((error) => {
    console.error(
      '[weight-trend-concurrency-smoke] FAIL: ' + (error instanceof Error ? error.message : error)
    );
    process.exitCode = 1;
  });
}
