'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, CloseIcon, IconButton, MenuIcon, Pill } from './ui';
import { ThemeToggle } from './theme/theme-toggle';
import { Wordmark } from './wordmark';

const COUNT = new Intl.NumberFormat('en-US');

export interface AppBarCounts {
  readonly bots: number;
  readonly threads: number;
}

export interface AppBarAllowance {
  readonly used: number;
  readonly limit: number;
  readonly reset: string;
}

export interface AppBarProps {
  /** Route the bar treats as the current section. */
  readonly section?: 'bots' | 'threads';
  /** Right-side controls that belong to the page, e.g. the panel switch. */
  readonly actions?: ReactNode;
  /** Section totals come from the route, not from the chrome. */
  readonly counts: AppBarCounts;
  /** Absent when the API cannot report daily usage; the bar says so. */
  readonly allowance?: AppBarAllowance | undefined;
  /** `preview` labels sample data; `live` labels records from the API. */
  readonly mode?: 'preview' | 'live';
  readonly className?: string;
}

function navItemClass(current: boolean): string {
  return [
    'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap',
    'transition-colors duration-[var(--habi-duration-fast)] ease-standard',
    current ? 'bg-sunken font-semibold text-ink' : 'text-subtle hover:bg-sunken/60 hover:text-ink',
  ].join(' ');
}

const SECTIONS = [
  { key: 'bots', label: 'Bots', href: '/bots' },
  { key: 'threads', label: 'Threads', href: '/threads' },
] as const;

/**
 * The workspace chrome: wordmark, section pills, the daily allowance, the
 * page's own controls, the theme switch, and — on a phone — a menu instead of
 * the pills.
 *
 * The `Preview` tag is not decoration. Every screen built on local sample data
 * carries it, and the page copy states the same thing in words. Nothing in this
 * bar is a product control: the panel switch and the theme toggle are the only
 * actions, and both are plain links or a toggle.
 */
export function AppBar({
  section,
  actions,
  counts,
  allowance,
  mode = 'preview',
  className,
}: Readonly<AppBarProps>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const usedPercent =
    allowance === undefined ? 0 : Math.min(100, (allowance.used / allowance.limit) * 100);
  const live = mode === 'live';

  const sectionCounts: Record<(typeof SECTIONS)[number]['key'], number> = {
    bots: counts.bots,
    threads: counts.threads,
  };

  return (
    <header
      className={[
        'sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur-[10px]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="mx-auto flex min-h-14 w-full max-w-wide items-center gap-2 px-4 sm:px-6">
        <Wordmark />

        <nav aria-label="Workspace" className="ml-1 hidden items-center gap-0.5 md:flex">
          {SECTIONS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={section === item.key ? 'page' : undefined}
              className={navItemClass(section === item.key)}
            >
              {item.label}
              <Pill tone="surface" size="xs" className="u-figures min-w-5 justify-center">
                {sectionCounts[item.key]}
              </Pill>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {actions}

          {actions === undefined ? (
            allowance === undefined ? null : (
              <Pill as="span" tone="sunken" size="sm" className="md:hidden">
                <span aria-hidden="true" className="block h-1 w-6 overflow-hidden rounded-full bg-line">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${usedPercent.toFixed(2)}%` }}
                  />
                </span>
                <span className="u-figures whitespace-nowrap">
                  <b className="font-semibold text-ink">{(allowance.used / 1000).toFixed(1)}k</b>
                  /{allowance.limit / 1000}k
                </span>
                <span className="sr-only">
                  {COUNT.format(allowance.used)} of {COUNT.format(allowance.limit)} tokens
                  used today.
                </span>
              </Pill>
            )
          ) : null}

          {allowance === undefined ? (
            <Pill tone="sunken" size="md" className="max-md:hidden">
              Usage unavailable
            </Pill>
          ) : (
            <Pill tone="sunken" size="md" className="max-md:hidden">
              <span aria-hidden="true" className="block h-1 w-8 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${usedPercent.toFixed(2)}%` }}
                />
              </span>
              <span className="u-figures whitespace-nowrap">
                <b className="font-semibold text-ink">{COUNT.format(allowance.used)}</b>
                {' / '}
                {COUNT.format(allowance.limit)}
              </span>
              <span className="sr-only">
                tokens used today. Resets at {allowance.reset}.
              </span>
            </Pill>
          )}

          <span
            className={
              actions === undefined ? 'hidden sm:inline-flex' : 'hidden lg:inline-flex'
            }
          >
            <Badge tone="outline">{live ? 'Live' : 'Preview'}</Badge>
          </span>

          <ThemeToggle />

          <IconButton
            label={menuOpen ? 'Close menu' : 'Open menu'}
            icon={menuOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
            variant="surface"
            aria-expanded={menuOpen}
            aria-controls="workspace-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="md:hidden"
          />
        </div>
      </div>

      <div
        id="workspace-menu"
        hidden={!menuOpen}
        className="border-t border-line bg-canvas px-4 pb-4 sm:px-6 md:hidden"
      >
        <nav aria-label="Workspace menu" className="py-1">
          {SECTIONS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={section === item.key ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
              className="flex min-h-11 items-center justify-between gap-3 border-b border-line-soft px-1 text-sm text-ink last:border-b-0"
            >
              {item.label}
              <span className="u-figures text-2xs text-subtle">{sectionCounts[item.key]}</span>
            </Link>
          ))}
        </nav>

        {allowance === undefined ? (
          <p className="mt-3 px-1 text-xs leading-relaxed text-subtle">
            Daily usage is not reported by this API, so no figure is shown.
          </p>
        ) : (
          <Pill as="p" tone="sunken" size="md" className="mt-3 w-full flex-wrap">
            <span aria-hidden="true" className="block h-1 w-8 overflow-hidden rounded-full bg-line">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${usedPercent.toFixed(2)}%` }}
              />
            </span>
            <span className="u-figures">
              <b className="font-semibold text-ink">{COUNT.format(allowance.used)}</b>
              {' / '}
              {COUNT.format(allowance.limit)} today
            </span>
            <span className="w-full text-subtle">Resets at {allowance.reset}.</span>
          </Pill>
        )}

        <p className="mt-3 px-1 text-xs leading-relaxed text-subtle">
          {live
            ? 'Live data from the Habi API. Messages are saved on the server; a reply appears only when the worker writes one.'
            : 'Interface preview · local sample data. Nothing is saved and no model is called.'}
        </p>
      </div>
    </header>
  );
}
