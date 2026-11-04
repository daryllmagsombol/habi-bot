import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Container } from '../../components/ui/container';
import { SiteNavLink, SiteShell } from '../../components/site-shell';

export const metadata: Metadata = {
  title: 'Identity preview',
  description:
    'Invite-only identity preview for Habi: email/password signup, login, and recovery.',
};

const BOUNDARIES = [
  ['Session', 'Same-origin proxy'],
  ['Recovery email', 'Not delivered'],
  ['Single sign-on', 'Not supported'],
  ['Workspace behind it', 'Not connected'],
] as const;

/**
 * The form column sits on the same grid line as the wordmark, with the preview
 * boundary stated beside it. Putting the limits on the page — not in a tooltip —
 * is the point: an identity form is the easiest place to imply a product that
 * does not exist yet.
 */
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SiteShell
      label="Identity preview"
      nav={
        <>
          <SiteNavLink href="/bots">Bots</SiteNavLink>
          <SiteNavLink href="/start" current>
            Identity
          </SiteNavLink>
        </>
      }
      footerLeft="Habi · Identity preview"
      footerRight="Invite-only while the POC is under construction."
    >
      <Container size="wide" className="py-10 sm:py-14 lg:py-16">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-20">
          <div>{children}</div>

          <aside aria-label="Preview boundaries" className="hidden lg:block lg:border-l lg:border-line lg:pl-12">
            <div className="max-w-[21rem]">
              <p className="u-label text-subtle">In this preview</p>
              <dl className="mt-3 border-t border-line">
                {BOUNDARIES.map(([term, value]) => (
                  <div
                    key={term}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-2.5"
                  >
                    <dt className="text-sm text-muted">{term}</dt>
                    <dd className="u-figures text-xs font-medium text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-xs leading-relaxed text-muted">
                The identity screens call a same-origin proxy that forwards to the local auth
                API. Nothing on this page reaches a model.
              </p>
            </div>
          </aside>
        </div>
      </Container>
    </SiteShell>
  );
}
