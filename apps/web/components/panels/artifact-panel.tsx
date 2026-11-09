'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, TextArea } from '../ui';
import { formatWhen } from '../../lib/api/format';
import { ARTIFACT_CONTENT_MAX_BYTES, utf8Bytes } from '../../lib/api/limits';
import { ArtifactForm } from './artifact-form';
import type {
  ArtifactFormValues,
  ArtifactMetadataFormValues,
} from './artifact-form';
import { PaginationFooter } from './pagination-footer';
import type { ArtifactDetailView, ArtifactSummaryView, ArtifactVersionView } from './types';

const COUNT = new Intl.NumberFormat('en-US');

export interface ArtifactPanelProps {
  readonly artifacts: readonly ArtifactSummaryView[];
  readonly detail?: ArtifactDetailView | undefined;
  readonly versions: readonly ArtifactVersionView[];
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly busy?: 'select' | 'save' | 'restore' | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  readonly onSelect: (artifactId: string) => void;
  /** Saves one new version. The cap is enforced before this is called. */
  readonly onSave: (content: string) => void;
  readonly onRestore: (version: number) => void;
  /** Present when the surface may create a record bound to the open thread. */
  readonly onCreate?: ((values: ArtifactFormValues) => void) | undefined;
  readonly createPending?: boolean | undefined;
  readonly createError?: string | undefined;
  readonly createStatus?: string | undefined;
  readonly canCreate?: boolean | undefined;
  readonly createDisabledNote?: string | undefined;
  /**
   * Present when the selected artifact's metadata may be edited. The callback
   * receives only `{title, kind, status}`; the content path below is separate.
   */
  readonly onUpdateMetadata?:
    | ((artifactId: string, values: ArtifactMetadataFormValues) => void)
    | undefined;
  readonly metadataPending?: boolean | undefined;
  readonly metadataError?: string | undefined;
  readonly metadataStatus?: string | undefined;
  /** Cursor paging for the artifact metadata list. */
  readonly hasMore?: boolean | undefined;
  readonly loadingMore?: boolean | undefined;
  readonly pagingError?: string | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  /** Cursor paging for the selected artifact's version metadata. */
  readonly versionsHasMore?: boolean | undefined;
  readonly versionsLoadingMore?: boolean | undefined;
  readonly versionsPagingError?: string | undefined;
  readonly onLoadMoreVersions?: (() => void) | undefined;
}

const CAP_HINT = `Artifact content is capped at 100 KB (${COUNT.format(
  ARTIFACT_CONTENT_MAX_BYTES,
)} bytes) per HTTP request.`;

/**
 * Artifacts for the open conversation: a metadata list, the selected body,
 * version metadata, and restore. The single-artifact response is nested
 * (`{ artifact: { artifact, version } }`), so the body always comes from the
 * version record the server hash-verified.
 *
 * The server accepts 1 MiB, but the HTTP transport caps a request at 100 KB. The
 * editor refuses an over-cap save and says why instead of sending a request that
 * can only answer 413.
 *
 * Restore is a confirmation, not a one-click action: it appends a new version
 * and never rewrites history. Both paging controls append the next cursor page
 * to the list above them; neither changes the current selection.
 *
 * Metadata and content are two distinct paths. The metadata editor sends only
 * `{title, kind, status}`; the API preserves the stored body and appends a
 * version. The content editor below sends the body and keeps history too.
 */
