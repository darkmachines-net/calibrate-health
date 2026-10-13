/** @file Adapt Calibrate component, cohort and checkpoint contracts to the pinned shared release engine. */
import fs from 'node:fs';
import {
  buildReleaseGraph,
  canRunStage,
  createPlan,
  createArtifactManifest,
  hashIdentity,
  nextReservedVersion,
  reduceOperation,
  remainingStages,
  selectComponents,
  summarizeRelease,
  verifyPlan,
  verifyArtifactManifest
} from '../tools/release-engine/index.mjs';
import { RELEASE_ENGINE_CONFIG } from './release-engine.config.mjs';

/** Bind original application source, trusted workflow, toolkit revision, configuration and graph in one immutable plan. */
export function sealCalibrateRecord(record) {
  const lock = JSON.parse(fs.readFileSync(new URL('../release-engine.lock.json', import.meta.url), 'utf8'));
  const toolkitSha = lock.revision;
  const enginePlan = createPlan({ source: { repository: record.repository, commit: record.source_commit,
    workflowCommit: record.workflow_sha, toolkitCommit: toolkitSha }, runId: record.run_id,
    config: RELEASE_ENGINE_CONFIG, plan: record.plan, baseline: record.baseline,
    graph: calibrateReleaseGraph(record.plan) });
  return { ...record, toolkit_sha: toolkitSha, engine_plan: enginePlan };
}

/** Check retained shared plans against their original record; legacy records retain their existing independent validation. */
export function verifyCalibrateRecord(record) {
  if (!record.engine_plan && !record.toolkit_sha) return false;
  const plan = verifyPlan(record.engine_plan, { repository: record.repository, commit: record.source_commit,
    workflowCommit: record.workflow_sha, toolkitCommit: record.toolkit_sha });
  if (hashIdentity(plan.config) !== hashIdentity(RELEASE_ENGINE_CONFIG)) {
    throw new Error('Retained release destination/configuration differs from the executing adapter. Restore the reviewed configuration before recovery.');
  }
  if (plan.runId !== record.run_id || hashIdentity(plan.plan) !== hashIdentity(record.plan)
    || hashIdentity(plan.baseline) !== hashIdentity(record.baseline)
    || hashIdentity(plan.graph) !== hashIdentity(calibrateReleaseGraph(record.plan))) {
    throw new Error('Retained release record differs from its immutable engine plan.');
  }
  return true;
}

/** Select the paired native cohort and its actual server/OTA dependencies through the shared planner. */
export function selectCalibrateComponents({ serverChanges = [], otaChanges = [], productionChanges = otaChanges,
  phoneRuntimeChanged = false, wearChanged = false, reserveNative = false, bump = 'patch' }) {
  const component = (id, kind, changed, reasons) => ({ id, kind,
    identity: hashIdentity({ changed }), baselineIdentity: hashIdentity({ changed: false }), reasons });
  const dependencies = [];
  if (reserveNative) {
    dependencies.push({ component: 'phone', requires: ['server', 'ota-internal', 'ota-production'] });
  }
  if (bump === 'major') dependencies.push({ component: 'server', requires: ['ota-internal', 'ota-production'] });
  const selected = selectComponents({
    components: [
      component('server', 'server', serverChanges.length > 0, serverChanges),
      component('phone', 'native', phoneRuntimeChanged, phoneRuntimeChanged ? ['Phone runtime changed'] : []),
      component('wear', 'native', wearChanged, wearChanged ? ['Wear build inputs changed'] : []),
      component('ota-internal', 'ota', phoneRuntimeChanged || otaChanges.length > 0, otaChanges),
      component('ota-production', 'ota', phoneRuntimeChanged || productionChanges.length > 0, productionChanges)
    ],
    groups: [['phone', 'wear']], dependencies
  });
  const has = (id) => selected.selected.includes(id);
  return { server: has('server'), native: has('phone'), ota_internal: has('ota-internal'),
    ota_production: has('ota-production'), noop: selected.noop, selection: selected };
}

