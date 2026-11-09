import { Badge, Button, DocumentIcon, EmptyState } from '../ui';
import type { DocumentView } from './types';

export interface DocumentPanelProps {
  readonly documents?: readonly DocumentView[] | undefined;
  readonly threadTitle: string;
  /** `live` drops the preview-only sentence for data-backed screens. */
  readonly mode?: 'preview' | 'live';
}

function renderBlocks(document: DocumentView) {
  let paragraphNumber = 0;

  return document.blocks.map((block, index) => {
    if (block.kind === 'heading') {
      return (
        <h2
          key={index}
          className="mt-4 text-sm leading-snug font-semibold tracking-heading text-ink first:mt-0"
        >
          {block.text}
        </h2>
      );
    }

    if (block.kind === 'list') {
      return (
        <ul key={index} className="list-disc space-y-1 pl-5">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    }

    paragraphNumber += 1;
    const paragraphId = `${document.id}-${paragraphNumber}`;

    if (block.cited === true) {
      return (
        <p key={index} id={paragraphId} className="scroll-mt-20">
          <mark className="rounded-xs bg-signal-mark px-1 py-0.5 text-ink box-decoration-clone">
            {block.text}
          </mark>
        </p>
      );
    }

    return <p key={index}>{block.text}</p>;
  });
}

function ContentState({ document }: Readonly<{ document: DocumentView }>) {
  const state = document.contentState ?? 'ready';

  if (state === 'unavailable') {
    return (
      <div className="rounded-sm border border-line-strong bg-sunken px-3.5 py-3">
        <p className="text-sm font-medium text-ink">Not stored on this server</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {document.contentMessage ??
            'The attachment metadata is available, but this server has no attachment storage root configured, so the text cannot be read. Nothing is shown in its place.'}
        </p>
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div className="rounded-sm border border-line-strong bg-sunken px-3.5 py-3">
        <p className="text-sm font-medium text-ink">Not a readable text attachment</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {document.contentMessage ??
            'Only text/plain and text/markdown attachments can be read here. The bytes were not replaced with sample content.'}
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="rounded-sm border border-line-strong bg-sunken px-3.5 py-3">
        <p className="text-sm font-medium text-ink">The stored text could not be read</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {document.contentMessage ?? 'The content request failed. Nothing was invented.'}
        </p>
      </div>
    );
  }

  if (document.blocks.length === 0) {
    return <p className="text-xs leading-relaxed text-muted">The stored file is empty.</p>;
  }

  return <>{renderBlocks(document)}</>;
}

function DocumentSection({
  document,
  index,
  live,
}: Readonly<{ document: DocumentView; index: number; live: boolean }>) {
  const cited = document.citedParagraph > 0;

  return (
    <section
      aria-labelledby={`document-${index}-title`}
      className={index === 0 ? '' : 'mt-5 border-t border-line-soft pt-5'}
    >
      <div className="flex items-start gap-3 border-b border-line-soft pb-3.5">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-sm border border-line bg-canvas text-muted"
        >
          <DocumentIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p id={`document-${index}-title`} className="truncate text-sm font-medium text-ink">
            {document.name}
          </p>
          <p className="u-figures mt-0.5 text-2xs text-subtle">
            {document.bytes} · attached {document.attachedAt} · read-only
            {document.contentType === undefined ? '' : ` · ${document.contentType}`}
          </p>
        </div>
        {cited ? <Badge tone="signal">¶ {document.citedParagraph}</Badge> : null}
      </div>

      <div className="mt-4 space-y-3 text-[0.875rem] leading-relaxed text-muted">
        <ContentState document={document} />
      </div>

      {live ? (
        <p className="mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-subtle">
          Attachments are read-only input for a Bot. The panel never edits the stored file.
        </p>
      ) : cited ? (
        <p className="mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-subtle">
          Cited in the reply above · paragraph {document.citedParagraph}. Attachments are read-only
          input: a bot can read one, never change it.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The attached documents, read-only. A citation in the conversation links here
 * with an anchor, so the claim and the sentence it came from are one click
 * apart. The cited paragraph is the only highlighted text — the apricot mark
 * means "a reply used this", not "this is important".
 *
 * In live mode the metadata always renders. When the content route answers
 * `503 api_unavailable`, the panel states that this server does not store
 * attachment bytes; it never falls back to sample text.
 */
export function DocumentPanel({
  documents,
  threadTitle,
  mode = 'preview',
}: Readonly<DocumentPanelProps>) {
  const live = mode === 'live';

  if (documents === undefined || documents.length === 0) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          headingLevel={2}
          mark={<DocumentIcon size={16} />}
          title="No document in this thread"
          description={
            live ? (
              <>
                No attachment metadata is shown for “{threadTitle}”. Attachment upload is not
                exposed by this API, so there is nothing to open here.
              </>
            ) : (
              <>
                A document attached to “{threadTitle}” would open here, read-only, and replies could
                cite it by paragraph. Attachment upload is not wired in this preview.
              </>
            )
          }
          action={<Button disabled>Attach a document</Button>}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      {documents.map((document, index) => (
        <DocumentSection
          key={document.id}
          document={document}
          index={index}
          live={live}
        />
      ))}
    </div>
  );
}
