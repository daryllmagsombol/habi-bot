> **Superseded in part (2026-11-04).** The owner rejected the full-bleed three-column shell described
> below as drifting into concept 4. The shipped layout is concept 3: a card-based, centered page with a
> threads card beside a thread card, and Document/Context opened from the top bar. That rebuild also
> dropped the self-hosted Outfit/Work Sans faces for the rounded system stack. The current component
> contract, tokens and verification live in [the design system](../../DESIGN.md); the reasoning here
> about palette, type scale, states and evidence panels still applies.

# Habi Design System — Bot gallery, split evidence, Swiss surfaces

- **Status:** Direction chosen and implemented in `apps/web`. Every screen described here renders, but
  all Bots, threads, runs, tokens, and documents are **local sample data**; no API is called.
- **Date:** 2026-11-03 (revised 2026-11-04)
- **Scope:** Web UI only (`apps/web`). This document records visual, structural, and behavioural
  decisions. It makes no product, phase-gate, or security claim.
- **Related:** [Initial foundation design](./2026-10-19-initial-foundation-design.md),
  [POC boundary and journeys](./2026-10-21-poc-boundary-and-journeys-design.md),
  [Object and context model](./2026-10-22-object-and-context-model-design.md),
  [Auth architecture and SSO](./2026-10-23-auth-architecture-and-sso-design.md),
  [Provider access and daily allowance](./2026-10-28-provider-access-and-daily-allowance-design.md).

## 1. The direction

One home for a Bot's work, in the Swiss Minimalism style the owner selected, borrowing the
list→detail behaviour of an inbox and the split-canvas evidence of the fourth concept:

| Screen | Organised around | Signature interaction |
| --- | --- | --- |
| `/bots` | The Bot | Gallery of ruled cards; open one to enter its threads |
| `/bots/[botId]` | The conversation | Thread rail on the left, transcript on the right |
| Document / Context panels | The evidence behind a reply | Top-right toggle; the panel docks third on desktop, becomes a full-height sheet on a phone |

What is pinned by the direction, and what follows from it:

- **Flat.** Paper field, hairline rules, near-square corners, no card shadows. Elevation exists only
  where a surface floats over another (the mobile sheet).
- **One blue, one orange.** `#2563EB` carries action, focus, and the primary fill. `#EA580C` carries
  evidence: run state, citations, the cited passage, the output share of a token bar. Orange is never
  a small-text colour and never a second primary.
- **Two faces, two jobs.** Outfit (geometric, display) for page and section titles; Work Sans for
  everything read or operated. Monospace is reserved for code-like values and is not used as a
  "technical" costume.
- **A ledger, not a dashboard.** Counts, times, tokens, and states sit in labelled rows and tabular
  figures. No hero metrics, no progress rings, no gradient.

The five candidate directions were reviewed and compared outside this repository; this document
records only the combination the owner chose.

## 2. Token architecture

```text
apps/web/app/
├── tokens.css   STRUCTURE (§1) + the committed BRAND layer (§2)
└── globals.css  @theme mapping, base element styles, treatment utilities, keyframes
```

The interim branch split structure from a placeholder brand file so five directions could be swapped.
The direction is now chosen, so the two layers live in one file, in that order: §1 can change rhythm
without changing the look, §2 is the design. Components read semantic roles only — never a primitive,
never a hex value.

- A brand decision must not require editing a component or a page.
- Every colour, radius, shadow, family, and duration is a custom property.
- Tailwind utilities are mapped with `@theme inline`, so a re-pointed role updates utilities without
  regenerating class names.

### 2.1 Semantic roles

