/**
 * H-028 (#28) artifact vocabulary and public shapes.
 *
 * An Artifact is generated text owned by one user and optionally scoped to one
 * conversation and producing run. Versions are append-only; the public
 * `Artifact` carries only the latest pointer, and a version body is returned
 * only by an explicit detail read.
 *
 * Ownership columns (`owner_user_id`, `created_by`) never cross the service
 * boundary except as the recorded actor of a version.
 */

/** Bounded, extensible output formats. Rich documents are not enabled. */
export type ArtifactKind = 'markdown' | 'text' | 'json';

/** A writable lifecycle state. `deleted` is reachable only through `delete`. */
export type WritableArtifactStatus = 'draft' | 'final';

/** Migration 0013 lifecycle. `deleted` is a tombstone, not a hard delete. */
export type ArtifactStatus = WritableArtifactStatus | 'deleted';

/** An Artifact as exposed to its owner. Never includes a version body. */
export interface Artifact {
  id: string;
  conversationId: string | null;
  runId: string | null;
  kind: ArtifactKind;
  title: string;
  currentVersion: number;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** One immutable version body plus the metadata that verifies it. */
export interface ArtifactVersion {
  artifactId: string;
  version: number;
  content: string;
  contentSha256: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
}

/** Version metadata without the body. Used by bounded version listing. */
export interface ArtifactVersionMetadata {
  artifactId: string;
  version: number;
  contentSha256: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
}

/** One artifact and one version body. */
export interface ArtifactDetail {
  artifact: Artifact;
  version: ArtifactVersion;
}

export interface CreateArtifactInput {
  kind: ArtifactKind;
  /** Display title, 1-200 code points after trimming. */
  title: string;
  /** Generated text, at most 1 MiB of UTF-8. Stored as data, never executed. */
  content: string;
  /** Optional live owned conversation. */
  conversationId?: string | null;
  /** Optional run in `conversationId`; requires a conversation. */
  runId?: string | null;
  /** Initial lifecycle state; defaults to `draft`. */
  status?: WritableArtifactStatus;
}

/** Normalized create record handed to the repository. */
export interface CreateArtifactRecord {
  kind: ArtifactKind;
  title: string;
  content: string;
  conversationId: string | null;
  runId: string | null;
  status: WritableArtifactStatus;
}

export interface UpdateArtifactInput {
  /** New content. Appended as a new version; earlier versions never change. */
  content: string;
  /** New title; omitted means unchanged. */
  title?: string;
  /** New kind; omitted means unchanged. */
  kind?: ArtifactKind;
  /** New lifecycle state; omitted means unchanged. `deleted` is not accepted. */
  status?: WritableArtifactStatus;
}

/** Normalized update record. `null` means "keep the stored value". */
export interface UpdateArtifactRecord {
  content: string;
  title: string | null;
  kind: ArtifactKind | null;
  status: WritableArtifactStatus | null;
}

export interface GetArtifactOptions {
  /** Exact historical version; omitted means the current version. */
  version?: number;
}

export interface ListArtifactsOptions {
  /** Restrict to one owned conversation. Foreign ids yield an empty page. */
  conversationId?: string;
  /** Page size, 1-100; defaults to 20. */
  limit?: number;
  /** Opaque cursor for the next page, bound to the same filter. */
  cursor?: string;
}

export interface ArtifactPage {
  artifacts: Artifact[];
  nextCursor: string | null;
}

export interface ListArtifactVersionsOptions {
  /** Page size, 1-100; defaults to 20. */
  limit?: number;
  /** Opaque cursor for the next page. */
  cursor?: string;
}

export interface ArtifactVersionPage {
  versions: ArtifactVersionMetadata[];
  nextCursor: string | null;
}

/** Internal row shape. Never crosses the service API. */
export interface ArtifactRecord extends Artifact {
  ownerUserId: string;
}

/** Content verification values computed from the exact stored text. */
export interface ArtifactContentHash {
  contentSha256: string;
  byteSize: number;
}
