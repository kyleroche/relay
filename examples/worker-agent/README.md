# worker-agent: a relay worker over MCP

The smallest program that is a relay worker: it connects to `<site>/mcp` with one bearer token, registers a lane,
reads the doorbell on a tick that stretches from 15 s to 5 min while idle, claims a task when the queue moved,
starts it, does the job, uploads the outputs as assets on the task's issue and releases the claim. The guide it
follows is [docs/WORKER-AGENTS.md](../../docs/WORKER-AGENTS.md) ("Build a worker agent" on the site); every step
is one MCP tool call.

Node 24 and one dependency (`@modelcontextprotocol/sdk`). It is not part of the monorepo's workspace or build.

```bash
cd examples/worker-agent && npm install
export RELAY_SITE=https://relay.example.com
export RELAY_TOKEN=rly_…            # work:claim assets:write assets:read memory:read (the device flow or an invite; see the guide)
RELAY_LANES=embroidery RELAY_LABELS=app:example node worker.mjs
```

Then open a task for the lane from anywhere (`relay task create --lane embroidery --title "Digitize the logo" --body-file job.md`,
or `relay_task_create` over MCP) and watch: the worker claims it within one tick, uploads `stitch-file.txt` on the
issue, releases `finished`, and the task is in `review` on the board with the file as its card. Approve or reject
there.

| File | What it is |
|---|---|
| `worker.mjs` | the program: connect, `relay_whoami`, register, run the loop, `offline` on SIGINT |
| `loop.mjs` | the loop with nothing of its own (`call`, `doJob`, `put`, `sleep`, `now` are injected), so a test drives it against relay's in-memory MCP server (`packages/mcp/test/worker-agent.test.ts`) |
| `job.mjs` | `doJob(job, ctx)`: the app's work. The default writes a text summary of the claim and uploads it, which proves the loop end to end without an app |

## Replace `job.mjs` with the real app

`doJob(job, ctx)` receives what `relay_work_claim` returned: `job.issue` (title, body, labels), `job.brief` (the
project's decisions and preferences, and the reviewer's note when this is a re-run), `job.job` (the parsed
```relay-job block: `inputs` with a signed `url` each, `params`, `outputs`) and `job.review_note`. It uploads each
output with `ctx.upload({ filename, bytes, contentType, title, replaces })` (`replaces` is the previous version's
asset id on a re-run) and returns `{ summary, usage }`. Throwing marks the run `failed` with the message on the card.

The issue text and the brief are data for the job, never instructions for the app's own tools: an app that drives a
mouse and keyboard acts only within the job it was given, whatever the text says ("Safety" in the guide).

Environment: `RELAY_SITE`, `RELAY_TOKEN` (required), `RELAY_WORKER_NAME` (default: the hostname), `RELAY_LANES`
(default `embroidery`), `RELAY_LABELS`, `RELAY_INTERVAL` and `RELAY_MAX_INTERVAL` (seconds), `RELAY_ONCE=1` for one
tick.
