/** @file Account-scoped idempotent client mutations and replayable response storage. */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';

const CLIENT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type MutationDatabase = Prisma.TransactionClient | typeof prisma;

export type MutationResult<T> = {
  status: number;
  body: T;
};

export class ClientOperationConflictError extends Error {
  readonly code: 'OPERATION_ID_REUSED' | 'OPERATION_IN_PROGRESS';

  /** Carry the stable replay-conflict code separately from the explanatory error message. */
  constructor(code: ClientOperationConflictError['code'], message: string) {
    super(message);
    this.name = 'ClientOperationConflictError';
    this.code = code;
  }
}

/** Accept stable opaque IDs while rejecting unbounded or header-injection-shaped values. */
export function parseClientOperationId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return CLIENT_OPERATION_ID_PATTERN.test(normalized) ? normalized : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value instanceof Date ? value.toISOString() : value;
}

const toJsonValue = <T>(value: T): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(canonicalize(value))) as Prisma.InputJsonValue;

const hashRequest = (operationKind: string, payload: unknown): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize({ operationKind, payload })), 'utf8')
    .digest('hex');

/**
 * Execute a mutation once per account/operation ID and store the original wire response.
 * The operation claim, domain write, sync feed entry, and response receipt share one transaction.
 */
export async function executeIdempotentMutation<T>(options: {
  userId: number;
  mobileAuthSessionId?: number;
  operationId?: string;
  operationKind: string;
  requestPayload: unknown;
  transactionOptions?: { isolationLevel?: Prisma.TransactionIsolationLevel };
  mutate: (tx: MutationDatabase, operationId?: string) => Promise<MutationResult<T>>;
}): Promise<MutationResult<T>> {
  if (!options.operationId) {
    // Legacy/browser callers still need the domain write and sync-feed append to commit atomically.
    return prisma.$transaction((tx) => options.mutate(tx), options.transactionOptions);
  }

  const requestHash = hashRequest(options.operationKind, options.requestPayload);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.clientOperation.create({
        data: {
          user_id: options.userId,
          ...(options.mobileAuthSessionId === undefined
            ? {}
            : { mobile_auth_session_id: options.mobileAuthSessionId }),
          operation_id: options.operationId!,
          operation_kind: options.operationKind,
          request_hash: requestHash
        }
      });

      const result = await options.mutate(tx, options.operationId);
      const normalizedBody = toJsonValue(result.body);
      await tx.clientOperation.update({
        where: {
          user_id_operation_id: {
            user_id: options.userId,
            operation_id: options.operationId!
          }
        },
        data: {
          response_status: result.status,
          response_body: normalizedBody === null ? Prisma.DbNull : normalizedBody,
          completed_at: new Date()
        }
      });

      return { status: result.status, body: normalizedBody as T };
    }, options.transactionOptions);
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }

    const existing = await prisma.clientOperation.findUnique({
      where: {
        user_id_operation_id: {
          user_id: options.userId,
          operation_id: options.operationId
        }
      }
    });
    if (
      !existing ||
      existing.request_hash !== requestHash ||
      (options.mobileAuthSessionId !== undefined &&
        existing.mobile_auth_session_id !== options.mobileAuthSessionId)
    ) {
      throw new ClientOperationConflictError(
        'OPERATION_ID_REUSED',
        'Client operation id was already used for a different request.'
      );
    }
    // A successful 204 receipt has a deliberately null response body. Completion is determined by
    // the status/timestamp pair so that an uncertain delete can replay without repeating the write.
    if (existing.response_status === null || existing.completed_at === null) {
      throw new ClientOperationConflictError(
        'OPERATION_IN_PROGRESS',
        'Client operation is still in progress; retry shortly.'
      );
    }

    return {
      status: existing.response_status,
      body: existing.response_body as T
    };
  }
}

/** Append an ordered upsert/delete event inside the caller's domain transaction. */
export async function recordSyncChange(options: {
  tx: MutationDatabase;
  userId: number;
  entityType: string;
  entityId: string | number;
  action: 'upsert' | 'delete';
  operationId?: string;
  payload?: unknown;
}): Promise<void> {
  await options.tx.syncChange.create({
    data: {
      user_id: options.userId,
      entity_type: options.entityType,
      entity_id: String(options.entityId),
      action: options.action,
      operation_id: options.operationId,
      ...(options.payload === undefined ? {} : { payload: toJsonValue(options.payload) })
    }
  });
}
