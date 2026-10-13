# Research: how to orchestrate three native harnesses (2026-09-23)

Question from the author: should we build something that manages tasks, shared code and worktrees across the three
vendor harnesses (Claude Code, Codex CLI, Grok Build), with fx routing requests and acting as the main interface?
And does something like this already exist?

Six web investigations ran in parallel (native CLI headless modes and policies; existing orchestrators; ACP;
cost-routing and memory stores; sandboxes and worktree tools; remote/mobile clients). Findings marked UNVERIFIED
could not be confirmed against an official source.

## 1. Short answer

- **Yes to "one layer over three native harnesses."** Every vendor CLI now has a headless mode with JSON output,
  token usage, session resume, and switches to disable its own planner and subagents. Driving them as subprocesses
  is what every surviving orchestrator in the wild does.
- **No to "fx routes and is the interface."** fx cannot route deterministically: its provider is fixed per process,
  it has no hooks or plugins, its subagents cannot be other CLIs, and it cannot see what a child CLI spent. The
  daemon we are already building is the router. fx can still be *an* interface later through relay-mcp, alongside
  the Mac/iPad app and, if we expose ACP, any editor.
- **Nothing in the wild combines all of it.** Plenty of tools run vendor CLIs in worktrees from a board or a ticket
  tracker. None pairs that with a code-side planner/executor step loop that starts each step in a fresh process with
  a tiny brief, a persistent graph as memory, and a native Mac/iPad client. The closest partial matches are Paseo
  (daemon + mobile clients), ralph-orchestrator (fresh process per iteration, multi-CLI, gates), Symphony (ticket
  state machine over the Codex app-server), and GSD/Superpowers (dispatch discipline as skills).

## 2. What each native harness gives us

| | claude (Max) | codex exec (ChatGPT sub) | grok -p (SuperGrok) |
|---|---|---|---|
| Headless | `claude -p --output-format json` | `codex exec "<p>" --json` (JSONL) | `grok -p "<p>" --output-format json` |
| Structured output | `--json-schema` → `structured_output` | `--output-schema <file>` | UNVERIFIED (`--json-schema` mentioned only for streaming-messages-json) |
| System prompt | `--system-prompt[-file]`, `--append-system-prompt` | `-c developer_instructions=…`, `model_instructions_file` | `--rules`, `--system-prompt-override` |
| Model | `--model` | `-m` | `-m` |
| Read-only / tools | `--tools`, `--allowedTools`, `--permission-mode plan` | `--sandbox read-only` (exec default) | `--sandbox read-only`, `--tools`, `--permission-mode` |
| Usage in output | in/out/cache, `total_cost_usd` (estimate) | `turn.completed.usage` in/cached/out, no cost | in/out/cache/reasoning + `total_cost_usd` |
| Resume a stuck step | `--resume <id>` | `codex exec resume <id>` | `-r <id>` |
| Kill its own planner/subagents | `--disallowedTools Agent`, `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` | `-c agents.enabled=false` | `--no-subagents --no-plan` |
| Clean context | `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources ""`, `--tools ""` (11 K) ; never `--bare` (drops login) | `CODEX_HOME=<clean>`, `--ignore-user-config`, `--ephemeral` | `GROK_HOME=<clean>`, config keys for mcp/skills/plugins/memory |
| Worktree flag | `--worktree` | experimental in CLI 0.154 (UNVERIFIED in docs) | `--worktree`, `~/.grok/worktrees` |
| ACP | adapter only, **API key only** (subscription rejected since Mar 2026) | adapter `@agentclientprotocol/codex-acp`, ChatGPT login OK; native `codex app-server` JSON-RPC | native `grok agent stdio` |
| Subscription automation policy | `claude -p` and the SDK "still draw from your subscription's usage limits" (split paused June 2026); no third-party products on Max login | permitted; shared 5-hour and weekly windows; docs recommend API keys for CI | `-p` is "for running agents inside scripts and automations"; shared weekly pool |
| Pin / verify | signed manifest + SHA256 per version | SHA256SUMS + sigstore per release | install.sh has no checksum (UNVERIFIED alternatives) |

Consequences for the lanes:

1. **Codex lane moves from fx to the Codex CLI.** `codex exec --json` reports usage and supports a JSON schema;
   `-c agents.enabled=false` and a clean `CODEX_HOME` keep it a single executor. Astra is on the ChatGPT
   subscription either way.
