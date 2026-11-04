import Link from 'next/link';
import type { ReactNode } from 'react';
import { CloseIcon } from './icons';
import { Toolbar } from './toolbar';

export interface SheetProps {
  readonly title: string;
  /** Id for the heading that names this region. */
  readonly titleId: string;
  /** Closing the sheet is navigation, not a hidden state: it is a real URL. */
  readonly closeHref: string;
  readonly closeLabel?: string;
  /** Extra controls in the sheet header, kept next to the close action. */
  readonly actions?: ReactNode;
  /** Closes in place; the link still works without it. */
  readonly onClose?: () => void;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * The evidence panel: a full-height column beside the conversation on wide
 * screens, and a full-screen sheet in flow on narrow ones.
 *
 * It is not a modal. Panels are route state (`?panel=`), so the rail and the
 * conversation are not rendered underneath on a phone, focus never lands on
 * hidden content, and the close control is a plain link with a 44px target.
 */
export function Sheet({
  title,
  titleId,
  closeHref,
  closeLabel = 'Close panel',
  actions,
  onClose,
  className,
  children,
}: Readonly<SheetProps>) {
  return (
    <aside
      aria-labelledby={titleId}
      className={[
        'flex min-h-0 flex-col bg-surface lg:border-l lg:border-line',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Toolbar tone="surface" bordered justify="between" className="gap-3 px-4 lg:px-6">
        <h2 id={titleId} className="u-label min-w-0 flex-1 truncate text-subtle">
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <Link
            href={closeHref}
            onClick={(event) => {
              if (onClose === undefined || event.metaKey || event.ctrlKey || event.shiftKey) {
                return;
              }

              event.preventDefault();
              onClose();
            }}
            className="inline-flex min-h-11 items-center gap-1.5 px-1 text-xs font-medium text-muted hover:text-ink"
          >
            <CloseIcon size={14} />
            {closeLabel}
          </Link>
        </div>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}
