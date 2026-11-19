<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Tasks and workers come from the board

relay's tasks and workers live on the team's Vercel Board (`docs/WORKERS.md`, "The board"), not in the database. The web app reads and writes them through `@relay/core`'s `board` namespace:

- `lib/board.ts`: the one handle. `siteBoard()` is the session (the deployment's own in db mode, an in-memory demo board from `lib/board-demo.ts` in mock mode); what the site does to a task for someone goes through core's desk (`lib/task-ops.ts`), which writes their words as a profile named for them. `siteWorkers()` is the fleet, cached 20 s.
- `lib/board-read.ts`: what pages read (`openTasks`, `recentTasks` for History newest first, `newestFinished` for the board's Done column, cached 20 s, `fleet`, `planMeters`, `waitingOnYou`). There is no task index in the database.
- `lib/task-ops.ts`: a thin adapter. Every write (open, approve, request changes, release, requeue, close) from the API routes and the server actions becomes a call on core's desk (`packages/core/src/board/desk.ts`), which the MCP server uses too. The desk holds the two voices (a caller's words go out as their profile, relay's own data as `relay-site`) and the two rules for a bot, which is a token rather than a signed-in person: it never approves a task it opened, and it never releases a task whose text it wrote any part of. A task the site opens has its brief in the thread before a worker can claim it. `lib/task-problem.ts` turns a refusal into a problem document.
- `lib/tasks.ts`: state copy and tones, the board's columns (`columnOf`), which decisions a state allows (`decisionsFor`). `lib/task-path.ts` is the page path alone, for client components.
- `lib/board-watch.ts` and `app/api/board/[[...path]]/route.ts`: the watchers the board wakes the deployment for (`ledger` copies the queues' events into the feed, `relay-brief` posts the brief of a task opened elsewhere than the site), `taskBrief` (the brief the desk posts for a task the site opens), and the throttled sync page loads run where nothing wakes it.
- `lib/webhooks/board.ts`: what a GitHub delivery does on the board (an `agent:<lane>` label opens a task as the profile `github`, one per issue, on a lane somebody serves; a merge completes the task that waits on it). When it cannot, the route writes a `board.delivery_failed` row.

Tests run these on an in-memory board (`board.memoryBoard()`) and an in-memory PGlite; nothing needs a network.
