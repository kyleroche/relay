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

- Primary nav (`components/shell/nav.tsx`): the objects a viewer looks at daily. Signed in: Feed (`/`), Tasks, Projects, Assets, Usage. Anonymous: Overview (`/`), Docs, with Sign in on the right. Five short labels fit one row at 375px; the nav wraps, never scrolls.
- Avatar menu (`components/shell/viewer-menu.tsx`): the viewer and what they configure once. Login (with "demo" in mock mode), then Workers, Access (`/tokens`), GitHub App (`/setup/github`), the theme as System / Light / Dark, then Overview (`/info`), Docs, Sign out. Anonymous visitors have no avatar; their theme control is in the footer.
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

### Flow map (`/flow`, `components/flow/pipeline-map.tsx`)

What it shows: everything in motion, as a transit map. The look is a subway map crossed with a fibre-optic run and a monitor's trace: bold, luminous, calm, drawn on a dark glass panel first (a faint drifting dot grid, a vignette), with the same geometry as ink on paper in light mode (softer glows, no neon on white). **Rails** are lanes (claude, codex, grok in the series colours; a dashed fourth rail for cloud lanes when a task rides one): thick rounded strokes with a directional gradient (dim at Queue, bright at Merged), an outer glow and a thin top highlight. **Stations** are filled nodes (dark core, lane ring) where a task stands, left to right: **Queue · Claimed · Running · PR · Preview · Review · Merged**, with **Failed** as a siding under Running; a station glows while a task sits there and Merged is a bright cap. Projects with work in motion are origin nodes on the left with a branch into Queue (at most six, then a "+N projects" stop). **Machines** (workers) are rounded chips above Running with the name, their lane dots and a heartbeat trace that runs while they hold a claim (flat when idle, dashed when offline), tethered to the task by a bezier cable. **Trains** (tasks) are pills filled with the lane colour: a project-initial badge wrapped by a dwell ring (time at this station against a per-station budget, amber past it; the exact time is in the hover card), `repo` in sans and `#n` in mono, a headlight ahead. At most five trains sit at one stop; the rest fold into a "+N" chip. A merged train dissolves into the cap; nothing done or idle is drawn, so an empty map is the rails breathing faintly, the machines, and the words "Nothing in motion" on the panel.

The motion rule: this is the deliberate exception to item 9 above, and the exception has its own rule: **motion means activity**. Particles stream only on a segment, branch or tether that carries a task (a canvas layer, capped, paused when the tab is hidden or the map is off screen); a rail pulses only while it carries one; a machine's heartbeat runs only while it holds a claim; a train travels, with a comet tail, only when its station changed between polls, and breathes only while Running. An idle rail is dimmed and still. `prefers-reduced-motion` keeps the positions and removes the travel, particles, pulses and heartbeats. The strip at the top of the feed is the same language compressed (no legend, chips in a row); under 640px the map turns vertical and keeps it. The /flow page has a project filter (multi-select pills, remembered in localStorage); the strip takes none.

The stations vocabulary is derived in `lib/flow.ts` and is the one to reuse elsewhere (feed strip, task pages): `queued → Queue`, `claimed → Claimed`, `running → Running`, `review → PR` (no preview ready), `→ Preview` (preview ready, nobody engaged), `→ Review` (a `pr.review` or a refused merge since the last push: a person or bot holds the decision), `done → Merged`, `failed → Failed`. `since` is when the task reached that station, not when it was opened.

## Rationale

"Mission control, calm." A dashboard of gauges invites staring; a feed invites reading. The meters are small because most of the time they are fine, and they turn amber or red exactly when they are not. Light and dark both follow the OS and can be toggled; the accent is one hue so that status colors keep their meaning.