2. **Grok lane moves from fx to Grok Build.** First-party, reports cost, `--no-subagents --no-plan`, `GROK_HOME`.
   It also removes the fx settings-file rewrite and the catalog bug.
3. **Claude lane stays as built.** Sonnet for digests (no tools, ~11 K baseline), Fable/Opus for plan and review
   with `--tools` limited and MCP off.
4. **fx becomes the Gateway overflow lane only**, or is dropped. Its remaining value is a cheap way to call any
   Gateway model with an agent loop; the AI SDK can do the same without a binary.
5. **ACP is not the uniform seam** while the Claude adapter refuses subscription auth. Per-CLI subprocess adapters
   are the honest common denominator; that is also what vibe-kanban, Conductor, Emdash, Superset, Paseo and
   Happy do. Revisit ACP if Anthropic ships a native `claude acp`.

## 3. fx as router: why not

From fx.sh docs and source (v0.0.10): provider selection "applies globally" per process and `.fx.json` cannot set
it; `--provider-order` is Gateway-internal inference routing, not subscription switching; no hooks; "plugins"
advertised but absent (issue #390); the `subagent` tool spawns fx children only; `fx usage` never sees child CLI
spend; MCP operation timeout defaults to 60 s; ten releases in four weeks with breaking changes in five of them.

If fx is wanted as a front end, the mechanism is a stdio MCP server registered in `~/.fx/mcp.json` with a long
`operation_timeout_ms`, exposing `plan`, `run_step`, `review`, and `status` tools that call the daemon. That is the
original plan's option B (relay-mcp) and stays a phase-5 item.

## 4. What exists in the wild

| Tool | Shape | Agents | Isolation | Invocation | Status |
|---|---|---|---|---|---|
| vibe-kanban (BloopAI) | Kanban card → agent in worktree | Claude, Codex, Gemini, Copilot, Amp, Cursor, OpenCode… | worktree | CLI subprocess, stream-json | Apache-2.0, ~28 k★; company shut down 2026-04, community-maintained |
| Conductor (Melty) | Native Mac app, workspace = worktree, cloud tier | Claude, Codex, Cursor, OpenCode | worktree / microVM | bundled CLIs | closed source, $22 M Series A, iOS "soon" |
| OpenAI Symphony | Spec + Elixir reference: ticket states → runs, restart with backoff | Codex only | per-issue workspace dir | Codex app-server JSON-RPC | Apache-2.0, ~27 k★, "reference implementation" |
| Emdash, Superset, Nimbalyst | Electron ADEs: ticket intake → worktree per task → PR | many CLIs | worktree | PTY / CLI | Apache-2.0 / ELv2 / MIT; active |
| Paperclip | "Company OS": budgets, approvals, heartbeats | Claude, Codex, OpenClaw, Cursor | worktree | process adapters | MIT, ~81 k★; token burn and RCE flaws reported |
| ralph-orchestrator | Fresh process per iteration, personas per backend, test/lint gates | Claude, Codex, Gemini… | process | CLI | Rust, v2.6; license UNVERIFIED |
| Goose subrecipes | Isolated session per subrecipe with its own model | Goose | fresh session | recipe YAML | Apache-2.0 |
| GSD, Superpowers, BMAD | Skills/plugins: plan sized to executor context, fresh implementer per task, brief + report file | host agent | sub-context | skill | MIT |
| Paseo | Local daemon + iOS/Android/desktop/web clients, direct TCP/Tailscale or E2E relay | Claude, Codex, Copilot, OpenCode, Pi | session | PTY | Apache-2.0, ~18 k★ |
| Happy Coder | Wrapper CLI + self-hostable relay + mobile apps | Claude, Codex, Gemini | session | PTY | MIT, ~24 k★ |
| Claude Remote Control / Codex Remote | Vendor phone clients to a local process via vendor relay | one vendor each | session | vendor | transcript stored vendor-side (Anthropic) |
| Graphiti (FalkorDB), FalkorDB code-graph, GitNexus, Cognee | Persistent memory / code graphs with MCP | any | n/a | MCP | Apache-2.0 / MIT; only GitNexus has an independent token benchmark (−43 %) |

Patterns that recur in the good ones: worktree per unit of work with namespaced branches and lock-while-running;
vendor CLI spawned as a subprocess with structured output, inheriting the consumer login; a brief file handed to a
fresh executor, never the whole plan; a check command as backpressure between steps; ticket or plan file as source of
truth, no hidden DB state. Mistakes that recur: per-worktree dependency reinstalls that eat disk; uncapped memory
injection that raises spend (claude-mem reports); relying on the host agent's own planner and getting a harness
inside a harness; vendor-hosted transcripts for remote control.

## 5. Decisions and plan changes

1. **Router = relay daemon.** Deterministic, code-side. Interfaces in order: Mac/iPad app (phase 3), relay-mcp for
   fx or any MCP host (phase 5), and an ACP server mode so Zed/JetBrains can attach as clients (phase 5, optional).
2. **Lanes = native CLIs on subscriptions.** `claude -p` (Max), `codex exec` (ChatGPT), `grok -p` (SuperGrok).
   fx only for Gateway overflow. Each lane runs with the vendor's planner and subagents disabled and a clean config
   home so the daemon stays in charge and baseline context stays small. Measure each baseline with `relay probe`
   and record it in the ledger.
3. **One worktree per Task, steps run sequentially inside it.** Daemon-owned `git worktree add` under
   `<repo>/.relay/worktrees/<task>` on branch `relay/<task>`, `git worktree lock` while a step runs, env files copied
   from a `.worktreeinclude`-style list, `cp -c` (APFS clone) for `node_modules`. Merge back squash + ff after the
   review lane passes; keep-if-dirty sweep otherwise. Vendor `--worktree` flags stay off.
4. **Task loop borrows from Symphony and ralph.** Task states are a small state machine in the graph; a step that
   fails its check twice escalates once to Fable with the error; a crashed step restarts with backoff; the brief is
   the only thing an executor sees.
5. **Memory stays our graph.** Add a Decision/episode shape close to Graphiti's (bi-temporal validity) later;
   consider FalkorDB's own code-graph for symbols if file digests prove too coarse. Cap guidance injection at 3 K
   tokens per brief and watch avg context per call in the ledger; independent evidence for graph-memory savings is
   thin, so we measure rather than assume.
6. **Remote = tailnet-first, own app.** Paseo's transport design (direct TCP over Tailscale, optional E2E relay)
   and Claude Remote Control's push-on-approval are the models. No vendor-hosted transcript.
7. **Sandbox per lane, worktree as the primary boundary.** Codex `--sandbox workspace-write`, Grok
   `--sandbox workspace`, Claude `/sandbox` settings for Bash; Anthropic's `srt` if we ever run unattended.

## 6. Actions for the author

- Install Codex CLI and Grok Build and sign in to each with the subscription (browser flows). Version-pin both.
- Optional: `AI_GATEWAY_API_KEY` for embeddings and the overflow lane.

## 7. Sources (primary)

Claude: code.claude.com/docs/en/cli-reference, /headless, /worktrees, /sub-agents, /remote-control,
/legal-and-compliance; support.claude.com article 15036540. Codex: learn.chatgpt.com/docs/non-interactive-mode,
/app-server, /agent-configuration/subagents, /sandboxing, /pricing, /auth; github.com/openai/codex/releases.
Grok Build: docs.x.ai/build/overview, /cli/headless-scripting, /features/worktrees, /features/subagents;
github.com/xai-org/grok-build (user-guide docs 12, 14, 15, 16, 26); x.ai/news/grok-build-cli.
fx: fx.sh/docs (mcp, skills, subagents, configuration, models, context-limits, acp, usage-and-costs, sessions);
github.com/vercel-labs/fx issues #390, #1014, PR #336. ACP: agentclientprotocol.com (overview, v1 schema, RFDs,
v2 draft); github.com/agentclientprotocol/claude-agent-acp issue #337; zed.dev/acp. Orchestrators:
github.com/BloopAI/vibe-kanban, conductor.build, github.com/openai/symphony, github.com/generalaction/emdash,
github.com/superset-sh/superset, github.com/paperclipai/paperclip, github.com/mikeyobrien/ralph-orchestrator,
github.com/gsd-build/get-shit-done, github.com/obra/superpowers, github.com/getpaseo/paseo, github.com/slopus/happy.
Memory: github.com/getzep/graphiti, github.com/FalkorDB/code-graph, github.com/abhigyanpatwari/GitNexus,
github.com/topoteretes/cognee. Sandboxes/worktrees: github.com/anthropics/sandbox-runtime,
docs.docker.com/ai/sandboxes, github.com/max-sixty/worktrunk, github.com/raine/workmux, pnpm.io/git-worktrees.
