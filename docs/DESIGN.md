# Habi design system

How the web UI looks, how it is built, and how to add to it. This file is the working reference for
anyone changing `apps/web`; the reasoning behind the direction is in
[the design-system spec](superpowers/specs/2026-11-03-design-system.md) and does not need to be
re-derived here.

- **Direction:** Bot gallery home, thread list and conversation as cards, Document and Context opened
  from the top bar. Card-based and centered, not a full-bleed pane shell.
- **Scope:** `apps/web` only. The preview runs on local sample data; nothing in it calls an API or
  claims a shipped capability.

## 1. Non-negotiables

1. **Reusable components only.** A route renders components. It does not contain card, bubble,
   list-row, pill, or avatar markup of its own. See §3 for the contract.
2. **Mobile-first.** Build the 320px case first, then widen. No desktop layout patched with negative
   margins or overflow hacks.
3. **Honest.** Sample data is labelled as sample data. If something is not wired, the copy says so.
   Never render a success state the backend cannot produce.
4. **Untrusted text stays untrusted.** Bot instructions, skill bodies, artifact content and citations
   are data. They are rendered as text or sanitized Markdown, never as HTML, and never as UI chrome
   that could grant an action.
5. **Tokens, not literals.** Colour, spacing, radius, type and motion come from `app/tokens.css`. A
   component that needs a new value adds a token; it does not hard-code a hex value.

## 2. Tokens and layout

`apps/web/app/tokens.css` is the single source. Light and dark resolve the same semantic names, so a
component never branches on theme:

| Group | Names |
| --- | --- |
| Surfaces | `--p-canvas`, `--p-surface`, `--p-sunken`, `--p-line`, `--p-line-strong` |
| Text | `--p-ink`, `--p-ink-2`, `--p-muted`, `--p-subtle`, `--p-ink-inverse` |
| Accent | `--p-accent`, `--p-accent-hover`, `--p-accent-soft`, `--p-on-accent` |
| Signal | `--p-signal`, `--p-signal-soft` |
| Tints | `--p-sage`, `--p-apricot`, `--p-plum` (Bot identities) |
| Shape | radius, hairline, `--shadow-sm`, `--shadow-lift` |
| Motion | `--habi-duration-fast/base`, `--habi-ease-standard/entrance` |

Rules:

- Pick the semantic token, not a primitive one. If a component needs a new role, add the role to both
  themes in the same edit.
- **Dark mode is designed, not inverted**: the field is graphite, cards sit one step lighter, depth
  comes from a hairline rather than a raised shadow, and accents lift so they carry text.
- The theme is applied before first paint by the inline script in `app/layout.tsx`
  (`data-theme` on `<html>`), defaults to `prefers-color-scheme`, and is persisted by the toggle. No
  component reads the theme.
- Layout is a centered column with a card grid. Panes do not run edge to edge; a panel opens as a card
  or a sheet and must not permanently shrink the reading column.

### 2.1 Preview versus live data

Screens take their data through props, so where it comes from is decided once, in the route:

| Condition | What renders |
| --- | --- |
| `HABI_API_URL` unset | `lib/preview-data.ts`, labelled `Preview` and "local sample data" |
| `HABI_API_URL` set, 200 | Real records through the same-origin BFF, marked `Live` |
| 401 | "Sign in" state with a link to `/login` — never an empty gallery |
| 5xx or unreachable | Explicit unavailable state — never the sample data |
| Invalid URL | Configuration error |
| SSE drop | Reconnect from the last `id:`, bounded retries, then an explicit retry |

Rules: the browser never learns the backend origin (all requests go to `/api/*` on the web origin,
which forwards only the session cookie, the CSRF token and the event cursor). A failed request never
degrades into sample data, and absent figures — allowance, memory, attachments, citations, run
history — stay absent rather than being invented for the live path.

## 3. The component contract

Every component in `apps/web/components` satisfies all of these. Review rejects a component that does
not.

1. **Data in, callbacks out.** Everything comes through typed props. No component imports sample data,
   fetches, or reads the URL. The route is the only place that knows where data came from.