| Role | Value | Used for |
| --- | --- | --- |
| `color-canvas` | `#F5F4F1` | Page field, conversation background |
| `color-surface` | `#FFFFFF` | App bar, rail, panels, message bubbles |
| `color-sunken` | `#ECEBE5` | Current nav chip, empty bars, skeleton |
| `color-border` / `-strong` | `#DCDBD4` / `#6E6E67` | Hairlines / control boundaries |
| `color-text` / `-muted` / `-subtle` | `#15181D` / `#454B54` / `#5B6169` | Primary / secondary / tertiary |
| `color-accent` / `-hover` / `-ink` | `#2563EB` / `#1D4ED8` / `#1E40AF` | Action, focus / pressed / blue text on a wash |
| `color-accent-line` / `-quiet` / `-tint` | `#C3D3FB` / `#E3ECFE` / `#EFF3FF` | Rules, quiet fill, selection |
| `color-signal` / `-ink` | `#EA580C` / `#9A3412` | Marks, live dots / orange text on a wash |
| `color-signal-line` / `-tint` / `-mark` | `#F7D3BA` / `#FDF1E7` / `#F8DDC5` | Cite chip / live wash / cited passage |
| `color-danger*`, `color-success*` | `#B42318`, `#14683C` | Errors and confirmations only |

Light only. The direction is a daylight workspace; a dark theme would be a second semantic map and is
not shipped.

### 2.2 Measured contrast

Measured with the WCAG 2.1 relative-luminance formula on the values above. Every pair a role can
appear on passes its threshold.

| Pair | Ratio | Requirement |
| --- | --- | --- |
| text / canvas · surface · sunken | 16.18 · 17.79 · 14.90 | ≥ 4.5 |
| muted / canvas · surface · sunken | 8.00 · 8.80 · 7.36 | ≥ 4.5 |
| subtle / canvas · surface | 5.68 · 6.25 | ≥ 4.5 |
| accent / canvas · surface | 4.70 · 5.17 | ≥ 4.5 |
| on-accent / accent · accent-hover | 5.17 · 6.70 | ≥ 4.5 |
| accent-ink / accent-tint · accent-quiet | 7.86 · 7.35 | ≥ 4.5 |
| signal-ink / signal-tint · signal-mark | 6.58 · 5.62 | ≥ 4.5 |
| on-danger / danger | 6.57 | ≥ 4.5 |
| danger-ink / danger-surface | 6.48 | ≥ 4.5 |
| success / success-surface | 6.21 | ≥ 4.5 |
| signal / surface (3px marks and dots only) | 3.56 | ≥ 3 |
| border-strong / surface · canvas | 5.14 · 4.67 | ≥ 3 (control boundary) |
| focus / canvas · surface | 4.70 · 5.17 | ≥ 3 (non-text) |

Orange at `#EA580C` is 3.56:1 on white; that is why it never carries small text and always appears as a
mark, a 3px rule, or a fill behind `signal-ink`.

## 3. Typography

| Role | Family | Size | Notes |
| --- | --- | --- | --- |
| Display (landing `h1`) | Outfit 550 | `clamp(44 → 84px)` | `-0.035em`, max 13ch, balanced |
| Page title | Outfit 550 | `clamp(32 → 46px)` | max 24ch |
| Section/title | Outfit 550 | `clamp(19 → 23px)` | thread title, panel document headings |
| Body | Work Sans 400 | 16px inputs, 15px UI copy | 1.62 leading, measures 46–66ch |
| Label | Work Sans 600 | 12px, uppercase | `0.12em` tracking; field names and micro-headings |
| Figures | Work Sans + `tnum` | any | times, tokens, counts, sequence numbers |

Both faces are **self-hosted variable WOFF2** files in `apps/web/app/fonts/` and loaded with
`next/font/local`, so no request leaves the page and the build works offline. Mono is used only for the
invitation token field and inline code in sample copy.

Rules the implementation follows:

- Exactly one `h1` per page. On a Bot page it is the Bot's name in the app bar; the conversation title
  is an `h2`, and the panel sections are `h3`. The app bar `h1` is deliberately small — a title bar,
  not a hero — while the content heading carries the visual weight.
- No eyebrow above a heading. The description under a title carries the context.
- Numbers that line up (times, token counts, seq) use tabular figures.

## 4. Spatial system

