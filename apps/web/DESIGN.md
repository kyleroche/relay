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

## Tokens

- Surfaces: `--background` zinc-50 / zinc-950, `--card` one step off. Borders hairline, never shadows for separation.
- One accent: `--primary` oklch(0.55 0.13 235) light, oklch(0.72 0.12 235) dark. Used for links, focus, selected row, the Claude series. Nothing else is tinted.
- Status, reserved: `--ok` green, `--warn` amber, `--bad` red. Shown with an icon or label, never color alone.
- Chart series (validated adjacent-pair palette): blue `#2a78d6`/`#3987e5`, orange `#eb6834`/`#d95926`, aqua `#1baf7a`/`#199e70`.
- Type: Geist Sans for prose, Geist Mono for ids, costs, tokens, timestamps, commands. Tabular figures only in columns.
- Radius 6px. Spacing: feed rows 32px tall; detail pages use 24px gaps.

## Rationale

"Mission control, calm." A dashboard of gauges invites staring; a feed invites reading. The meters are small because most of the time they are fine, and they turn amber or red exactly when they are not. Light and dark both follow the OS and can be toggled; the accent is one hue so that status colors keep their meaning.
