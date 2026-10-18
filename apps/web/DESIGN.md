# relay web — design notes

## UX brief

1. Who: one person running several coding-agent subscriptions, plus the occasional collaborator they send a link to.
2. When: between tasks, on a phone from the couch, or on a second monitor while a runner is working.
3. First question, every time: "what just happened, and did anything stall?" The feed answers it in one glance.
4. Second question: "am I about to hit a plan cap?" Three meters sit in the header on every page, amber at 70, red at 90.
5. Third question, weekly: "is relay actually cutting context per call?" The usage page leads with that number against a baseline.
6. Decisions they make here: approve a PR (link out), re-run or re-label an issue (link out), stop using a lane that is near its cap, re-onboard a stale model.
7. They rarely type here. Anything an agent can do for itself (get access, join a machine, open a task) is self-serve, so the page shows the prompt to hand the agent, not a form. A form exists only as a fallback and opens from an explicit button (a sheet), never inline on the page. Everything of record lives in GitHub; this page is the read model.
8. Density follows the question: the feed is dense and keyboard-driven; project and info pages breathe.
9. Nothing animates for decoration. Motion only confirms a state change (new events, meter refresh).
10. `/info` is the front door for newcomers and agents alike: it must read well on a phone in a chat preview.

## Information architecture

Three places, three jobs. Keep them that way when adding a page.

- Primary nav (`components/shell/nav.tsx`): the objects a viewer looks at daily. Signed in: Board (`/`, with Feed as its second tab at `/feed`), Projects, Assets, Usage. There is no separate task list: a column that overflows opens in place ("Show N more"); `/tasks` redirects to the board, and a task's page is under `/tasks/<owner>/<repo>/<n>` with "Board" as its breadcrumb. Anonymous: Overview (`/`), Docs, with Sign in on the right. Five short labels fit one row at 375px; the nav wraps, never scrolls.
- Avatar menu (`components/shell/viewer-menu.tsx`): the viewer and what they configure once. Login (with "demo" in mock mode), then Workers, Access (`/access`), GitHub App (`/setup/github`), the theme as System / Light / Dark, then Overview (`/info`), Docs, Sign out. Anonymous visitors have no avatar; their theme control is in the footer.
- Footer (`components/shell/site-footer.tsx`): the public and reference pages, in this order: Overview · Docs · API · OpenAPI · llms.txt · About · Contact · Privacy · Source.

The header is one row at `lg` and up (brand · nav · meters · avatar) and two rows below (brand · meter pill · avatar, then the nav), under 110px of chrome on a phone. The three plan meters show as bars at `lg` and collapse to one pill (the highest percentage, in its tone, the three windows in a tooltip) below; both link to `/usage`. The landing is "Overview" wherever it is named; its path stays `/info` for signed-in viewers and `/` for everyone else.

## Tokens

- Surfaces: `--background` zinc-50 / zinc-950, `--card` one step off. Borders hairline, never shadows for separation.
- One accent: `--primary` oklch(0.55 0.13 235) light, oklch(0.72 0.12 235) dark. Used for links, focus, selected row, the Claude series. Nothing else is tinted.
- Status, reserved: `--ok` green, `--warn` amber, `--bad` red. Shown with an icon or label, never color alone.
- Chart series (validated adjacent-pair palette): blue `#2a78d6`/`#3987e5`, orange `#eb6834`/`#d95926`, aqua `#1baf7a`/`#199e70`.
- Type: Geist Sans for prose, Geist Mono for ids, costs, tokens, timestamps, commands. Tabular figures only in columns.
- Radius 6px. Spacing: feed rows 32px tall; detail pages use 24px gaps.

## Visuals

### Board (`/`, `components/board/board.tsx`)

What it shows: every task as a card in the column of its state, left to right **Held · Queue · Running · Review · Failed · Done**. Queue, Running, Review and Done are always drawn so an empty board still names the steps; Held and Failed appear only when they hold something, Held first because the gate stopped those and a person should read them before anything else waits on a decision. A card is the task's title (a link to its page), `repo#n` in mono, the lane pill, when it last moved, the worker holding it while it runs (with its status when not online), the PR and the preview as links, the gate's warning on a held card and the run's last line on a failed one. **The decision is on the card**: Approve and Request changes in Review, Release on Held, Requeue on anything but Done, the same client components and server actions as the task page (`components/tasks/*`), in their small size. A column shows its newest 25 cards (10 for Failed and Done); "Show N more" (`?all=<column>`) opens the whole column in place. The page re-renders itself every 20 s while visible (`components/board/auto-refresh.tsx`); an open sheet survives the tick. The header has the two tabs (Board, Feed), the agent prompt for driving reviews from chat, and three numbers: in motion, waiting on you (tasks and assets), workers online. Below `sm` the columns stack, to `lg` they pair up, and from `lg` every column is on screen sharing the width equally: the whole board is visible without scrolling sideways, which is the point of a board.