2. **No page-specific markup.** If two screens need the same shape, it is a component. If one screen
   needs a variation, it is a prop or a variant, not a copy.
3. **Variants are typed unions.** `variant: 'solid' | 'secondary' | 'ghost'`, `tone: 'accent' | 'sage' | …`.
   Never a pile of booleans that can produce an impossible state.
4. **States are props.** Loading, empty, error, disabled, streaming and selected are passed in and
   rendered by the component. A component never invents a spinner or an error string.
5. **One component per file, named export, barrel export.** `components/<group>/index.ts` re-exports
   the group; the route imports from the group.
6. **Independently renderable.** A component must render in isolation with fixture props — no page
   context, no provider required beyond the app shell.
7. **Accessible by construction.** Semantic element, label, visible focus, 44px target, and a live
   region where content arrives asynchronously.
8. **No business rules.** Approval logic, allowance math and authorization live on the server. The UI
   may display their outcome; it never decides them.

### Groups

| Group | Contains | Reused by |
| --- | --- | --- |
| `components/ui` | `Avatar`, `Badge`, `Pill`, `Button`, `ButtonLink`, `IconButton`, `IconButtonLink`, `Card`, `ListRow`, `MetaRow`, `SectionHeader`, `Segmented`, `Sheet`, `Toolbar`, `Container`, `Stack`, `Inline`, `TextField`, `TextArea`, `SelectField`, `FormMessage`, `EmptyState`, `Skeleton`, `SkeletonText`, `PageHeader`, `SkipLink`, `icons` | every screen |
| `components/bots` | `BotCard`, `NewBotCard`, `BotGallery`, `BotIdentity`, `BotForm`, `BotFormCard`, `botTone` (helper) | gallery, Bot page |
| `components/threads` | `ThreadListCard`, `ThreadRow`, `ThreadCard`, `ThreadConversation`, `MessageBubble`, `RunStrip`, `Composer`, `ThreadForm`, `ThreadActions` | Bot page, `/threads` |
| `components/panels` | `PanelCard`, `PanelSwitch`, `DocumentPanel`, `ContextPanel`, `MemoryCard`, `MemoryGates`, `MemoryComposer`, `ArtifactPanel`, `ArtifactForm`, `SkillsPanel`, `SkillForm`, `SearchPanel`, `PaginationFooter` | Bot page, panel routes |
| `components/account` | `AccountExportCard`, `AccountDeleteCard`, `ACCOUNT_BACKUP_DISCLOSURE` | `/account` |
| `components/chrome` (root files today) | `app-bar`, `wordmark`, `site-shell`, `weave-figure` | every route |
| `components/theme` | `theme-toggle`, `theme` (store) | app bar, site shell |
| `lib` | `preview-data`, `motion`, `links` | routes only |

`ui` is the primitive layer and depends on tokens alone. `Segmented`, `Sheet`, `Toolbar`, `Skeleton`
and `SkeletonText` are kept for states the data-backed screens will need; an unused primitive is not
dead code, it is the contract for the next screen.

A route-level **coordinator** is not a component group. `/bots/[botId]` owns `?thread=` and `?panel=`
in `app/bots/[botId]/workspace.tsx` (with `workspace-data.ts` mapping sample records to component
props), receives one `WorkspaceData` object, and passes slices to the groups.

### Inventory notes

- One component per file, named export, group barrel: `Button`/`ButtonLink`, `IconButton`/`IconButtonLink`,
  `Stack`/`Inline` and `Skeleton`/`SkeletonText` are separate files on purpose.
- `Badge` is a state label (status, run state); `Pill` is chrome (counts, allowance). Do not swap them.
- `ListRow` is generic row mechanics; `ThreadRow` is the thread-specific row built on it.
- `Avatar` carries the Bot identity tone (`iris`/`sage`/`apricot`/`plum`) and neutral/user tones.
- Forms are components, not markup: `BotForm`/`BotFormCard` and `ThreadForm` reuse `TextField`,
  `TextArea` and `Button`; `ThreadActions` and `MemoryComposer` are the same shape.