- **Space** — 4px base, 12 steps. Page gutter `clamp(20 → 48px)`; section rhythm `clamp(56 → 96px)`.
- **Breakpoints** — `sm 40rem`, `md 48rem`, `lg 64rem`, `xl 80rem`, `2xl 96rem`.
- **Widths** — form 28rem, narrow 38rem, reading 44rem, default 64rem, wide 76rem; thread rail 18.5rem;
  evidence panel 25rem.
- **Targets** — every control clears 44×44. Compact chips are 36px on a precise pointer and 44px on a
  coarse one (`pointer-coarse:min-h-11`); in-text citation chips are 44px everywhere.
- **Composition** — the workspace is full-bleed: the app bar and the panes share the same 16/24px inner
  padding at the window edge, so the rail's border and the bar's hairline meet. Public pages
  (landing, identity) use a centred 76rem content column whose left edge aligns with the wordmark.
- **Density** — generous between objects, tight inside them: 24px pane padding, 24px between
  transcript turns, 12px inside a message, 8px inside a metadata row.

## 5. Component inventory

All primitives live in `apps/web/components/ui`, are typed, server-component friendly, and accept a
`className` escape hatch. `ButtonLink` is the only one importing `next/link`; `Segmented`, `Sheet`,
`EmptyState`, `Panel`, `Card`, and `Badge` stay server-safe by construction. Two composed pieces sit
outside: `SiteShell` (public chrome) and `AppBar` (workspace chrome), plus `BotMark` and `WeaveFigure`.

| Component | Anatomy | States and behaviour | Accessibility |
| --- | --- | --- | --- |
| `Button` / `ButtonLink` | optional spinner → label | primary (blue fill), secondary (surface + control border), ghost (always underlined), danger; `sm`/`md` 44px, `lg` 48px; `loading` sets `aria-busy` and disables | native button/link, no icon-only usage without a name |
| `TextField` | label → input → hint → error | invalid border + `aria-invalid`, disabled sunken; 16px text | hint/error ids merged into `aria-describedby`; no placeholder-as-label |
| `Card` / `Panel` | ruled surface / labelled section | tones surface, outline, sunken; padding steps | `Panel` is a `<section>` labelled by its visible heading |
| `Badge` | dot + text | neutral, accent, signal, success, danger, outline | state is always named in text; colour is never the only signal |
| `Segmented` | nav of real links | current item via `aria-current`, tinted; selecting the open panel closes it | navigation semantics, not fake ARIA tabs: each view has a URL |
| `Sheet` | heading + close + scroll body | full-height column on desktop, full-screen sheet in flow on mobile | labelled region; close is a 44px link; no modal, no focus trap needed |
| `EmptyState` | mark in text flow → title → description → action | `stack` and `inline` rows | heading level selectable to keep the outline valid |
| `Skeleton` / `SkeletonText` | reserved sunken blocks | motion-safe pulse only | `aria-hidden`; pair with a `role="status"` line |
| `PageHeader` | `h1` → description → actions | display / page sizes | one `h1` per page |
| `Container` | centred gutter + max width | five widths | never nested |
| `Stack` / `Inline` | flex rhythm | gap, direction, wrap, align, justify | literal class strings so Tailwind can see them |
| `Toolbar` | horizontal control strip | plain/surface/canvas, optional border and sticky | wraps rather than clipping its last control |
| `SkipLink` | first tab stop | revealed on focus by translation | stays focusable; instant under reduced motion |
| `FormMessage` | live region with error/success/info | error is `role="alert"`, status is `<output>` | region exists before content; no focus stealing |
| `icons.tsx` | 20-unit box, 1.5 stroke, round caps | 12 named icons | `aria-hidden` unless a `title` is passed |

States covered by construction: default, hover, active, focus-visible, disabled, loading, invalid,
empty, and held/recalled memory. Hover is never the only affordance; focus rings are outlined (not box
shadows) so they survive Windows High Contrast and are never clipped by `overflow: hidden`.

## 6. Routes, URL state, and responsive behaviour

