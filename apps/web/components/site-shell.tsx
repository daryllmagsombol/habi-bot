import Link from 'next/link';
import type { ReactNode } from 'react';
import { Container } from './ui/container';
import { SkipLink } from './ui/skip-link';
import { Badge } from './ui/badge';
import { ThemeToggle } from './theme/theme-toggle';
import { Wordmark } from './wordmark';

export interface SiteShellProps {
  /** Shown in the header stamp, e.g. "Interface preview". */
  readonly label?: string;
  /** Optional header navigation. The wordmark is always present. */
  readonly nav?: ReactNode;
  readonly footerLeft?: ReactNode;
  readonly footerRight?: ReactNode;
  readonly children: ReactNode;
}

/**
 * Public chrome: skip link, wordmark masthead, main landmark, colophon.
 *
 * The workspace uses `AppBar` instead, because its panes need a sticky bar and
 * a breadcrumb. Both routes keep the same focus order: skip link, wordmark,
 * nav, main.
 */
export function SiteShell({ label = 'Interface preview', nav, footerLeft, footerRight, children }: Readonly<SiteShellProps>) {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur-[10px]">
        <Container
          size="wide"
          className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
        >
          <div className="flex items-center gap-4">
            <Wordmark href="/" label="Habi, home" />
            {nav === undefined ? null : (
              <div className="hidden items-center gap-4 sm:flex">
                <span aria-hidden="true" className="h-4 w-px bg-line" />
                <nav aria-label="Preview" className="flex items-center gap-1">
                  {nav}
                </nav>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Badge tone="outline">{label}</Badge>
          </div>
        </Container>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>

      <footer className="border-t border-line">
        <Container
          size="wide"
          className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-6 text-xs text-muted"
        >
          <span>{footerLeft ?? 'Habi'}</span>
          {footerRight === undefined ? null : <span className="u-label text-subtle">{footerRight}</span>}
        </Container>
      </footer>
    </div>
  );
}

export interface SiteNavLinkProps {
  readonly href: string;
  readonly current?: boolean;
  readonly children: ReactNode;
}

/** A quiet header link that still clears the 44px target. */
export function SiteNavLink({ href, current = false, children }: Readonly<SiteNavLinkProps>) {
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={[
        'inline-flex min-h-11 items-center rounded-xs px-2.5 text-xs font-medium transition-colors duration-[var(--habi-duration-fast)] ease-standard',
        current ? 'bg-sunken text-ink' : 'text-muted hover:bg-sunken/60 hover:text-ink',
      ].join(' ')}
    >
      {children}
    </Link>
  );
}
