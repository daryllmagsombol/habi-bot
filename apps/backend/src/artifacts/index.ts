/**
 * H-028 (#28) artifact exports.
 *
 * Importing this barrel creates nothing and touches no database. `ArtifactService`
 * is constructed explicitly by the composing lane; no Nest provider or HTTP
 * route is added in this slice.
 */
export { ArtifactRepository } from './artifact-repository.js';
export { ArtifactService } from './artifact-service.js';
export { ArtifactIntegrityError } from './errors.js';
export {
  decodeArtifactCursor,
  decodeArtifactVersionCursor,
  encodeArtifactCursor,
  encodeArtifactVersionCursor,
  type ArtifactCursor,
} from './cursor.js';
export {
  hashArtifactContent,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_TITLE_LENGTH,
  MAX_ARTIFACT_VERSION,
  MIN_ARTIFACT_TITLE_LENGTH,
  MIN_ARTIFACT_VERSION,
  normalizeArtifactContent,
  normalizeArtifactKind,
  normalizeArtifactTitle,
  normalizeArtifactVersion,
  normalizeCreateArtifactInput,
  normalizeGetArtifactOptions,
  normalizeListArtifactVersionsOptions,
  normalizeListArtifactsOptions,
  normalizeUpdateArtifactInput,
  normalizeWritableArtifactStatus,
  type NormalizedListArtifactVersionsOptions,
  type NormalizedListArtifactsOptions,
} from './validation.js';
export type {
  Artifact,
  ArtifactContentHash,
  ArtifactDetail,
  ArtifactKind,
  ArtifactPage,
  ArtifactRecord,
  ArtifactStatus,
  ArtifactVersion,
  ArtifactVersionMetadata,
  ArtifactVersionPage,
  CreateArtifactInput,
  CreateArtifactRecord,
  GetArtifactOptions,
  ListArtifactVersionsOptions,
  ListArtifactsOptions,
  UpdateArtifactInput,
  UpdateArtifactRecord,
  WritableArtifactStatus,
} from './types.js';
