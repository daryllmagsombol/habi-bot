/**
 * H-016 (#16) default-deny ownership helper. Foundational slice only.
 *
 * This module answers one question: may this actor read this already-loaded
 * resource? It does not authenticate, does not query a database, and does not
 * choose an HTTP status. It exists so every boundary adopts the same rule:
 *
 *   allowed  <=>  the resource exists, is not deleted, and its server-recorded
 *                 owner equals the authenticated actor.
 *
 * Everything else — missing actor, missing resource, blank owner, foreign
 * owner, soft-deleted resource — produces one error with no distinguishing
 * detail, so a caller cannot use the response to enumerate resources. There is
 * deliberately no admin, service-account, or "trusted caller" bypass.
 *
 * Callers MUST pass the resource as loaded from server-owned storage. A
 * request body, header, or query parameter is never a valid `resource` input;
 * spreading client data into the object would defeat the helper. Ownership is
 * read only from `resource.ownerUserId`.
 *
 * Reference: docs/superpowers/research/2026-11-03-h016-ownership-matrix.md
 */
import { createHmac, randomBytes } from 'node:crypto';

/**
 * Minimum surface a resource must expose to be authorized. `deletedAt` is a
 * soft-delete marker; any non-empty value denies access, matching the H-002
 * lifecycle requirement that stale identifiers must not resolve.
 */
export interface OwnedResource {
  ownerUserId: string;
  deletedAt?: string | null;
}

/**
 * Server-side lookup for one resource type. `findById` runs against storage and
 * is the only source of the resource the helper authorizes. Async results are
 * supported so a database implementation (#19) can satisfy the same contract.
 */
export interface OwnershipPolicy<T extends OwnedResource> {
  readonly resourceType: string;
  findById(id: string): T | undefined | Promise<T | undefined>;
}

/** Stable code for the single denial outcome. Callers map it, never branch on it. */
export const OWNERSHIP_DENIED_CODE = 'ownership_denied';

/**
 * The only authorization failure this module raises. It carries no existence,
 * ownership, or lifecycle signal, and its stack/message never include ids.
 */
export class OwnershipDeniedError extends Error {
  readonly code = OWNERSHIP_DENIED_CODE;

  constructor() {
    super(OWNERSHIP_DENIED_CODE);
    this.name = 'OwnershipDeniedError';
  }
}

/**
 * Durable audit shape for a denial. It intentionally holds no content, no raw
 * resource id, and no reason field: recording `foreign` versus `unknown` would
 * recreate the enumeration oracle the error hides.
 */
export interface OwnershipDenialEvent {
  event: 'ownership.denied';
  actorUserId: string;
  resourceType: string;
  resourceIdHash: string;
  at: string;
}

/** Injectable audit boundary. Implementations must not throw on the deny path. */
export interface AuditSink {
  record(event: OwnershipDenialEvent): void;
}

export interface InMemoryAuditSink extends AuditSink {
  readonly events: readonly OwnershipDenialEvent[];
}

/**
 * Test/development sink. Events live only in this process and are lost on
 * restart; a durable sink is part of the persistence work in #19.
 */
export function createInMemoryAuditSink(): InMemoryAuditSink {
  const events: OwnershipDenialEvent[] = [];

  return {
    events,
    record(event: OwnershipDenialEvent): void {
      events.push(event);
    },
  };
}

export interface OwnershipCheck<T extends OwnedResource> {
  /** Authenticated actor id from the session/guard, never from client input. */
  readonly actorUserId: string | null | undefined;
  /** Server-loaded resource, or the lookup result when it was not found. */
  readonly resource: T | null | undefined;
  /** Stable resource type for audit; defaults to `resource`. */
  readonly resourceType?: string;
  /** Raw id used only to derive the salted audit hash, never logged directly. */
  readonly resourceId?: string;
  readonly auditSink?: AuditSink;
  /** Required when an audit sink is configured; rejected rather than defaulted. */
  readonly hashSalt?: string;
}

