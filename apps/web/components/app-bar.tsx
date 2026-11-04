'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from './ui/badge';
import { ThemeToggle } from './theme/theme-toggle';
import { ChevronLeftIcon } from './ui/icons';
import { previewAllowance, formatCount } from '../lib/preview-data';

export interface AppBarProps {
  /** Route the app bar treats as the current section. */
  readonly section?: 'bots' | 'identity';
  /** The object being viewed, e.g. a Bot name. Truncates before it wraps. */
  readonly title?: ReactNode;
  /** Mobile-only back control. Desktop navigation is the breadcrumb. */
  readonly backHref?: string;
  readonly backLabel?: string;
  /** Closes one level in place; the link still navigates without it. */
  readonly onBack?: (() => void) | undefined;
  /** Right-side controls, e.g. the panel toggle. */
  readonly actions?: ReactNode;
  readonly showAllowance?: boolean;
  /** Panes run edge to edge: the bar pads to the window instead of centring. */
  readonly fluid?: boolean;
  /** Extra row under the bar, e.g. the mobile Thread / Document / Context tabs. */
  readonly children?: ReactNode;
  readonly className?: string;
}

function navItemClass(current: boolean): string {
  return [
    'inline-flex min-h-11 items-center rounded-xs px-2.5 text-xs font-medium transition-colors',
    'duration-[var(--habi-duration-fast)] ease-standard',
    current ? 'bg-sunken text-ink' : 'text-muted hover:bg-sunken/60 hover:text-ink',
  ].join(' ');
}

/**
 * Workspace chrome: wordmark, section nav, the current object, and the sample
 * allowance. The bar is sticky because the panes below it scroll independently
 * on a desktop; it stays one 56px hairline rather than becoming a hero.
 *
 * The `Preview` badge is not decoration. Every screen built on local sample
 * data carries it, and the page copy states the same thing in words.
 */
export function AppBar({
  section,
  title,
  backHref,
  backLabel = 'back',
  onBack,
  actions,
  showAllowance = true,
  fluid = false,
  children,
  className,
}: Readonly<AppBarProps>) {
  const usedPercent = Math.min(100, (previewAllowance.used / previewAllowance.limit) * 100);

  return (
    <header
      className={['sticky top-0 z-30 border-b border-line bg-surface', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={[
          'flex min-h-14 w-full items-center gap-2',
          fluid ? 'px-4 lg:px-6' : 'mx-auto max-w-wide px-gutter',
        ].join(' ')}
      >
        {backHref === undefined ? null : (
          <Link
            href={backHref}
            aria-label={`Back to ${backLabel}`}
            onClick={(event) => {
              if (onBack === undefined || event.metaKey || event.ctrlKey || event.shiftKey) {
                return;
              }

              event.preventDefault();
              onBack();
            }}
            className="-ml-2 inline-flex size-11 items-center justify-center rounded-sm text-muted hover:bg-sunken hover:text-ink lg:hidden"
          >
            <ChevronLeftIcon size={18} />
          </Link>
        )}

        <Link
          href="/"
          className={[
            'u-brand inline-flex min-h-11 shrink-0 items-center text-ink',
            backHref === undefined ? '' : 'hidden lg:inline-flex',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          Habi
        </Link>

        <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-line md:block" />

        <nav aria-label="Workspace" className="hidden items-center gap-1 md:flex">
          <Link
            href="/bots"
            aria-current={section === 'bots' ? 'page' : undefined}
            className={navItemClass(section === 'bots')}
          >
            Bots
          </Link>
          <Link
            href="/start"
            aria-current={section === 'identity' ? 'page' : undefined}
            className={navItemClass(section === 'identity')}
          >
            Account
          </Link>
        </nav>

        {title === undefined ? null : (
          <>
            <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-line md:block" />
            <h1 className="min-w-0 flex-1 truncate font-body text-sm leading-normal font-medium tracking-normal text-ink md:ml-1 md:max-w-[22rem] md:flex-none">
              {title}
            </h1>
          </>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}

          <ThemeToggle />

          {showAllowance ? (
            <span className="hidden items-center gap-2 md:flex">
              <span aria-hidden="true" className="relative block h-[3px] w-10 bg-sunken">
                <span
                  className="absolute inset-y-0 left-0 bg-accent"
                  style={{ width: `${usedPercent.toFixed(2)}%` }}
                />
              </span>
              <span className="u-figures text-2xs text-muted">
                <b className="font-semibold text-ink">{formatCount(previewAllowance.used)}</b>
                {' / '}
                {formatCount(previewAllowance.limit)}
                <span className="sr-only"> tokens used today. Resets at {previewAllowance.reset}.</span>
              </span>
            </span>
          ) : null}

          <Badge tone="outline">Preview</Badge>
        </div>
      </div>

      {children === undefined ? null : (
        <div
        className={[
          'border-t border-line py-1.5 lg:hidden',
          fluid ? 'px-4' : 'px-gutter',
        ].join(' ')}
      >
        {children}
      </div>
      )}
    </header>
  );
}
