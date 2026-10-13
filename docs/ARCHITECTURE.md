# Architecture

relay exists because one person using several coding-agent subscriptions wastes most of them on re-read context and re-explained decisions. It makes the subscriptions work as one system without building a new agent.

## The rules

1. **Tasks move, credentials never do.** Every model call runs on a machine where the owner logged in with the vendor's own tool. No token is copied, proxied, or stored in CI.
2. **GitHub is the task bus.** An issue is a task, a label picks the lane, a pull request is the result. Nothing of record lives anywhere else.
3. **Every step starts fresh with a small brief.** No transcript is ever sent to a model. A brief is the repo's rules file, the issue, relevant decisions, and the vendor guidance that matches the intent.
4. **Official vendor sources only.** Model guidance comes from the vendor's documentation and the skills the vendor publishes. Community prompt guides are excluded unless the user allowlists a domain.
5. **Everything is an event.** One append-only table records what every human, bot, and runner did, with tokens and cost. The ledger is a view over it.

## Pieces

| Piece | What | Where it runs |
|---|---|---|
| Front end | Any chat agent that can file GitHub issues and call a webhook. Grok Bot is the reference; a plain terminal works. | wherever the user talks |
| Task bus | Issues, labels (`agent:claude`, `agent:codex`, `agent:grok`), one Projects board across repos | GitHub |
| Runners | Self-hosted GitHub Actions runners that run `claude -p`, `fx`/`codex exec`, or `grok -p` in a fresh worktree and open a PR | the user's machines |
| Memory | Postgres: projects, file digests keyed by content hash, decisions with validity, preferences, vendor guidance with vector and full-text search | Neon in production, PGlite locally |
| Memory server | MCP over stdio for the CLIs and over HTTP for cloud agents | the web app and each machine |
| Rules file | A generated `relay.md` per repo, referenced from `AGENTS.md`/`CLAUDE.md` through an owned, marker-delimited section | in every linked repo |
| Hooks | Session-start injection and session-end capture for Claude Code, Codex, and Grok Build | each machine |
| Feed | The events table plus a web page over it, with usage meters and worker health as rollups | the web app |
| Onboarding gate | A model cannot be used by a lane until its official docs and skills are ingested | CLI and runners |

## A task's life

1. A human or bot opens an issue and labels it with a lane.
2. A runner with that label claims the job, checks out a fresh worktree, compiles the brief, and runs the vendor CLI headless with the planner and subagents disabled.
3. The CLI's output is snapshotted and pushed as a branch; a PR opens with the usage line as a comment.
4. Vercel or the repo's CI builds the preview. A review lane, on a different model, comments.
5. The human approves. On merge, a job extracts decisions into memory and regenerates the rules file.
6. Every step above is a row in the feed.

## What relay deliberately does not do

- It does not run a coordinator model. Planning is the front end's job, or the human's.
- It does not host a chat UI. It hosts a feed.
- It does not hold API keys for vendors. Pay-per-token providers are optional overflow lanes the user configures.