/** Allocate globally unique odd phone and even Wear codes above published and abandoned reservations. */
export function allocateCalibrateNativeCodes(manifest, reservedCode = 0) {
  const used = [manifest.android.mobile.version_code, manifest.android.wear.version_code,
    RELEASE_ENGINE_CONFIG.minimumReservedCode, ...(reservedCode === 0 ? [] : [reservedCode])];
  const mobileVersionCode = nextReservedVersion({ used, modulus: 2, residue: 1 });
  const wearVersionCode = nextReservedVersion({ used: [...used, mobileVersionCode], modulus: 2, residue: 0 });
  if (wearVersionCode > 2_100_000_000) throw new Error('Paired native version codes exceed the Google Play limit.');
  return { mobileVersionCode, wearVersionCode };
}

/** Describe deployment and provider handoff barriers separately from asynchronous native completion. */
function calibrateReleaseGraph(plan) {
  const stages = [];
  if (plan.server) stages.push({ id: 'image', component: 'server' },
    { id: 'deploy', component: 'server', needs: ['image'] });
  if (plan.native) stages.push(
    { id: 'native-build', component: 'native' },
    { id: 'phone-handoff', component: 'native', needs: ['native-build', ...(plan.server ? ['deploy'] : [])] },
    { id: 'phone-submit', component: 'native', needs: ['phone-handoff'] },
    { id: 'wear-submit', component: 'native', needs: ['phone-submit'] }
  );
  const otaNeeds = [...(plan.server ? ['deploy'] : []), ...(plan.native ? ['phone-handoff'] : [])];
  if (plan.ota_internal) stages.push({ id: 'ota-internal', component: 'ota-internal', needs: otaNeeds });
  if (plan.ota_production) stages.push({ id: 'ota-production', component: 'ota-production',
    needs: plan.ota_internal ? ['ota-internal'] : otaNeeds });
  return buildReleaseGraph(stages);
}

/** Convert append-only GitHub checkpoints to ordered shared receipts without treating queued work as complete. */
function releaseReceipts(checkpoints) {
  const statuses = { started: 'intent', enqueueing: 'intent', queued: 'accepted', unknown: 'unknown',
    succeeded: 'complete', failed: 'failed', 'not-published': 'failed' };
  return checkpoints.map((checkpoint, index) => ({ checkpoint, order: checkpoint.asset_id ?? index }))
    .sort((a, b) => a.order - b.order)
    .filter(({ checkpoint }) => statuses[checkpoint.status])
    .map(({ checkpoint }) => ({ ...checkpoint, status: statuses[checkpoint.status],
      ...(checkpoint.submission_id ? { operationId: checkpoint.submission_id } : {}) }));
}

/** Exclude preparation and retained-artifact bookkeeping from the publication stage graph. */
function graphReceipts(graph, checkpoints, record) {
  const selected = new Set(graph.stages.map((stage) => stage.id));
  const receipts = releaseReceipts(checkpoints).filter((receipt) => selected.has(receipt.stage));
  // Pre-engine schema-1 workflows verified handoff before OTA but recorded no separate receipt.
  // Their successful OTA or final phone completion proves that former barrier; a queued ID does not.
  const latest = (stage) => receipts.filter((receipt) => receipt.stage === stage).at(-1);
  if (record.schema_version === 1 && !record.engine_plan && !record.toolkit_sha
    && selected.has('phone-handoff') && !receipts.some((receipt) => receipt.stage === 'phone-handoff')
    && ['phone-submit', 'ota-internal', 'ota-production'].some((stage) => latest(stage)?.status === 'complete')) {
    receipts.push({ stage: 'phone-handoff', status: 'complete', legacyEvidence: 'verified-legacy-publication' });
  }
  return receipts;
}

/** Return only unfinished required stages; phone enqueue never stands in for completed phone/Wear distribution. */
export function incompleteCalibrateStages(record, checkpoints) {
  const graph = calibrateReleaseGraph(record.plan);
  return remainingStages(graph, graphReceipts(graph, checkpoints, record));
}

/** Check a selected stage's shared dependency graph before crossing its external publication boundary. */
export function canRunCalibrateStage(record, checkpoints, stage) {
  const graph = calibrateReleaseGraph(record.plan);
  return canRunStage(graph, stage, graphReceipts(graph, checkpoints, record));
}

/** Produce one shared-engine summary for the workflow's independently completing release branches. */
export function summarizeCalibrateRelease(record, checkpoints) {
  const graph = calibrateReleaseGraph(record.plan);
  return summarizeRelease(graph, graphReceipts(graph, checkpoints, record));
}