The feed (`/feed`) is the second tab: the same filters and keyboard as before, the "waiting on you" number linking back to the board. Nothing animates on the board: a state change is a card moving to another column on the next refresh, which is the one motion that means something (item 9 above).

## Component idioms

One way to do each small thing, so the app reads as one hand. Reuse these before writing a span with classes; they live in `components/ui`.

- **Pill** (`pill.tsx`): the one small label. Hairline border in its tone (`muted`, `primary`, `ok`, `warn`, `bad`), `sm` or `md`, `mono` for identifiers (lanes, codes, tags), sans for words (`demo`, `revoked`). `asChild` makes it a link or list item. Never a filled chip.
- **StatusBadge** (`status-badge.tsx`): icon + word + tone, hint in `title`, built on Pill. A domain maps its value to `{icon, tone, label, hint}` in a thin wrapper (`components/assets/status-badge.tsx`, `components/tasks/state-badge.tsx`, `components/model-status.tsx`, the worker map on `/workers`) and renders this; status is never color alone.
- **SectionHeading** (`section-heading.tsx`): every heading under an h1 is `text-sm font-medium`, with an optional mono `count` and an `action` slot on the right (a link, an `sm` button, a key hint). h1 is `text-2xl` on app pages and `text-3xl` on the landing and docs articles. No uppercase eyebrows.
- **EmptyState** (`empty-state.tsx`): a dashed box with a title, one line saying where the things come from, and the `command` that fills the list with a copy button. Every empty list uses it, including the small ones on Access.
- **Breadcrumb** (`breadcrumb.tsx`): the trail above a detail page's h1, `Parent / current`, `mono` for ids; extra items (a source link) go in `children` on the same line.
- **Kbd** (`kbd.tsx`): a key as the keyboard shows it. Inside a filled button, pass a class that drops the background.
- **Collapsible** / **Disclosure** (`collapsible.tsx`): Radix Collapsible; `Disclosure` is the "Show 3 revoked or expired" text trigger with its content folded under it. **ToggleGroup** (`toggle-group.tsx`) is the bordered strip of mutually exclusive choices (the usage window); the meters are not toggles.
- **PromptCard**: the Access page's "Connect an agent" card is the reference. A bordered card: heading, one line of what to do with it, the prompt as muted small text, a CopyButton top-right, and under a hairline the fallback actions ("Other ways in") as `outline sm` buttons that open sheets. A page that wants the viewer to hand something to an agent copies this shape instead of a form (brief item 7).
- **Sheet for forms**: anything a person types (a note, an invite, a token by hand, a requeue) is a `Sheet` opened from an explicit button, with its own title, one line of consequence, the fields, one primary button and the outcome inside the sheet. Nothing is a form inline on the page.
- **Buttons**: the primary decision is `default` (Approve, Create, Send); the opposing decision is `outline` (Deny, Reject, Request changes); a row-level revoke or remove is `ghost` with `hover:text-destructive`; nothing else is red. Irreversible actions (merge, asset approve) take two steps: the first click or key arms the button and changes its label, the second confirms, blur or Escape disarms. One size per context: `sm` in rows and section-heading actions, `default` on detail pages and in sheets; `lg` is unused.
- **Times**: `lib/format.ts` only (`fmtAgo`, `fmtUntil`, `fmtDate`, `clockIn` in the viewer zone from `lib/tz.ts`); `RelTime` (`rel-time.tsx`) renders a relative time against the page's `now` with the ISO instant in `title` and `dateTime`. No `toLocaleString`, no UTC suffixes, no hand-rolled relative formatter.
- **Actors**: an actor string (`human:kyle`, `bot:concierge`, `runner:studio`, `agent:claude`) is always `ActorChip` (`components/feed/actor-chip.tsx`): the shape says the kind, the name is sans. Never print the raw string.
- **Scopes**: `ScopeList` (`scope-list.tsx`): code chips in a row where they are only names (Access rows), one per line with the description where the reader decides (activate, authorize); `ScopeCode` is the chip on its own (the scope picker).
- **Mono**: Geist Mono for ids, `#n`, versions, costs, sizes, times, scopes, event kinds, mimes, hostnames and commands. Sans for people and client names, token and invite names, state words, kinds, and every sentence, including notes a person writes.

## Rationale

"Mission control, calm." A dashboard of gauges invites staring; a feed invites reading. The meters are small because most of the time they are fine, and they turn amber or red exactly when they are not. Light and dark both follow the OS and can be toggled; the accent is one hue so that status colors keep their meaning.
