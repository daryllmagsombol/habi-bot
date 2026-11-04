import { Badge, Button, DocumentIcon, EmptyState } from '../ui';
import type { DocumentView } from './types';

export interface DocumentPanelProps {
  readonly document?: DocumentView | undefined;
  readonly threadTitle: string;
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

/**
 * The attached document, read-only. A citation in the conversation links here
 * with an anchor, so the claim and the sentence it came from are one click
 * apart. The cited paragraph is the only highlighted text — the apricot mark
 * means "a reply used this", not "this is important".
 */
export function DocumentPanel({ document, threadTitle }: Readonly<DocumentPanelProps>) {
  if (document === undefined) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          headingLevel={2}
          mark={<DocumentIcon size={16} />}
          title="No document in this thread"
          description={
            <>
              A document attached to “{threadTitle}” would open here, read-only, and replies could
              cite it by paragraph. Attachment upload is not wired in this preview.
            </>
          }
          action={<Button disabled>Attach a document</Button>}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 border-b border-line-soft pb-3.5">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-sm border border-line bg-canvas text-muted"
        >
          <DocumentIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{document.name}</p>
          <p className="u-figures mt-0.5 text-2xs text-subtle">
            {document.bytes} · attached {document.attachedAt} · read-only
          </p>
        </div>
        <Badge tone="signal">¶ {document.citedParagraph}</Badge>
      </div>

      <div className="mt-4 space-y-3 text-[0.875rem] leading-relaxed text-muted">
        {renderBlocks(document)}
      </div>

      <p className="mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-subtle">
        Cited in the reply above · paragraph {document.citedParagraph}. Attachments are read-only
        input: a bot can read one, never change it.
      </p>
    </div>
  );
}