| Route | Purpose | URL state |
| --- | --- | --- |
| `/` | Landing: the foundation's honest scope and a way into the preview | — |
| `/bots` | Bot gallery: name, purpose, conversation count, last activity, and a disabled create affordance | — |
| `/bots/[botId]` | Thread rail + conversation + evidence | `?thread=<id>`, `?panel=document\|context` |
| `/start` | Identity entry point | — |
| `/login`, `/signup`, `/recovery` | Identity preview forms, same-origin BFF | — |
| `not-found` (root and Bot segment) | Honest 404: the address is not in the preview | — |

Thread and panel live in the URL, not in component state, so every view is linkable, reloadable, and
reachable with Back. Selecting the panel that is already open returns the conversation — that is what
makes the top-right control a toggle. An unknown Bot or thread is a real 404.

Responsive composition:

- **320px (base)** — one screen at a time: gallery → thread list → conversation. The mobile segmented
  row (Thread / Document / Context) is the panel control, and a panel replaces the conversation as a
  full-screen sheet rather than covering it. Back moves one level at a time: panel → conversation →
  thread list → gallery.
- **768px** — the rail is still hidden until a thread is chosen; the conversation fills the width; the
  segmented row remains.
- **1024px** — the rail docks (18.5rem) and the Document/Context segmented control appears top-right.
- **1440px** — with a panel open, the workspace is three panes: 18.5rem rail, flexible conversation,
  25rem evidence. Without one, the conversation keeps the width and its transcript stays capped at
  44rem for measure.

## 7. The evidence panels

**Document** shows the attachment a thread carries: name, size, attach time, `read-only`. Cited
paragraphs are marked with `signal-mark` and a ¶ badge; a citation chip in the reply links to that
anchor. A thread without an attachment gets an empty state that names the missing capability and a
disabled attach control instead of an upload that does nothing.

**Context** is the honest answer to "what did it cost, and what was it allowed to touch?":

1. **Memory** — each memory with two real checkboxes (Bot, Thread). Recalled requires both; one off
   holds the memory back without deleting it. The control works, and the status line says the change is
   not saved.
2. **This run** — run id and state, input/output tokens as a blue/orange bar with figures, duration,
   tools 0, and the committed events with sequence numbers.
3. **Today** — used vs the 100,000/day allowance, reset at 00:00 Asia/Manila, and a plain statement
   that the cap is intent, not enforcement, in this preview.
4. **Capability** — tools allowed 0, empty allow-list, attachments read-only, one user, and a note that
   this page does not demonstrate server-side isolation.

Panels never hide the run strip. Every bot reply shows its run figures inline; the panel adds the
event log and the gates.

## 8. Motion

One authored entrance per page: gallery cards rise 10px with staggered delays (40–240ms) using
`cubic-bezier(0.16, 1, 0.3, 1)`. A panel animates in as it opens. State changes use 130–200ms colour
transitions. Nothing loops: there is no typing cursor, no shimmer sweep, and no pulsing live dot —
the run badge already names the state in words.

`prefers-reduced-motion` collapses every duration and delay to 1ms at the token layer, so components
never branch. The loader keeps a static ring instead of spinning, because a 1ms spin flickers.
Content is visible by default; animation never gates copy.

## 9. Browser surfaces

These ship with the design rather than defaulting: text selection (`accent-tint`), caret colour
(accent), placeholder colour (subtle, measured 5.68:1), thin themed scrollbars, underline offset and
thickness on links, `summary` markers removed in favour of a rotating chevron, and a 2px offset
outline ring that is visible on paper, surface, and filled buttons.

## 10. Verification

Run from the repository root:

```bash
pnpm --filter @habi/web build         # 8 routes; / and identity pages static, Bot page dynamic
pnpm --filter @habi/web typecheck     # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
pnpm --filter @habi/web lint          # eslint + next core-web-vitals
pnpm --filter @habi/web test          # identity, homepage, workspace smoke tests
pnpm --filter @habi/web test:browser  # the design run below, in Chromium
```

`test:browser` is kept out of `test` on purpose: the default test run stays fast and browser-free. The
suite boots the built app once with `next start` on an ephemeral port and shares one Chromium
instance. It never downloads a browser; when the Chromium build Playwright expects is missing, the
whole run skips and prints the install command:

