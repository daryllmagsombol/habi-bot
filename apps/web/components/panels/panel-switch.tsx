'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';
import { DocumentIcon, GatesIcon } from '../ui';
import type { PanelId } from '../../lib/links';

const ITEMS = [
  { key: 'document', label: 'Document', Icon: DocumentIcon },
  { key: 'context', label: 'Context', Icon: GatesIcon },
] as const;

export interface PanelSwitchProps {
  readonly panel: PanelId | undefined;
  readonly documentHref: string;
  readonly contextHref: string;
  readonly conversationHref: string;
  readonly onSelect: (panel: PanelId) => void;
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
 * One compact control for the evidence beside the thread: Document and Context.
 *
 * It is a pair of links, not tabs: each state is a real URL, so the panel can be
 * linked, reloaded, and opened in a new tab. Choosing the open panel again
 * closes it, which is what makes the control a toggle. On a phone the labels
 * collapse to icons so the workspace bar keeps its shape at 320px.
 */
export function PanelSwitch({
  panel,
  documentHref,
  contextHref,
  conversationHref,
  onSelect,
}: Readonly<PanelSwitchProps>) {
  return (
    <nav
      aria-label="Thread panels"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-card"
    >
      {ITEMS.map(({ key, label, Icon }) => {
        const current = panel === key;
        const href = current ? conversationHref : key === 'document' ? documentHref : contextHref;

        return (
          <Link
            key={key}
            href={href}
            data-panel={key}
            aria-label={`${label} panel`}
            aria-current={current ? 'page' : undefined}
            title={`${label} panel`}
            onClick={(event) => {
              if (modified(event)) {
                return;
              }

              event.preventDefault();
              onSelect(key);
            }}
            className={[
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-2xs font-semibold',
              'transition-colors duration-[var(--habi-duration-fast)] ease-standard',
              current
                ? 'bg-accent-soft text-accent-ink'
                : 'text-subtle hover:bg-sunken hover:text-ink',
            ].join(' ')}
          >
            <Icon size={16} />
            <span aria-hidden="true" className="hidden lg:inline">
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
