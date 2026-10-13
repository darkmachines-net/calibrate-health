/** @file Typed public contracts for deterministic release selection, immutable plans, stage receipts, and artifact verification. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ReadonlyJsonValue = JsonPrimitive | readonly ReadonlyJsonValue[] | { readonly [key: string]: ReadonlyJsonValue };
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Assert a public contract or throw before a side effect. */
export function invariant(condition: unknown, message: string): asserts condition;
/** Validate a bounded logical id allowing alphanumerics and dot, underscore, colon, and hyphen. */
export function validateId(value: unknown, label?: string): string;
/** Produce deterministic JSON; lossy values, cycles, accessors, and exotic objects throw. */
export function canonicalStringify(value: unknown): string;
/** Return lowercase SHA-256 of canonical semantic data, independently of compiled artifact bytes. */
export function hashIdentity(value: unknown): string;
/** Clone JSON and recursively freeze it, rejecting values that cannot be retained faithfully. */
export function immutable<T>(value: T): DeepReadonly<T>;

export interface SourceIdentity {
  repository: string;
  commit: string;
  workflowCommit: string;
  toolkitCommit: string;
}
export type EnginePlan<T extends { source: SourceIdentity } = { source: SourceIdentity }> = DeepReadonly<T & { schemaVersion: 1; kind: 'expo-release-plan'; digest: string }>;
/** Validate full application, trusted-workflow, and toolkit SHAs without requiring them to be equal. */
export function validateSourceIdentity<T extends SourceIdentity>(source: T): DeepReadonly<T>;
/** Seal an adapter's JSON fields in a distinct plan namespace; reserved schema/digest fields cannot be supplied. */
export function createPlan<T extends { source: SourceIdentity }>(input: T & { schemaVersion?: never; kind?: never; digest?: never }): EnginePlan<T>;
/** Verify retained plan digest and any explicitly supplied provenance requirements. */
export function verifyPlan<T extends { source: SourceIdentity }>(plan: EnginePlan<T>, expectedSource?: Partial<SourceIdentity>): EnginePlan<T>;

export interface ReleaseComponent {
  id: string;
  kind: string;
  identity: string;
  baselineIdentity?: string | null;
  enabled?: boolean;
  force?: boolean;
  reasons?: readonly string[];
}
export interface ComponentDependency { component: string; requires: readonly string[] }
export interface ComponentSelection {
  readonly selected: readonly string[];
  readonly noop: boolean;
  readonly components: readonly { readonly id: string; readonly kind: string; readonly selected: boolean; readonly reasons: readonly string[] }[];
}
/** Select changed semantic inputs and expand explicit cohorts/dependencies; reasons alone never select a component. */
export function selectComponents(input: { components: readonly ReleaseComponent[]; groups?: readonly (readonly string[])[]; dependencies?: readonly ComponentDependency[] }): ComponentSelection;

export interface ReleaseStage { id: string; component: string; needs?: readonly string[]; optional?: boolean }
export interface ReleaseGraph {
  readonly schemaVersion: 1;
  readonly stages: readonly { readonly id: string; readonly component: string; readonly needs: readonly string[]; readonly optional: boolean }[];
}
export type StageStatus = 'intent' | 'accepted' | 'unknown' | 'complete' | 'failed' | 'skipped';
export interface StageReceipt { stage: string; status: StageStatus; [key: string]: unknown }
export interface ReleaseSummary {
  readonly status: 'noop' | 'complete' | 'blocked' | 'failed' | 'pending';
  readonly remaining: readonly string[];
  readonly runnable: readonly string[];
  readonly failed: readonly string[];
  readonly unknown: readonly string[];
  readonly completedComponents: readonly string[];
}
/** Validate selected stages, reject missing dependencies/cycles, and freeze a canonical graph. */
export function buildReleaseGraph(stages: readonly ReleaseStage[]): ReleaseGraph;
/** Return the last appended stage receipt, never an older success behind a later failure. */
export function latestCheckpoint(receipts: readonly StageReceipt[], stage: string): DeepReadonly<StageReceipt> | null;
/** List required stage ids, including optional stages transitively needed by required work. */
export function requiredStages(graph: ReleaseGraph): string[];
/** List required stages without latest completed receipts; queued acceptance does not count. */
export function remainingStages(graph: ReleaseGraph, receipts?: readonly StageReceipt[]): string[];
/** Test stage prerequisites; outstanding intent, acceptance, and unknown outcomes cannot be re-executed. */
export function canRunStage(graph: ReleaseGraph, id: string, receipts?: readonly StageReceipt[]): boolean;
/** List components whose required stage receipts all completed before advancing their release baselines. */
export function completedComponents(graph: ReleaseGraph, receipts?: readonly StageReceipt[]): string[];
/** Summarize required stage outcomes without treating enqueue as completed publication. */
export function summarizeRelease(graph: ReleaseGraph, receipts?: readonly StageReceipt[]): ReleaseSummary;

