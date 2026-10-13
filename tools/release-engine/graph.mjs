/** @file Validate release stage graphs and derive readiness and completed component baselines from append-only receipts. */
import { immutable, invariant, validateId } from './core.mjs';

const statuses = new Set(['intent', 'accepted', 'unknown', 'complete', 'failed', 'skipped']);

/** Build a graph containing only stages selected by the adapter; optional stages may be skipped but never satisfy dependencies. */
export function buildReleaseGraph(stages) {
  invariant(Array.isArray(stages), 'Stages must be an array.');
  const byId = new Map();
  for (const stage of stages) {
    validateId(stage.id, 'Stage id');
    validateId(stage.component, 'Stage component');
    invariant(!byId.has(stage.id), `Duplicate stage ${stage.id}.`);
    const needs = stage.needs ?? [];
    invariant(Array.isArray(needs) && new Set(needs).size === needs.length, `Stage ${stage.id} needs distinct dependencies.`);
    invariant(stage.optional === undefined || typeof stage.optional === 'boolean', 'Stage optional must be boolean.');
    needs.forEach((id) => validateId(id, 'Dependency stage id'));
    byId.set(stage.id, { id: stage.id, component: stage.component, needs: [...needs].sort(), optional: stage.optional === true });
  }
  const active = new Set();
  const visited = new Set();
  function visit(id) {
    invariant(byId.has(id), `Unknown dependency stage ${id}.`);
    invariant(!active.has(id), `Release graph cycle at ${id}.`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).needs) visit(dependency);
    active.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return immutable({ schemaVersion: 1, stages: [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) });
}

function validatedGraph(graph) {
  invariant(graph?.schemaVersion === 1, 'Unsupported release graph schema.');
  return buildReleaseGraph(graph.stages);
}

function checkpoints(graph, receipts) {
  invariant(Array.isArray(receipts), 'Stage receipts must be an append-ordered array.');
  const stages = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const latest = new Map();
  for (const receipt of receipts) {
    invariant(receipt && stages.has(receipt.stage), `Receipt references unknown stage ${receipt?.stage}.`);
    invariant(statuses.has(receipt.status), `Invalid stage status ${receipt.status}.`);
    invariant(receipt.status !== 'skipped' || stages.get(receipt.stage).optional, `Required stage ${receipt.stage} cannot be skipped.`);
    immutable(receipt);
    latest.set(receipt.stage, receipt);
  }
  return latest;
}

function completionChecker(graph, latest) {
  const stages = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const completed = new Map();
  function complete(id) {
    if (completed.has(id)) return completed.get(id);
    const result = latest.get(id)?.status === 'complete' && stages.get(id).needs.every(complete);
    completed.set(id, result);
    return result;
  }
  return complete;
}

/** Return the most recent receipt for a stage; caller array order is authoritative, so newer failure never falls back to older success. */
export function latestCheckpoint(receipts, stage) {
  invariant(Array.isArray(receipts), 'Stage receipts must be an array.');
  validateId(stage, 'Stage id');
  const receipt = receipts.findLast((item) => item.stage === stage);
  if (receipt === undefined) return null;
  invariant(statuses.has(receipt.status), `Invalid stage status ${receipt.status}.`);
  return immutable(receipt);
}

/** Return required stages, including optional stages that a required stage transitively needs. */
export function requiredStages(graph) {
  const checked = validatedGraph(graph);
  const byId = new Map(checked.stages.map((stage) => [stage.id, stage]));
  const required = new Set();
  function include(id) {
    if (required.has(id)) return;
    required.add(id);
    byId.get(id).needs.forEach(include);
  }
  checked.stages.filter((stage) => !stage.optional).forEach((stage) => include(stage.id));
  return [...required].sort();
}

/** Return required stages lacking a latest completed receipt; accepted provider requests are still pending. */
export function remainingStages(graph, receipts = []) {
  const checked = validatedGraph(graph);
  const latest = checkpoints(checked, receipts);
  const complete = completionChecker(checked, latest);
  return requiredStages(checked).filter((id) => !complete(id));
}

/** Check execution readiness; in-flight or unknown stages require observation/reconciliation, never blind re-execution. */
export function canRunStage(graph, id, receipts = []) {
  const checked = validatedGraph(graph);
  const stage = checked.stages.find((item) => item.id === id);
  invariant(stage, `Unknown stage ${id}.`);
  const latest = checkpoints(checked, receipts);
  const state = latest.get(id)?.status;
  const complete = completionChecker(checked, latest);
  return (state === undefined || state === 'failed') && stage.needs.every(complete);
}

/** Return components whose required stages all completed; a handoff receipt alone cannot advance a completion baseline. */
export function completedComponents(graph, receipts = []) {
  const checked = validatedGraph(graph);
  const latest = checkpoints(checked, receipts);
  const complete = completionChecker(checked, latest);
  const required = new Set(requiredStages(checked));
  const components = [...new Set(checked.stages.map((stage) => stage.component))].sort();
  return components.filter((component) => {
    const stages = checked.stages.filter((stage) => stage.component === component && required.has(stage.id));
    return stages.length > 0 && stages.every((stage) => complete(stage.id));
  });
}

/** Summarize complete, pending, blocked, and failed outcomes without treating queue acceptance as release completion. */
export function summarizeRelease(graph, receipts = []) {
  const checked = validatedGraph(graph);
  const latest = checkpoints(checked, receipts);
  const remaining = remainingStages(checked, receipts);
  const required = requiredStages(checked);
  const failed = required.filter((id) => latest.get(id)?.status === 'failed');
  const unknown = required.filter((id) => latest.get(id)?.status === 'unknown');
  const runnable = remaining.filter((id) => canRunStage(checked, id, receipts));
  const inconsistent = remaining.some((id) => ['complete', 'skipped'].includes(latest.get(id)?.status));
  const status = required.length === 0 ? 'noop' : remaining.length === 0 ? 'complete' : unknown.length || inconsistent ? 'blocked' : failed.length ? 'failed' : 'pending';
  return immutable({ status, remaining, runnable, failed, unknown, completedComponents: completedComponents(checked, receipts) });
}