export interface OwnedByIdCheck<T extends OwnedResource> {
  readonly actorUserId: string | null | undefined;
  readonly id: string;
  readonly policy: OwnershipPolicy<T>;
  readonly auditSink?: AuditSink;
  readonly hashSalt?: string;
}

const FALLBACK_RESOURCE_TYPE = 'resource';
const EMPTY_RESOURCE_ID = '';
const HASH_ALGORITHM = 'sha256';

/**
 * Keys resource ids for audit. The salt is caller-supplied so a per-process
 * random salt can be used in production and a fixed one in tests.
 */
export function hashResourceId(resourceId: string | null | undefined, salt: string): string {
  return createHmac(HASH_ALGORITHM, salt)
    .update(resourceId ?? EMPTY_RESOURCE_ID, 'utf8')
    .digest('hex');
}

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isDeleted(resource: OwnedResource): boolean {
  return typeof resource.deletedAt === 'string' && resource.deletedAt.length > 0;
}

/**
 * Records the denial and returns the error to throw. Audit failures are
 * swallowed on purpose: a broken sink must not convert a denial into an
 * authorization grant or into a distinguishable server error.
 */
function denial<T extends OwnedResource>(check: OwnershipCheck<T>): OwnershipDeniedError {
  if (check.auditSink !== undefined) {
    const hashSalt = check.hashSalt;

    if (typeof hashSalt !== 'string' || hashSalt.length === 0) {
      throw new TypeError('hashSalt is required when an audit sink is configured.');
    }

    try {
      check.auditSink.record({
        event: 'ownership.denied',
        actorUserId: typeof check.actorUserId === 'string' ? check.actorUserId : '',
        resourceType: check.resourceType ?? FALLBACK_RESOURCE_TYPE,
        resourceIdHash: hashResourceId(check.resourceId, hashSalt),
        at: new Date().toISOString(),
      });
    } catch {
      // Fail closed: the denial below is the authorization outcome either way.
    }
  }

  return new OwnershipDeniedError();
}

/**
 * Returns `resource` only when the actor owns it and it is live. Every other
 * case throws the same `OwnershipDeniedError`; there is no reason, detail, or
 * enumeration branch.
 */
export function assertOwned<T extends OwnedResource = OwnedResource>(
  check: OwnershipCheck<T>,
): T {
  const { actorUserId, resource } = check;

  if (isBlank(actorUserId)) {
    throw denial(check);
  }

  if (resource === null || resource === undefined) {
    throw denial(check);
  }

  if (isBlank(resource.ownerUserId) || resource.ownerUserId !== actorUserId) {
    throw denial(check);
  }

  if (isDeleted(resource)) {
    throw denial(check);
  }

  return resource;
}

/**
 * Policy-backed variant for callers that start from an identifier. A missing
 * record follows the same denial path as a foreign one: the caller cannot tell
 * "not found" apart from "not yours".
 */
export async function assertOwnedById<T extends OwnedResource = OwnedResource>(
  check: OwnedByIdCheck<T>,
): Promise<T> {
  const resource = await check.policy.findById(check.id);

  return assertOwned({
    actorUserId: check.actorUserId,
    resource,
    resourceId: check.id,
    resourceType: check.policy.resourceType,
    ...(check.auditSink === undefined ? {} : { auditSink: check.auditSink }),
    ...(check.hashSalt === undefined ? {} : { hashSalt: check.hashSalt }),
  });
}

/**
 * Injection token for a Nest provider that wants to share one audit sink. The
 * spike run service falls back to an in-memory sink when nothing is provided.
 */
export const OWNERSHIP_AUDIT_SINK = Symbol('HABI_OWNERSHIP_AUDIT_SINK');

/** Per-process salt for the spike wiring. Audit hashes are not comparable across restarts. */
export const PROCESS_AUDIT_HASH_SALT = randomBytes(32).toString('hex');