export type OperationStatus = 'idle' | 'intent' | 'accepted' | 'unknown' | 'complete' | 'failed';
export type OperationEvidence = string | { [key: string]: JsonValue };
export interface OperationState {
  readonly schemaVersion: 1;
  readonly status: OperationStatus;
  readonly attempt: number;
  readonly operationKey?: string;
  readonly operationId?: string;
  readonly request?: ReadonlyJsonValue;
  readonly proof?: string | { readonly [key: string]: ReadonlyJsonValue };
  /** Authorization supplied with the retry event, archived with the failed attempt and its provider ID. */
  readonly retryProof?: string | { readonly [key: string]: ReadonlyJsonValue };
  readonly receipt?: string | { readonly [key: string]: ReadonlyJsonValue };
  readonly reason?: string;
  readonly retrySafe?: boolean;
  readonly history?: readonly OperationState[];
}
export type OperationEvent =
  | { type: 'intent'; operationKey: string; request?: JsonValue }
  | { type: 'accepted'; operationId: string; proof?: OperationEvidence }
  | { type: 'unknown'; reason: string }
  | { type: 'complete'; receipt: OperationEvidence; proof?: OperationEvidence }
  /** Definitive failure of an unknown/known-ID operation, or refreshing an existing failure, requires fresh proof. */
  | { type: 'failed'; reason: string; definitive?: boolean; proof?: OperationEvidence }
  | { type: 'reconciled-absent'; proof: OperationEvidence }
  /** Known-ID failures require fresh proof of safety for the adapter's chosen retry transport. */
  | { type: 'retry'; proof?: OperationEvidence };
/**
 * Reduce and freeze durable operation state, retaining supplied proof and every failed attempt's provider ID.
 * Adapters persist intent before I/O, verify failure/publication facts, and authorize the appropriate retry transport.
 * A known-ID terminal failure and its retry each require fresh event proof; the latter is archived as retryProof.
 * Such an operation cannot be described as absent. Historical failure state alone never authorizes known-ID retry.
 */
export function reduceOperation(previous: OperationState | null | undefined, event: OperationEvent): OperationState;

export interface ArtifactFile { readonly path: string; readonly size: number; readonly sha256: string }
export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly kind: 'release-artifact-manifest';
  readonly files: readonly ArtifactFile[];
  readonly digest: string;
}
/** Validate a portable relative artifact path, rejecting traversal and Windows aliases. */
export function validateArtifactPath(value: unknown): string;
/** Hash an exact inert directory tree; keep its manifest outside the hashed root. */
export function createArtifactManifest(root: string): Promise<ArtifactManifest>;
/** Verify exact file membership and bytes, rejecting symlinks, additions, and substituted manifests. */
export function verifyArtifactManifest(root: string, manifest: ArtifactManifest): Promise<ArtifactManifest>;

export interface StableVersion { readonly major: number; readonly minor: number; readonly patch: number }
/** Parse stable semver without prerelease labels, leading zeroes, or unsafe numeric fields. */
export function parseVersion(value: string): StableVersion;
/** Advance a stable version field and clear lower fields, rejecting numeric overflow. */
export function bumpVersion(value: string, bump: 'major' | 'minor' | 'patch'): string;
/** Allocate a positive safe native code above all reservations and optionally within a residue class. */
export function nextReservedVersion(input?: { used?: readonly number[]; after?: number; modulus?: number; residue?: number }): number;
