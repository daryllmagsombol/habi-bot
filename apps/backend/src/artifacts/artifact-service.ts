/**
 * H-028 (#28) ArtifactService: owner-scoped, versioned generated artifacts.
 *
 * Invariants:
 *   - Every method takes the authenticated actor id from the session boundary.
 *     No method accepts an owner id, artifact id, or version hash from input;
 *     ids are server-generated and hashes are computed from the stored text.
 *   - `create` starts at version 1. `update` and `restoreVersion` append a new
 *     version and move the latest pointer; a recorded version is never rewritten.
 *   - Every read verifies the stored body against its SHA-256 and byte length.
 *     A mismatch fails closed with `ArtifactIntegrityError` before returning text.
 *   - Foreign, guessed, malformed, or tombstoned identifiers fail closed with
 *     one non-enumerating `not_found`.
 *   - Content is untrusted data. It is stored and returned as plain text and is
 *     never executed as HTML, evaluated as JSON, used as an instruction, or
 *     turned into a path. There is no storage key in this slice.
 *   - Listing is bounded (1-100 rows) and keyset paginated; version listing
 *     returns metadata only and never selects the body.
 *
 * HTTP routes, UI, object storage, rich document formats, and retention/purge
 * are out of scope for this slice.
 */
import type { Pool } from 'pg';
import { ArtifactRepository } from './artifact-repository.js';
import { ArtifactIntegrityError } from './errors.js';
import type {
  Artifact,
  ArtifactDetail,
  ArtifactPage,
  ArtifactVersionPage,
  CreateArtifactInput,
  GetArtifactOptions,
  ListArtifactVersionsOptions,
  ListArtifactsOptions,
  UpdateArtifactInput,
} from './types.js';
import {
  hashArtifactContent,
  normalizeArtifactVersion,
  normalizeCreateArtifactInput,
  normalizeGetArtifactOptions,
  normalizeListArtifactVersionsOptions,
  normalizeListArtifactsOptions,
  normalizeUpdateArtifactInput,
} from './validation.js';

export class ArtifactService {
  private readonly repository: ArtifactRepository;

  constructor(pool: Pool) {
    this.repository = new ArtifactRepository(pool);
  }

  /** Creates an artifact and version 1. The id and version are server-owned. */
  async create(
    actorUserId: string,
    input: CreateArtifactInput,
  ): Promise<ArtifactDetail> {
    const record = normalizeCreateArtifactInput(input);

    return this.verifyIntegrity(
      await this.repository.create(actorUserId, record),
    );
  }

  /** Appends a new version; earlier versions and their references stay valid. */
  async update(
    actorUserId: string,
    artifactId: string,
    input: UpdateArtifactInput,
  ): Promise<ArtifactDetail> {
    const record = normalizeUpdateArtifactInput(input);

    return this.verifyIntegrity(
      await this.repository.update(actorUserId, artifactId, record),
    );
  }

  /** Reads the current version, or one exact historical version. */
  async get(
    actorUserId: string,
    artifactId: string,
    options: GetArtifactOptions = {},
  ): Promise<ArtifactDetail> {
    const version = normalizeGetArtifactOptions(options);

    return this.verifyIntegrity(
      await this.repository.get(actorUserId, artifactId, version),
    );
  }

  /** One bounded page of owned artifacts, newest first. */
  async list(
    actorUserId: string,
    options: ListArtifactsOptions = {},
  ): Promise<ArtifactPage> {
    const normalized = normalizeListArtifactsOptions(options);

    return this.repository.list(actorUserId, normalized);
  }

  /**
   * One bounded page of version metadata, newest first. Bodies are not selected,
   * so a metadata page cannot accidentally return generated content.
   */
  async listVersions(
    actorUserId: string,
    artifactId: string,
    options: ListArtifactVersionsOptions = {},
  ): Promise<ArtifactVersionPage> {
    const normalized = normalizeListArtifactVersionsOptions(options);

    return this.repository.listVersions(actorUserId, artifactId, normalized);
  }

  /** Explicit tombstone. Repeating it for the owner is idempotent. */
  async delete(actorUserId: string, artifactId: string): Promise<Artifact> {
    return this.repository.delete(actorUserId, artifactId);
  }

  /**
   * Copies a recorded version into a new appended version. This is the only
   * restore operation: the old body is read, never rewritten or reordered.
   */
  async restoreVersion(
    actorUserId: string,
    artifactId: string,
    version: number,
  ): Promise<ArtifactDetail> {
    const sourceVersion = normalizeArtifactVersion(version);

    return this.verifyIntegrity(
      await this.repository.restoreVersion(
        actorUserId,
        artifactId,
        sourceVersion,
      ),
    );
  }

  /**
   * Recomputes the digest and UTF-8 length of the returned body and compares
   * them with the metadata read from the same row. A tampered or internally
   * inconsistent version is refused instead of being handed to the caller.
   */
  private verifyIntegrity(detail: ArtifactDetail): ArtifactDetail {
    const actual = hashArtifactContent(detail.version.content);

    if (
      actual.contentSha256 !== detail.version.contentSha256 ||
      actual.byteSize !== detail.version.byteSize
    ) {
      throw new ArtifactIntegrityError();
    }

    return detail;
  }
}
