/** @file Pure operation transitions that preserve intent and provider identity across interrupted publication requests. */
import { immutable, invariant, validateId } from './core.mjs';

const states = new Set(['idle', 'intent', 'accepted', 'unknown', 'complete', 'failed']);

function evidence(value, label) {
  invariant(value !== undefined && value !== null && (typeof value === 'string' ? value.trim().length > 0 : typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0), `${label} is required.`);
  return immutable(value);
}

function reason(value) {
  invariant(typeof value === 'string' && value.trim().length > 0, 'Operation reason is required.');
  return value;
}

function validateState(state, historical = false) {
  invariant(state.schemaVersion === 1 && states.has(state.status), 'Unsupported operation state.');
  invariant(Number.isSafeInteger(state.attempt) && state.attempt >= 0, 'Invalid operation attempt.');
  if (state.status === 'idle') {
    invariant(state.attempt === 0 && state.operationKey === undefined && state.operationId === undefined && state.receipt === undefined && state.retrySafe === undefined && state.history === undefined, 'Idle operation contains retained side effects.');
  } else {
    validateId(state.operationKey, 'Operation key');
    invariant(state.attempt > 0, 'Active operation needs a positive attempt.');
  }
  if (state.operationId !== undefined) invariant(typeof state.operationId === 'string' && state.operationId.trim().length > 0, 'Invalid provider operation id.');
  if (state.status === 'accepted') invariant(state.operationId !== undefined, 'Accepted operation needs a provider operation id.');
  if (state.status === 'intent') invariant(state.operationId === undefined, 'Intent cannot already contain an accepted provider operation id.');
  if (state.status === 'complete') evidence(state.receipt, 'Completion receipt');
  else invariant(state.receipt === undefined, 'Outstanding operation cannot contain a completion receipt.');
  if (state.status === 'failed') invariant(state.retrySafe === true, 'Failed operation must record definitive retry safety.');
  else invariant(state.retrySafe === undefined, 'Only definitive failure may permit retry.');
  if (['unknown', 'failed'].includes(state.status)) reason(state.reason);
  if (state.proof !== undefined) evidence(state.proof, 'Retained operation proof');
  if (state.history !== undefined) {
    invariant(!historical && Array.isArray(state.history), 'Operation history must be a flat list.');
    invariant(state.history.length === state.attempt - 1, 'Operation history does not match its attempt count.');
    state.history.forEach((entry, index) => {
      validateState(entry, true);
      invariant(entry.operationKey === state.operationKey && entry.attempt === index + 1 && entry.status === 'failed', 'Operation history must retain each definitively failed attempt.');
    });
  } else invariant(historical || state.attempt <= 1, 'Retried operation must retain prior attempts.');
}

/**
 * Reduce an operation event without performing I/O; persist every returned state before starting its external side effect.
 * A durable intent permits one initial request. After process interruption, treat an intent as unknown and reconcile it.
 * Accepted means queued, never complete. Unknown outcomes cannot retry without explicit proof of absence.
 * Adapters verify proof with the provider; this reducer validates transitions and preserves the evidence they supply.
 */
export function reduceOperation(previous, event) {
  const state = previous == null ? { schemaVersion: 1, status: 'idle', attempt: 0 } : immutable(previous);
  validateState(state);
  invariant(event && typeof event.type === 'string', 'Operation event is required.');
  const next = { ...state };
  switch (event.type) {
    case 'intent': {
      invariant(state.status === 'idle', 'An existing operation must be reconciled or explicitly retried before recording a new intent.');
      validateId(event.operationKey, 'Operation key');
      next.operationKey = event.operationKey;
      next.attempt += 1;
      next.status = 'intent';
      if (event.request !== undefined) next.request = immutable(event.request);
      break;
    }
    case 'accepted': {
      invariant(['intent', 'unknown'].includes(state.status), 'Only an outstanding operation can be accepted.');
      invariant(typeof event.operationId === 'string' && event.operationId.trim().length > 0, 'Provider operation id is required.');
      invariant(state.operationId === undefined || state.operationId === event.operationId, 'Provider operation id changed during reconciliation.');
      if (state.status === 'unknown') next.proof = evidence(event.proof, 'Reconciliation proof');
      next.operationId = event.operationId;
      next.status = 'accepted';
      delete next.reason;
      break;
    }
    case 'unknown': {
      invariant(['intent', 'accepted', 'unknown'].includes(state.status), 'Only an outstanding operation can become unknown.');
      next.status = 'unknown';
      next.reason = reason(event.reason);
      break;
    }
    case 'complete': {
      invariant(['intent', 'accepted', 'unknown'].includes(state.status), 'Only an outstanding operation can complete.');
      if (state.status === 'unknown') next.proof = evidence(event.proof, 'Reconciliation proof');
      next.receipt = evidence(event.receipt, 'Completion receipt');
      next.status = 'complete';
      delete next.reason;
      delete next.retrySafe;
      break;
    }
    case 'failed': {
      invariant(['intent', 'accepted', 'unknown'].includes(state.status), 'Only an outstanding operation can fail.');
      if (event.definitive !== true) {
        next.status = 'unknown';
      } else {
        if (state.status === 'unknown') next.proof = evidence(event.proof, 'Definitive failure proof');
        next.status = 'failed';
        next.retrySafe = true;
      }
      next.reason = reason(event.reason);
      break;
    }
    case 'reconciled-absent': {
      invariant(['intent', 'unknown'].includes(state.status), 'Only an unresolved operation can be reconciled as absent.');
      invariant(state.operationId === undefined, 'An accepted provider operation requires a definitive provider outcome before retry.');
      next.proof = evidence(event.proof, 'Absence proof');
      next.status = 'failed';
      next.reason = 'Provider reconciliation proved no operation was created.';
      next.retrySafe = true;
      break;
    }
    case 'retry': {
      invariant(state.status === 'failed' && state.retrySafe === true, 'Unknown, queued, or completed operations cannot be blindly retried.');
      const { history: previousHistory = [], ...attempt } = state;
      const history = [...previousHistory, immutable(attempt)];
      const retried = { schemaVersion: 1, status: 'intent', operationKey: state.operationKey, attempt: state.attempt + 1, history };
      if (state.request !== undefined) retried.request = state.request;
      validateState(retried);
      return immutable(retried);
    }
    default:
      throw new Error(`Unknown operation event ${event.type}.`);
  }
  validateState(next);
  return immutable(next);
}