```bash
pnpm --filter @habi/web exec playwright install chromium
```

The run covers 320×760, 768×1000, and 1440×1000 in light and dark over nine routes (`/`, `/bots`, the
thread workspace, the Document panel, the Context panel, `/login`, `/signup`, `/start`, `/recovery`).
Every route and matrix cell asserts:

- **No horizontal overflow** on the rendered page (`scrollWidth === clientWidth` on `<html>` and
  `<body>`).
- **One visible `h1`** per route, with no skipped heading levels in the rendered outline.
- **Contrast measured from computed styles**, walking up to the first opaque ancestor background:
  visible text is at least 4.5:1 (3:1 for large text), and placeholder text is measured from
  `::placeholder` in both themes.
- **Touch targets**: every link, button, and form control is at least 44px tall in its primary
  dimension, except inline text links (the WCAG 2.5.8 inline exception) and form labels. The 14px
  checkbox inputs are exempt because their label is the target and grows under `pointer: coarse`.
- **Theme resolution**: a fresh context follows `prefers-color-scheme`, paints the matching palette,
  and carries no `data-theme` attribute until the reader chooses one.

Four further tests cover stateful behaviour:

- An explicit toggle writes `habi-theme`, paints dark, and after reload has `data-theme` on `<html>`
  before `DOMContentLoaded`; the emitted pre-paint script is asserted to appear before the rendered
  content. This is a structural pre-paint check, not a capture of the first frame.
- `Tab` from the top of `/bots` reaches the skip link first and reveals it.
- `Tab` reaches the Document control in the thread workspace, and `Enter` opens it as
  `?panel=document`.
- An unknown Bot returns `404` and renders the custom boundary copy and gallery link, not the Next
  error page.

Screenshots are not written or kept; the assertions are the evidence. Not asserted by the suite, and
previously checked by hand: console errors, self-hosted font/network requests, reduced motion and
forced colours.

One defect the original manual pass found and fixed: the not-found boundary rendered as the error page,
because the shared app bar is interactive chrome (`onClick` for in-place back) being rendered from a
server component. The app bar is now a client component, and the workspace smoke test asserts the 404
payload carries the custom boundary rather than only the right status.

Two behaviours are deliberately absent:

- **No route-level `loading.tsx`.** A loading boundary streams the response before `notFound()` can set
  a status, which turned missing Bots into `200`. Correct 404s won. `Skeleton` stays in the library for
  data-backed loading states once the APIs exist.
- **No auto-scroll on phones.** The desktop transcript opens at the latest message; on a phone the page
  scrolls and opens at the header, which is the expected reading position there.

## 11. What remains to wire (#18)

Everything below is drawn and keyboard-operable, but local:

1. **Bots API** — replace `lib/preview-data.ts` with Bot records (instructions, memory, thread refs) and
   an owner-scoped list; enable the New Bot flow behind it.
2. **Threads and messages** — real thread list ordering, message pagination, and the run each message
   belongs to. The rail, transcript, and deep links already take their data from props.
3. **Runs** — streamed run events and the per-run token split. The run strip and the Context panel read
   `PreviewRun`; the same shape can come from the event log.
4. **Memory gates** — persist the two approvals per memory and thread; today the switches only change
   local state and say so.
5. **Attachments and citations** — upload, read-only document fetch, and citation anchors. The document
   panel, cite chips, and paragraph anchors are in place.
6. **Allowance** — a real pre-dispatch check and an output bound before the wording claims enforcement;
   the panel's copy changes then.
7. **Identity** — the screens and the same-origin BFF are preserved as they were; they are not part of
   the preview's sample data and must keep their existing tests.
8. **Empty, loading, and error states for real data** — the primitives exist (`EmptyState`,
   `Skeleton`, `FormMessage`); routes need the states once requests can fail.

Nothing in this preview writes, sends, or persists anything. The removal of this document's sample
data module is the signal that the UI has met its APIs.
