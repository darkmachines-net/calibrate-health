/** @file Durable release checkpoints on GitHub Releases; incomplete runs must be reconciled before another cut. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { completedCalibrateBaseline, verifyCalibrateRecord } from './release-engine.mjs';

const PREFIX = 'release-run-';
const SHA = /^[a-f0-9]{40}$/;
const STAGES = new Set(['prepared', 'image', 'deploy', 'native-build', 'phone-handoff', 'phone-submit', 'wear-submit', 'ota-internal', 'ota-production', 'ota-internal-artifact', 'ota-production-artifact', 'final']);

/** Fail closed on an unrelated repository, source, or producing Actions workflow. */
export function validateRecord(record, repository) {
  if (record?.schema_version !== 1 || record.repository !== repository || !SHA.test(record.source_commit ?? '')
    || !SHA.test(record.workflow_sha ?? '') || record.source_commit !== record.workflow_sha || !/^[1-9]\d*$/.test(String(record.run_id))) {
    throw new Error('Release record identity is malformed.');
  }
  const plan = record.plan;
  if (!plan || ['server', 'native', 'ota_internal', 'ota_production', 'reserve_native', 'noop'].some((key) => typeof plan[key] !== 'boolean') ||
    !['patch', 'minor', 'major'].includes(plan.bump) || !/^[a-f0-9]{40,64}$/.test(plan.runtime_version ?? '') ||
    !/^[a-f0-9]{64}$/.test(plan.wear_hash ?? '') ||
    (plan.server && !/^\d+\.\d+\.\d+$/.test(plan.server_version ?? '')) ||
    (plan.native && (!/^\d+\.\d+\.\d+$/.test(plan.native_version ?? '') ||
      !Number.isSafeInteger(plan.native_codes?.mobileVersionCode) || plan.native_codes.mobileVersionCode < 1 ||
      plan.native_codes.mobileVersionCode % 2 !== 1 || plan.native_codes.wearVersionCode !== plan.native_codes.mobileVersionCode + 1 ||
      plan.native_codes.wearVersionCode > 2100000000))) throw new Error('Release component plan is malformed.');
  verifyCalibrateRecord(record);
  return record;
}

/** Select the newest checkpoint for a stage, keeping a queued operation distinct from a completed one. */
export function latestCheckpoint(checkpoints, stage) {
  return checkpoints.filter((item) => item.stage === stage).sort((a, b) => b.asset_id - a.asset_id)[0] ?? null;
}

/** Carry successful component publications forward even when a later stage is explicitly abandoned. */
export function completedBaseline(record, checkpoints) {
  return completedCalibrateBaseline(record, checkpoints);
}

