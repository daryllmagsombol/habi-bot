import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { DocumentIcon } from '../ui/icons';
import type { PreviewAttachment } from '../../lib/preview-data';

export interface DocumentPanelProps {
  readonly attachment: PreviewAttachment | undefined;
  readonly threadTitle: string;
}

function renderBlocks(attachment: PreviewAttachment) {
  let paragraphNumber = 0;

  return attachment.blocks.map((block, index) => {
    if (block.kind === 'heading') {
      return (
        <h3 key={index} className="mt-5 text-title tracking-heading text-ink first:mt-0">
          {block.text}
        </h3>
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
    const paragraphId = `${attachment.id}-${paragraphNumber}`;

    if (block.cited === true) {
      return (
        <p key={index} id={paragraphId} className="scroll-mt-20">
          <mark className="rounded-xs bg-signal-mark px-1 py-0.5 text-ink box-decoration-clone">{block.text}</mark>
        </p>
      );
    }

    return <p key={index}>{block.text}</p>;
  });
}

/**
 * The attached document, read-only.
 *
 * A citation in the conversation links here with an anchor, so the claim and the
 * sentence it came from are one click apart. The cited paragraph is the only
 * highlighted text in the panel — the orange mark means "a reply used this",
 * not "this is important".
 */
export function DocumentPanel({ attachment, threadTitle }: Readonly<DocumentPanelProps>) {
  if (attachment === undefined) {
    return (
      <div className="px-4 py-6 lg:px-6">
        <EmptyState
          mark={<DocumentIcon size={16} />}
          title="No document in this thread"
          description={
            <>
              A document attached to “{threadTitle}” would open here, read-only, and
              replies could cite it by paragraph. Attachment upload is not wired in
              this preview.
            </>
          }
          action={<Button disabled>Attach a document</Button>}
        />
      </div>
    );
  }

  return (
    <div className="px-4 py-5 lg:px-6">
      <div className="flex items-start gap-3 border-b border-line pb-4">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-xs border border-line bg-canvas text-muted"
        >
          <DocumentIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{attachment.name}</p>
          <p className="u-figures mt-0.5 text-2xs text-muted">
            {attachment.bytes} · attached {attachment.attachedAt} · read-only
          </p>
        </div>
        <Badge tone="signal">¶ {attachment.citedParagraph}</Badge>
      </div>

      <div className="mt-5 space-y-3 text-sm leading-relaxed text-muted">
        {renderBlocks(attachment)}
      </div>

      <p className="mt-5 border-t border-line pt-3 text-xs leading-relaxed text-muted">
        Cited in the reply above · paragraph {attachment.citedParagraph}. Attachments are
        read-only input: a Bot can read one, never change it.
      </p>
    </div>
  );
}