- `ArtifactPanel`, `SkillsPanel` and `SearchPanel` are the content surfaces the live API provides.
  They render one page of results and never invent a record the API did not return; a missing
  attachment content route renders "Not stored on this server" rather than sample text.
- `PaginationFooter` is the one load-more affordance. Every cursor list uses it: it renders nothing
  when `nextCursor` is null, shows a busy state while a page is in flight, and appends without
  moving scroll or the current selection. Never invent a cursor for a surface that has none.
- `ArtifactForm` and `SkillForm` enforce the API bounds before submitting (artifact content 100 KB
  over transport; skill name 1–80, description ≤500, body ≤64 KiB) and state the bound in the hint.
  Both take a `mode` rather than growing a second component: `ArtifactForm` is `'create' | 'metadata'`
  (metadata edits never show a content field and say the body is untouched), `SkillForm` is
  `'create' | 'edit'` (edit prefills and submits only the changed fields). A mode is a typed union,
  so an impossible combination is a type error.
- `components/account` owns the destructive surface: `ACCOUNT_BACKUP_DISCLOSURE` is the single
  source of the retention wording, so the 184-day claim cannot drift between copy and API. The
  export is a streamed browser download behind an account-profile preflight — never a buffered
  `Blob` — and a failed preflight renders the error state rather than navigating to raw JSON.

## 4. Composition rules

- A **route** composes groups and owns data selection; it contains no visual primitives.
- A **group component** may use `ui` primitives and may not reach into another group.
- A **primitive** depends on tokens only. It never imports from `bots`, `threads` or `panels`.
- Shared behaviour that is not visual (URL building, formatting, motion constants) lives in `lib`.

## 5. Motion

`motion@14.9.0`, imported from `motion/react`.

- Purpose only: panel open/close, thread change, the gallery entrance, an optimistic send.
- 130–200 ms. Animate `transform` and `opacity`; never animate width, height or layout properties.
- Springs only where they communicate physics. No looping decoration, no orchestrated page loads.
- Wrap live regions in `MotionConfig reducedMotion="user"`, and let the token layer collapse durations
  under `prefers-reduced-motion`. Content is visible by default; animation never gates copy.

## 6. Accessibility floor

- One `h1` per route, no skipped heading levels.
- Every control reachable by keyboard with a visible focus ring; skip link first in tab order.
- Body and muted text ≥4.5:1 against their actual background in both themes; large text ≥3:1.
- Targets ≥44px tall, except inline prose links and labels that are not themselves the target.
- New messages, errors and streaming state are announced through an existing live region.

## 7. Verification

```bash
pnpm --filter @habi/web build          # routes compile and prerender
pnpm --filter @habi/web typecheck      # strict
pnpm --filter @habi/web lint           # eslint + next core-web-vitals
pnpm --filter @habi/web test           # server-rendered smoke assertions, fast and browser-free
pnpm --filter @habi/web test:browser   # Chromium: 3 viewports x 2 themes x 11 routes + stateful tests
node --test apps/web/test/api-proxy.test.mjs  # BFF forwarding, SSE, 401/5xx mapping, no origin leak
pnpm --filter @habi/web test:browser:live     # Chromium against a stub API: the §2.1 live state matrix
```

`test:browser` runs the preview matrix and skips with the install command when Chromium is absent.
`test:browser:live` boots the built app against a settable stub upstream and covers the live half of
§2.1 — 401, 5xx, unreachable, invalid config, attachment 503, the account disclosure and its
disabled-until-match delete control, the editors' partial PATCH bodies, and stream reconnect. It
assertes DOM and computed styles only; no screenshots.

A UI change is not done until both test commands pass and the affected route has been checked at 320,
768 and 1440 in light and dark — in **both** modes, because preview and live render different data and
different failure states.

## 8. Adding something

Before writing markup in a route, answer in order:

1. Does a component already do this? Use it.
2. Does it do almost this? Add a variant or a prop.
3. Is this the second screen needing it? Extract it into the right group first, then use it.
4. Only then write a new component — with typed props, states as props, a barrel export, and a smoke
   assertion for the state that is easy to break.

Then update this file's §3 table if the component is new, and note the route that uses it.
