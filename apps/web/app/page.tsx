import Link from 'next/link';
import { ArrowRightIcon } from '../components/ui/icons';
import { Container } from '../components/ui/container';
import { SiteNavLink, SiteShell } from '../components/site-shell';
import { WeaveFigure } from '../components/weave-figure';

const PREVIEW_ITEMS = [
  'A gallery of Bots, each with its own instructions and memory',
  'Thread lists and conversations, with the run a reply belongs to',
  'Document and Context panels: the cited note, memory gates, tokens, allow-list',
  'Identity screens: log in, create an account, request recovery',
];

const NOT_HERE_ITEMS = [
  'Saved messages, real Bots, or a workspace behind the sign-in',
  'Model calls or run dispatch — nothing is sent anywhere',
  'Tool use. The allow-list is empty, and Bots cannot call tools',
  'Hermes, uploads, queueing, or deployment',
];

const PROVEN_ITEMS = [
  'The workspace, web shell, and one shared token and component system',
  'The Nest health endpoint and the worker boot path',
  'Local PostgreSQL Compose tooling',
  'The build, typecheck, lint, and smoke tests you can run yourself',
];

function ScopeList({ title, items }: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <section>
      <h3 className="u-label text-subtle">{title}</h3>
      <ul className="mt-3 border-t border-line">
        {items.map((item) => (
          <li key={item} className="border-b border-line py-2.5 text-sm leading-relaxed text-muted">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HomePage() {
  return (
    <SiteShell
      label="Interface preview"
      nav={
        <>
          <SiteNavLink href="/bots">Bots</SiteNavLink>
          <SiteNavLink href="/start">Identity</SiteNavLink>
        </>
      }
      footerLeft="Habi · Repository foundation"
      footerRight="Just the first threads."
    >
      <Container size="wide" className="border-b border-line">
        <div className="grid items-end gap-10 py-12 sm:py-16 lg:grid-cols-12 lg:gap-12 lg:py-20">
          <div className="lg:col-span-7">
            <h1 className="max-w-[12ch] text-display tracking-display text-ink">
              Weave ideas into action.
            </h1>
            <p className="mt-6 max-w-[46ch] text-lead leading-relaxed text-muted">
              Every idea needs a starting point. This is ours: a small workspace
              for Bots with their own instructions, their own memory, and
              conversations you can check.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/bots"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-sm bg-accent px-5 text-sm font-medium text-on-accent transition-colors duration-[var(--habi-duration-fast)] ease-standard hover:bg-accent-hover"
              >
                Look inside the preview
                <ArrowRightIcon size={16} />
              </Link>
              <Link
                href="/start"
                className="inline-flex min-h-12 items-center justify-center rounded-sm border border-line-strong bg-surface px-5 text-sm font-medium text-ink transition-colors duration-[var(--habi-duration-fast)] ease-standard hover:bg-sunken"
              >
                See the identity screens
              </Link>
            </div>

            <div className="mt-10 max-w-[52ch] border border-line bg-surface px-4 py-3">
              <p className="text-xs leading-relaxed text-muted">
                <span className="font-semibold text-ink">Interface preview.</span> The gallery,
                threads, runs, and token counts are local sample data. Nothing is saved, and
                no model is called.
              </p>
            </div>
          </div>

          <div className="lg:col-span-5">
            <WeaveFigure className="h-auto w-full max-w-[20rem] lg:max-w-none" />
            <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-xs text-subtle">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-[3px] w-4 bg-accent" />
                Action
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-[3px] w-4 bg-signal" />
                Evidence
              </span>
              <span className="u-figures text-subtle">Habi · 2026</span>
            </p>
          </div>
        </div>
      </Container>

      <Container size="wide" className="py-section">
        <h2 className="max-w-[22ch] text-page tracking-heading text-ink">
          A foundation, not a finished product.
        </h2>
        <p className="mt-4 max-w-[58ch] text-base leading-relaxed text-muted">
          This repository proves the workspace, web shell, API health endpoint,
          worker boot path, and local PostgreSQL tooling. It does not include
          chat, Bots, model calls, or Hermes. The screens behind the preview
          link are a design preview of that product, drawn on sample data.
        </p>

        <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-8">
          <ScopeList title="In the preview" items={PREVIEW_ITEMS} />
          <ScopeList title="Not in the preview" items={NOT_HERE_ITEMS} />
          <ScopeList title="What is proven" items={PROVEN_ITEMS} />
        </div>

        <p className="mt-10 max-w-[62ch] border-t border-line pt-4 text-sm leading-relaxed text-muted">
          Accounts are invite-only while the proof of concept is under
          construction. The identity screens call a same-origin proxy; the
          product behind it is not part of this preview.
        </p>
      </Container>
    </SiteShell>
  );
}
