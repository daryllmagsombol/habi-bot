'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { CloseIcon } from '../ui';
import type { PanelId } from '../../lib/links';

export interface PanelCardProps {
  readonly panel: PanelId;
  readonly titleId: string;
  readonly closeHref: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

function modified(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/**
 * The panel frame: a full-height sheet in flow on a phone, a narrow card docked
 * at the right edge on a wide screen. It never takes a column from the reading
 * measure — the thread card keeps its width while the panel is open.
 */
export function PanelCard({ panel, titleId, closeHref, onClose, children }: Readonly<PanelCardProps>) {
  const title = panel === 'document' ? 'Document' : 'Context';

  return (
    <aside
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-line bg-surface lg:rounded-lg lg:border lg:shadow-lift"
    >
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4">
        <div className="min-w-0 flex-1">
          {/* On a phone the panel is the whole view, so its title is the page
           * heading. On a wide screen the Bot name already owns the h1. */}
          <h1 className="u-label truncate text-subtle lg:hidden">{title}</h1>
          <h2 id={titleId} className="u-label hidden truncate text-subtle lg:block">
            {title}
          </h2>
        </div>

        <Link
          href={closeHref}
          onClick={(event) => {
            if (modified(event)) {
              return;
            }

            event.preventDefault();
            onClose();
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm px-1 text-xs font-medium text-subtle transition-colors hover:text-ink"
        >
          <CloseIcon size={14} />
          Close panel
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}