export function ArtifactPanel({
  artifacts,
  detail,
  versions,
  state,
  busy,
  error,
  status,
  onSelect,
  onSave,
  onRestore,
  onCreate,
  createPending = false,
  createError,
  createStatus,
  canCreate = true,
  createDisabledNote,
  onUpdateMetadata,
  metadataPending = false,
  metadataError,
  metadataStatus,
  hasMore = false,
  loadingMore = false,
  pagingError,
  onLoadMore,
  versionsHasMore = false,
  versionsLoadingMore = false,
  versionsPagingError,
  onLoadMoreVersions,
}: Readonly<ArtifactPanelProps>) {
  const id = useId();
  const [draftState, setDraftState] = useState<
    { readonly version: number; readonly value: string } | undefined
  >(undefined);
  const [creating, setCreating] = useState(false);
  const [metadataEditorFor, setMetadataEditorFor] = useState<string | undefined>(undefined);
  const [confirmVersion, setConfirmVersion] = useState<number | undefined>(undefined);
  const detailHeading = useRef<HTMLParagraphElement>(null);
  const wasBusy = useRef(false);

  const selectedVersion = detail?.version.version;
  const draft =
    selectedVersion !== undefined && draftState?.version === selectedVersion
      ? draftState.value
      : (detail?.content ?? '');

  const busyNow = createPending || metadataPending || busy !== undefined;
  const selectedArtifactId = detail?.artifact.id;
  const editingMetadata =
    selectedArtifactId !== undefined && metadataEditorFor === selectedArtifactId;
  const detailKey =
    detail === undefined ? undefined : `${detail.artifact.id}:${detail.version.version}`;

  // Move focus to the selected body after a create/save/restore completes. A
  // plain selection does not steal focus, and the status line is a live region.
  useEffect(() => {
    if (wasBusy.current && !busyNow && detailKey !== undefined) {
      detailHeading.current?.focus();
    }

    wasBusy.current = busyNow;
  }, [busyNow, detailKey]);

  const setDraft = (value: string) => {
    if (selectedVersion === undefined) {
      return;
    }

    setDraftState({ version: selectedVersion, value });
  };

  const createSection =
    onCreate === undefined ? null : (
      <div className="mb-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canCreate}
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Close new-artifact form' : 'New artifact'}
        </Button>
        {!canCreate && createDisabledNote === undefined ? null : (
          <p className="mt-1.5 text-2xs leading-relaxed text-subtle">
            {canCreate ? 'The new record is bound to the open conversation.' : createDisabledNote}
          </p>
        )}

        {creating ? (
          <div className="mt-3 rounded-sm border border-line-soft p-3">
            <ArtifactForm
              onSubmit={onCreate}
              pending={createPending}
              error={createError}
              status={createStatus}
              enabled={canCreate}
              disabledNote={createDisabledNote}
            />
          </div>
        ) : null}
      </div>
    );

  if ((state === 'loading' || state === 'idle') && artifacts.length === 0) {
    return (
      <div>
        {createSection}
        <p role="status" className="text-xs leading-relaxed text-muted">
          Loading artifacts…
        </p>
      </div>
    );
  }

  if (state === 'error' && artifacts.length === 0) {
    return (
      <div>
        {createSection}
        <p role="alert" className="text-xs leading-relaxed text-danger">
          {error ?? 'The artifact list could not be loaded. Nothing was invented.'}
        </p>
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div>
        {createSection}
        <p className="text-xs leading-relaxed text-muted">
          {onCreate === undefined
            ? 'The API returned no artifacts for this conversation. Creating one is not exposed by this interface.'
            : 'The API returned no artifacts for this conversation. Use “New artifact” to create one.'}
        </p>
      </div>
    );
  }

  const bytes = utf8Bytes(draft);
  const overCap = bytes > ARTIFACT_CONTENT_MAX_BYTES;
  const unchanged = detail !== undefined && draft === detail.content;
  const saving = busy === 'save';
  const canSave = detail !== undefined && !overCap && !unchanged && !saving;

  return (
    <div>
      {createSection}

      <ul className="border-t border-line-soft">
        {artifacts.map((artifact) => {
          const current = artifact.id === detail?.artifact.id;

          return (
            <li key={artifact.id} className="border-b border-line-soft">
              <button
                type="button"
                onClick={() => onSelect(artifact.id)}
                aria-current={current ? 'true' : undefined}
                className={[
                  'flex min-h-11 w-full items-center justify-between gap-2 rounded-sm px-1 py-2 text-left transition-colors',
                  'duration-[var(--habi-duration-fast)] ease-standard',
                  current ? 'bg-sunken' : 'hover:bg-sunken/60',
                ].join(' ')}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-ink">
                    {artifact.title}
                  </span>
                  <span className="u-figures mt-0.5 block text-2xs text-subtle">
                    {artifact.kind} · v{artifact.currentVersion} · {formatWhen(artifact.updatedAt)}
                  </span>
                </span>
                <Badge tone={artifact.status === 'final' ? 'accent' : 'neutral'}>
                  {artifact.status}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>

      {onLoadMore === undefined ? null : (
        <PaginationFooter
          hasMore={hasMore}
          loading={loadingMore}
          error={pagingError}
          label="Load more artifacts"
          loadingLabel="Loading more artifacts…"
          onLoadMore={onLoadMore}
        />
      )}

      {detail === undefined ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {busy === 'select' ? 'Loading the selected artifact…' : 'Select an artifact to read it.'}
        </p>
      ) : (
        <div className="mt-4">
          <p
            ref={detailHeading}
            tabIndex={-1}
            className="text-xs font-medium text-ink focus-visible:outline-offset-2"
          >
            {detail.artifact.title}
          </p>
          <p className="u-figures mt-0.5 text-2xs text-subtle">
            version {detail.version.version} · {COUNT.format(detail.version.byteSize)} bytes stored
            · read-only history, append-only saves
          </p>

          {onUpdateMetadata === undefined ? null : (
            <div className="mt-3 rounded-sm border border-line-soft p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-ink">Metadata</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={editingMetadata}
                  onClick={() =>
                    setMetadataEditorFor((current) =>
                      current === detail.artifact.id ? undefined : detail.artifact.id,
                    )
                  }
                >
                  {editingMetadata ? 'Close metadata editor' : 'Edit metadata'}
                </Button>
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-subtle">
                Title, kind and status are metadata. Saving them appends a version and leaves the
                stored content untouched; the content editor below is the separate path.
              </p>

              {editingMetadata ? (
                <div className="mt-3">
                  <ArtifactForm
                    key={`${detail.artifact.id}:${detail.artifact.currentVersion}`}
                    mode="metadata"
                    initialValues={{
                      title: detail.artifact.title,
                      kind: detail.artifact.kind,
                      content: detail.content,
                      status: detail.artifact.status === 'final' ? 'final' : 'draft',
                    }}
                    onSubmit={(values) =>
                      onUpdateMetadata(detail.artifact.id, {
                        title: values.title,
                        kind: values.kind,
                        status: values.status ?? 'draft',
                      })
                    }
                    pending={metadataPending}
                    error={metadataError}
                    status={metadataStatus}
                    enabled
                  />
                </div>
              ) : null}
            </div>
          )}

          <TextArea
            id={`${id}-artifact`}
            label="Artifact content"
            rows={10}
            className="mt-3"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            error={
              overCap
                ? `This body is ${COUNT.format(bytes)} bytes. Reduce it below the 100 KB transport cap before saving.`
                : undefined
            }
            hint={CAP_HINT}
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              loading={saving}
              disabled={!canSave}
              onClick={() => onSave(draft)}
            >
              Save new version
            </Button>
            <span className="u-figures text-2xs text-subtle">
              {COUNT.format(bytes)} / {COUNT.format(ARTIFACT_CONTENT_MAX_BYTES)} bytes
            </span>
            {selectedVersion === undefined ? null : (
              <span className="u-figures text-2xs text-subtle">
                editing from v{selectedVersion}
              </span>
            )}
          </div>

          {error === undefined ? null : (
            <p role="alert" className="mt-2 text-xs leading-relaxed text-danger">
              {error}
            </p>
          )}
          {status === undefined ? null : (
            <p role="status" aria-live="polite" className="mt-2 text-xs leading-relaxed text-subtle">
              {status}
            </p>
          )}

          <div className="mt-4 border-t border-line-soft pt-3">
            <p className="u-label text-subtle">Versions</p>
            {versions.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted">Version metadata is still loading.</p>
            ) : (
              <ul className="mt-1.5">
                {versions.map((version) => {
                  const current = version.version === detail.artifact.currentVersion;
                  const confirming = confirmVersion === version.version;

                  return (
                    <li
                      key={version.version}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft py-1.5 last:border-b-0"
                    >
                      <span className="u-figures text-2xs text-muted">
                        v{version.version} · {COUNT.format(version.byteSize)} bytes ·{' '}
                        {formatWhen(version.createdAt)}
                        {current ? ' · current' : ''}
                      </span>
                      {current ? null : confirming ? (
                        <div className="flex flex-col gap-1">
                          <p className="text-2xs leading-relaxed text-muted">
                            Restoring v{version.version} appends a new version. Earlier versions
                            are never rewritten.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              loading={busy === 'restore'}
                              onClick={() => {
                                setConfirmVersion(undefined);
                                onRestore(version.version);
                              }}
                            >
                              Restore v{version.version}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setConfirmVersion(undefined)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy === 'restore'}
                          onClick={() => setConfirmVersion(version.version)}
                        >
                          Restore v{version.version}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {onLoadMoreVersions === undefined ? null : (
              <PaginationFooter
                hasMore={versionsHasMore}
                loading={versionsLoadingMore}
                error={versionsPagingError}
                label="Load older versions"
                loadingLabel="Loading older versions…"
                onLoadMore={onLoadMoreVersions}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
