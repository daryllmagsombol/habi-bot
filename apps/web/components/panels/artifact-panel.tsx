'use client';

import { useId, useState } from 'react';
import { Badge, Button, TextArea } from '../ui';
import { formatWhen } from '../../lib/api/format';
import { ARTIFACT_CONTENT_MAX_BYTES, utf8Bytes } from '../../lib/api/limits';
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
}: Readonly<ArtifactPanelProps>) {
  const id = useId();
  const [draftState, setDraftState] = useState<
    { readonly version: number; readonly value: string } | undefined
  >(undefined);
  const selectedVersion = detail?.version.version;
  const draft =
    selectedVersion !== undefined && draftState?.version === selectedVersion
      ? draftState.value
      : (detail?.content ?? '');

  const setDraft = (value: string) => {
    if (selectedVersion === undefined) {
      return;
    }

    setDraftState({ version: selectedVersion, value });
  };

  if ((state === 'loading' || state === 'idle') && artifacts.length === 0) {
    return <p className="text-xs leading-relaxed text-muted">Loading artifacts…</p>;
  }

  if (state === 'error' && artifacts.length === 0) {
    return (
      <p role="alert" className="text-xs leading-relaxed text-danger">
        {error ?? 'The artifact list could not be loaded. Nothing was invented.'}
      </p>
    );
  }

  if (artifacts.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        The API returned no artifacts for this conversation. Creating one is not exposed by this
        interface.
      </p>
    );
  }

  const bytes = utf8Bytes(draft);
  const overCap = bytes > ARTIFACT_CONTENT_MAX_BYTES;
  const unchanged = detail !== undefined && draft === detail.content;
  const saving = busy === 'save';
  const canSave = detail !== undefined && !overCap && !unchanged && !saving;

  return (
    <div>
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

      {detail === undefined ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {busy === 'select' ? 'Loading the selected artifact…' : 'Select an artifact to read it.'}
        </p>
      ) : (
        <div className="mt-4">
          <p className="text-xs font-medium text-ink">{detail.artifact.title}</p>
          <p className="u-figures mt-0.5 text-2xs text-subtle">
            version {detail.version.version} · {COUNT.format(detail.version.byteSize)} bytes stored
            · read-only history, append-only saves
          </p>

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
                      {current ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={busy === 'restore'}
                          onClick={() => onRestore(version.version)}
                        >
                          Restore v{version.version}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