/** Use fixed GitHub API origins; error text never includes credential-bearing request headers. */
export class ReleaseRecordStore {
  /** Inject transport for tests while production uses the job-scoped GitHub token. */
  constructor({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, request = fetch } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) throw new Error('GitHub release storage requires repository and token.');
    this.repository = repository;
    this.token = token;
    this.request = request;
  }

  /** Send a bounded authenticated request without forwarding credentials across redirects. */
  async api(route, { method = 'GET', body, raw = false, upload = false } = {}) {
    const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    let response = await this.request(`${origin}/repos/${this.repository}${route}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': upload ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body)
    });
    if (raw && method === 'GET' && response.status === 302) {
      const location = new URL(response.headers.get('location'));
      if (location.protocol !== 'https:' || location.username || location.password ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(location.hostname)) {
        throw new Error('GitHub returned an unexpected release download origin.');
      }
      response = await this.request(location.href, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    }
    if (!response.ok) throw new Error(`GitHub ${method} ${route.split('?')[0]} failed (${response.status}).`);
    if (response.status === 204) return null;
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  /** Enumerate every page so an older unfinished release cannot be missed. */
  async list() {
    const records = [];
    for (let page = 1; ; page += 1) {
      const releases = await this.api(`/releases?per_page=100&page=${page}`);
      records.push(...releases.filter((item) => item.tag_name.startsWith(PREFIX)));
      if (releases.length < 100) return records.sort((a, b) => b.id - a.id);
      if (page === 100) throw new Error('Release history exceeds the bounded inspection limit.');
    }
  }

  /** Bind durable metadata to the protected request handler that produced it. */
  async read(releaseId) {
    if (!/^[1-9]\d*$/.test(String(releaseId))) throw new Error('A numeric GitHub Release ID is required.');
    const release = await this.api(`/releases/${releaseId}`);
    const record = validateRecord(JSON.parse(release.body), this.repository);
    if (release.tag_name !== `${PREFIX}${record.run_id}`) throw new Error('Release tag and producing run differ.');
    const run = await this.api(`/actions/runs/${record.run_id}`);
    if (run.path !== '.github/workflows/cut-release-handler.yml' || run.event !== 'workflow_run'
      || run.head_branch !== 'master' || run.head_sha !== record.workflow_sha || run.repository.full_name !== this.repository) {
      throw new Error('Release metadata does not identify a protected Cut release run.');
    }
    const assets = [];
    for (let page = 1; ; page += 1) {
      const next = await this.api(`/releases/${releaseId}/assets?per_page=100&page=${page}`);
      assets.push(...next);
      if (next.length < 100) break;
      if (page === 100) throw new Error('Too many release assets.');
    }
    const checkpoints = [];
    const producers = new Map([[String(record.run_id), run]]);
    for (const asset of assets.filter((item) => /^checkpoint-[\w-]+\.json$/.test(item.name))) {
      if (asset.size > 1024 * 1024) throw new Error('Release checkpoint exceeds its size limit.');
      const checkpoint = JSON.parse(await this.api(`/releases/assets/${asset.id}`, { raw: true }));
      if (!STAGES.has(checkpoint.stage) || checkpoint.release_run_id !== record.run_id) throw new Error('Invalid release checkpoint binding.');
      const producerId = String(checkpoint.producing_run_id);
      if (!/^[1-9]\d*$/.test(producerId) || !/^[1-9]\d*$/.test(String(checkpoint.producing_run_attempt))) throw new Error('Missing checkpoint producer.');
      if (!producers.has(producerId)) producers.set(producerId, await this.api(`/actions/runs/${producerId}`));
      const producer = producers.get(producerId);
      if (producer.repository.full_name !== this.repository || producer.head_branch !== 'master' || producer.event !== 'workflow_run' ||
        !['.github/workflows/cut-release-handler.yml', '.github/workflows/publish-release-handler.yml'].includes(producer.path) ||
        (producer.path === '.github/workflows/cut-release-handler.yml' && producerId !== String(record.run_id)) ||
        Number(checkpoint.producing_run_attempt) > producer.run_attempt) throw new Error('Checkpoint was not produced by this release or protected recovery.');
      if (asset.uploader?.login !== 'github-actions[bot]') throw new Error('Release checkpoint is not an Actions publication.');
      checkpoints.push({ ...checkpoint, asset_id: asset.id });
    }
    return { release, record, checkpoints, assets };
  }

  /** Reserve one draft before any publication; retries reuse the original producing run. */
  async begin(record) {
    validateRecord(record, this.repository);
    const releases = await this.list();
    const same = releases.find((item) => item.tag_name === `${PREFIX}${record.run_id}`);
    const pending = releases.find((item) => item.draft && item.id !== same?.id);
    if (pending) throw new Error(`Resolve unfinished release ${pending.id} before another Cut release.`);
    if (same) {
      const existing = await this.read(same.id);
      if (existing.record.source_commit !== record.source_commit ||
        JSON.stringify(existing.record.plan) !== JSON.stringify(record.plan) ||
        existing.record.engine_plan?.digest !== record.engine_plan?.digest) throw new Error('Cannot change a reserved release source or component plan.');
      return same;
    }
    return this.api('/releases', { method: 'POST', body: {
      tag_name: `${PREFIX}${record.run_id}`, target_commitish: record.source_commit,
      name: `Cut release ${record.run_id}`, body: JSON.stringify(record), draft: true, prerelease: false
    } });
  }

  /** Append stage events instead of overwriting a shared JSON document from parallel jobs. */
  async checkpoint(releaseId, stage, value) {
    if (!STAGES.has(stage)) throw new Error('Unknown release stage.');
    const { record } = await this.read(releaseId);
    const data = { ...value, stage, release_run_id: record.run_id, producing_run_id: process.env.GITHUB_RUN_ID,
      producing_run_attempt: process.env.GITHUB_RUN_ATTEMPT };
    return this.upload(releaseId, `checkpoint-${stage}-${randomUUID()}.json`, Buffer.from(`${JSON.stringify(data)}\n`));
  }

  /** Retain immutable binaries and checkpoint bytes beyond Actions artifact expiration. */
  async upload(releaseId, name, bytes) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid release asset filename.');
    return this.api(`/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes, upload: true });
  }

  /** Verify a retained asset against the exact hash recorded by its producer. */
  async download(asset, expectedHash, destination) {
    const bytes = await this.api(`/releases/assets/${asset.id}`, { raw: true });
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Retained release artifact hash mismatch.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
}

/** Expose only explicit checkpoint operations to workflow steps. */
async function main() {
  const [command, releaseId, stage, file] = process.argv.slice(2);
  const store = new ReleaseRecordStore();
  if (command === 'checkpoint') await store.checkpoint(releaseId, stage, JSON.parse(fs.readFileSync(file, 'utf8')));
  else if (command === 'read') console.log(JSON.stringify(await store.read(releaseId)));
  else throw new Error('Usage: release-record.mjs checkpoint <release-id> <stage> <file> | read <release-id>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