/** Preserve successful baselines while retaining every reserved native code, including abandoned runs. */
export function completedCalibrateBaseline(record, checkpoints) {
  const ordered = releaseReceipts(checkpoints);
  const last = (stage) => ordered.filter((item) => item.stage === stage).at(-1);
  const completed = new Set(summarizeCalibrateRelease(record, checkpoints).completedComponents);
  const result = structuredClone(record.baseline ?? {});
  if (record.plan.native_codes) result.reserved_native_code = Math.max(result.reserved_native_code ?? 0,
    record.plan.native_codes.mobileVersionCode, record.plan.native_codes.wearVersionCode);
  if (record.plan.native_version) result.reserved_native_version = record.plan.native_version;
  const prepared = last('prepared');
  const source = prepared?.source_commit ?? record.source_commit;
  if (completed.has('server')) result.server = { source_commit: source };
  const native = last('native-build');
  if (prepared?.native_version || native?.native?.version) {
    result.reserved_native_version = prepared?.native_version ?? native.native.version;
  }
  if (completed.has('native')) {
    result.native = { ...native.native, source_commit: source };
  }
  for (const channel of ['internal', 'production']) {
    const publication = last(`ota-${channel}`);
    if (completed.has(`ota-${channel}`)) result[`ota_${channel}`] = { source_commit: source, ...publication.publication };
  }
  return result;
}

/** Validate a provider state transition; unresolved outcomes cannot be retried without reconciliation evidence. */
export function transitionReleaseOperation(operation, event) {
  return reduceOperation(operation, event);
}

/** Restore a prior checkpoint conservatively; an interrupted request without provider evidence remains unknown. */
export function checkpointOperation(checkpoint, stage) {
  if (checkpoint?.operation) {
    if (checkpoint.operation.operationKey !== stage) throw new Error('Release operation belongs to another stage.');
    return checkpoint.operation;
  }
  if (!checkpoint) return null;
  const intent = reduceOperation(null, { type: 'intent', operationKey: stage });
  if (checkpoint.status === 'succeeded') return reduceOperation(intent, { type: 'complete', receipt: checkpoint });
  if (checkpoint.submission_id) {
    const accepted = reduceOperation(intent, { type: 'accepted', operationId: checkpoint.submission_id });
    if (checkpoint.status === 'queued') return accepted;
    return reduceOperation(accepted, { type: 'unknown', reason: 'The recorded provider operation requires verified reconciliation.' });
  }
  if (checkpoint.status === 'not-published' && !checkpoint.submission_id
    && checkpoint.reconciliation?.confirmed === true && typeof checkpoint.reconciliation.evidence === 'string'
    && checkpoint.reconciliation.evidence.trim().length >= 20 && checkpoint.reconciliation.evidence.length <= 1500) {
    return reduceOperation(intent, { type: 'reconciled-absent', proof: checkpoint.reconciliation });
  }
  return reduceOperation(intent, { type: 'unknown', reason: 'The previous release checkpoint requires provider reconciliation.' });
}

/** Append shared operation state before the caller continues; this helper never starts or retries a provider request. */
export async function checkpointReleaseOperation(store, releaseId, stage, event, fields = {}) {
  if (event.operationKey !== undefined && event.operationKey !== stage) throw new Error('Release intent belongs to another stage.');
  const state = await store.read(releaseId);
  const previous = [...state.checkpoints].sort((a, b) => (a.asset_id ?? 0) - (b.asset_id ?? 0))
    .filter((checkpoint) => checkpoint.stage === stage).at(-1);
  const operation = reduceOperation(checkpointOperation(previous, stage), event);
  const statuses = { intent: stage.endsWith('-submit') ? 'enqueueing' : 'started', accepted: 'queued',
    unknown: 'unknown', complete: 'succeeded', failed: 'failed' };
  await store.checkpoint(releaseId, stage, { ...fields,
    status: event.type === 'reconciled-absent' ? 'not-published' : statuses[operation.status], operation,
    ...(operation.operationId ? { submission_id: operation.operationId } : {}) });
  return operation;
}

/** Inventory the exact retained artifact tree with shared SHA-256 and path rules before durable publication. */
export async function createReleaseArtifactManifest(root) {
  return createArtifactManifest(root);
}

/** Reject altered, missing, unexpected or non-regular retained files before credentials are admitted. */
export async function verifyReleaseArtifactManifest(root, manifest) {
  return verifyArtifactManifest(root, manifest);
}
