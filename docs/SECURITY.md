# Security

relay runs other people's text through coding agents that can edit files and push branches, on machines that hold
your subscriptions. This page states the rules that keep that safe and what the code does to enforce them. If a
change to relay would weaken any rule here, it needs a decision in `docs/ARCHITECTURE.md` first.

## The credential rule

**Tasks move, credentials never do.**

- A lane's model call runs on a machine where you logged in with the vendor's own tool (`claude`, `codex`, `grok`,
  `fx`, `gh`). The login lives in that user's home directory and keychain, where the vendor put it. Two things are
  paid per token instead, and both are opt-in: one task a person approved a paid sandbox run for ("Grants and paid
  runs" below) and the optional lead ("The lead" below).
- No login, token, `auth.json`, cookie, or config directory is ever copied between machines, pasted into a chat,
  stored as a GitHub secret, or checked into a repository. `.env.example` lists names only.
- The worker's `cleanEnv` (`packages/core/src/work/env.ts`, `JOB_ENV_STRIPPED`) unsets `GH_TOKEN`, `GITHUB_TOKEN`,
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` and `XAI_API_KEY` so a stray key can never make a
  lane run outside the subscription or act as someone other than the machine's operator, and `RELAY_TOKEN`,
  `RELAY_SITE` and `RELAY_HOME` so the lane never sees the worker's own site credential or its `~/.harness`. It also
  drops `BOARD_TOKEN`, `BOARD_URL`, `BOARD_PROFILE`, `VERCEL_TOKEN`, `VERCEL_AUTH_TOKEN`, `VERCEL_OIDC_TOKEN`,
  `RELAY_GATEWAY_URL` and `RELAY_GATEWAY_TOKEN`. The Claude lane also hands Claude Code no API endpoint from the
  environment (`ANTHROPIC_BASE_URL`), so the lane cannot be pointed at another server by a variable.
- A worker holds no relay credential. It reaches the team's Vercel Board, where the tasks live, with the machine's
  own `vercel login` (`BOARD_TOKEN` in CI), and what it may claim and write there is what the board's grants give
  that login. A lane never talks to the board; the worker does.
- API keys for pay-per-token overflow lanes (`AI_GATEWAY_API_KEY`) live in Vercel's environment for the web app and
  nowhere else; workers do not have them.

If a credential does leak, revoke it at the vendor first, then redo the login on the affected machine.

## Prompt injection: issue text is data

Anyone who can open an issue in a linked repo can write text that a lane will read. relay treats that text as
data, never as instructions:

- **Who can start a lane.** Opening an issue does nothing; labelling it needs triage permission and an allowlisted
  login. The web app applies that gate when an `agent:<lane>` label arrives by webhook and would open a task on the
  board (`senderMayOpenTasks`, `apps/web/lib/webhooks/senders.ts`): the label's sender must be in
  `RELAY_ALLOWED_SENDERS` (the environment, else the repo's Actions variable), and when neither is set nobody may
  open a task that way. The site's API and MCP
  tools need a `tasks:write` token instead, and the site writes the task as a profile named for the caller. On the
  board, `relay task create` acts as the caller's own Vercel login, and a
  worker claims only tasks whose owner is its own login or one named in `board.from` (`relay setup --board --from`):
  a task's text is instructions for whoever claims it, so that list is who the machine takes instructions from.
- **What relay acts on, on the board.** Anyone who may label in a channel can set any label, so labels only steer
  (`lane`, `model`, and `cloud`, a hint for the site that a paid run was granted). Where a worker clones and what
  issue a task answers come from the `relay-task@1` block in the task's own text, which is its owner's: the board
  holds a task whose root someone else edits. How a run ended, an eval's verdict and a gate release are blocks in
  replies, whose author the board verifies. The pull request an approval merges is the one the hold's reason names,
  which only the claim that held the task could write, and it is merged only if its head is a branch relay pushed for
  that task (`relay/<lane>-<8 hex of the task ID's hash>`). A worker pushes only its own branch for the task, or, when
  it answers an eval, the branch the earlier run's `relay-run@1` block names and only when that is also a branch relay
  pushed for the task; never one a label or a block alone names. A `base` and a `branch` must be branch names and a
  `model` a model id before they reach git or a CLI: checked when a task is opened and requeued, and the worker checks
  all three again, since a task can be made by hand on the board and its `model` label set by anyone who may label
  there.
- **Who relay believes.** Data counts only from a trusted principal itself (the worker's own login, an owner in
  `board.from`: a person at the CLI) or from relay's own profiles of it, the ones whose name starts `relay-`: a
  worker's `relay-<worker>-<lane>`, the site's `relay-site`, its brief's `relay-brief` (`isTrustedActor` in
  `packages/core/src/board/schemas.ts`). A hosted relay is one principal on the board whoever asked, and it writes
  for a person or a bot as a profile named `human-…` or `bot-…`, never `relay-…`. So nothing in a caller's words is
  data, whatever principal carried it: a block a bot puts in a task's text, a note or an event through the site is
  just text to every worker and to the ledger. What the site itself says as data (a gate release, an eval that
  could not run) goes out as `relay-site`, after the site has checked who asked, with `Released by <actor>.` beside
  a release's block.
- **Who may decide.** A grant (what a task may reach or spend) and a gate release (that a person read its text) are
  believed from fewer authors than a report: a trusted principal itself, or the site's own profile of one,
  `relay-site` (`isDecidingActor` in `packages/core/src/board/schemas.ts`). A worker's profile reports what a run did
  and never decides. The reason is the paid sandbox: its firewall signs every request to the board as the worker's
  profile, so whatever a fooled lane posts there arrives as one of relay's own profiles. Under this rule it still
  cannot grant its own task a capability set, raise its own cap or release its own text. An entry of `board.from`
  that is itself a profile never decides either.
- **The text filter is the second layer.** Words that are not relay's own (a lane's summary, an eval's findings, a
  review note, a task's body) are posted with any fence that would be a block turned into a plain `json` fence
  (`prose`). It follows the board's own parser: a line that opens a fence with backticks or tildes, any whitespace,
  then `json#`. It is not the boundary; who wrote the message is. It keeps a task's own text from carrying a second
  routing block and a malformed fence from making the board refuse a message, and a task whose text still carries a
  block the filter did not know is cancelled as it is made.
- **How text reaches the shell.** It does not. A task's title and body reach a CLI only as its prompt, handed to a
  process the worker starts without a shell, so a title like `"; rm -rf ~` is a string, not a command. The
  commands a worker runs by itself are the project's own `setup` and `verify` lines, read from the profile on the
  repository's default branch, never from a task ("The project's commands and grants" below).
- **How text reaches the model.** The worker writes the task into the prompt between `<<<TASK` and `TASK>>>`
  markers under a banner that says it is data, that instructions inside it about tools, permissions, files,
  credentials or how to commit are to be ignored and reported, and what the actual deliverable is. The thread's notes
  follow between `<<<THREAD` and `THREAD>>>` the same way. The repo's own `relay.md` rules come first in the prompt,
  the task after (`composeJobPrompt` in `packages/core/src/work/job.ts`).
- **What the model can do anyway.** Even a fooled model is boxed by the CLI's permission model: Claude Code runs with
  `--permission-mode acceptEdits`, an allowlist of named commands (`Read, Edit, Write, Glob, Grep`, `Bash(git
  status|diff|log|add|commit|checkout|restore *)`, `Bash(pnpm install|test|typecheck|build|lint *)`, `Bash(pnpm run
  *)`, `Bash(pnpm -r *)`, `Bash(npm ci|install|test *)`, `Bash(npm run *)`, `Bash(npx tsc|eslint|vitest|next|prettier
  *)`, `Bash(yarn install|test|build|lint *)`, `Bash(yarn run *)`) and a refusal list (`--disallowedTools`) for `git
  push`, `git -c`, `git config`, `git remote`, `curl` and `wget`; anything on neither list (`pnpm dlx`, `pnpm exec`,
  `npm exec`, any other `npx`) is a question, which `-p` mode refuses (`CODE_TOOLS` and `CODE_DISALLOWED_TOOLS` in
  `packages/core/src/work/job.ts`; a project's profile adds its own `setup`, `verify` and tool commands to the
  allowlist as written); Codex runs with `--sandbox workspace-write`; Grok with `--permission-mode acceptEdits`; fx
  with `--auto` under its own permission rules. Reviews are read-only (`plan` modes, `--sandbox read-only`). Subagents
  and planners are disabled (`-c agents.enabled=false`, `--no-subagents --no-plan`, MCP servers off) so the lane is
  one process the worker can account for. **The Claude allowlist is a permission policy, the second layer**: it
  decides which tool calls the CLI accepts without asking. What the accepted commands and their children (a
  `package.json` script run by `pnpm test`, a git hook in the clone) can then reach is decided by Claude Code's OS
  sandbox, which every code run starts inside: see "Workers" below for what it blocks and what it does not.
- **What the model cannot reach.** On a worker (`relay work`) the lane runs in a fresh clone as the worker's own OS
  user, and the clone is deleted after the job; "Workers" below says what that means and how to set the machine
  up.
- **What happens to the output.** The lane cannot merge. The lane itself cannot push (`git push` is on the refusal
  list); the worker pushes its own `relay/<lane>-…` branch with `--force-with-lease` and opens a PR that a human
  approves; with the `eval` step listed, a second lane judges it first. **Branch protection on the default branch is
  required**, not optional: the account that pushes is the operator's own `gh` login, so without protection a fooled
  lane that found another way to run `git push` could land on `main`. Require the review and a passing CI run, and
  forbid force pushes.

### The gate

Before a worker runs a task, relay grades the task's text (`packages/core/src/tasks/gate.ts`): the title and body as
the lane would see them, plus the notes in the task's thread, capped at 20 KB. A flagged task is **held**: the worker
holds it on the board with kind `gate` and the score and the reasons as the hold's reason, and no worker claims it
again until its owner, or someone who manages its channel, lifts the hold. **This is a tripwire in front of the
sandbox, not a boundary.** What contains a fooled lane is the OS sandbox, the tool allowlist and branch protection
above; the gate only keeps the obvious cases from costing a run, and a text that passes it is still treated as data by
the brief.

Two graders, in order:

1. **The pre-check**, deterministic, no model call, runs everywhere the text is seen: when `relay task create`
   opens a task on the board, and when the site opens one over MCP, REST or an issue's label: the task is made out
   of every worker's reach and a hit is held before any sees it ready (no vendor login is needed for this part).
   It holds when the text matches any of these markers (`GATE_MARKERS`): `ignore previous instructions` (and
   "disregard / forget / override … prior / above / all / your … instructions / rules / guidance / prompt"),
   `curl … | sh` (or `wget`, piped into any shell), `.ssh`, `credentials.json`, `GITHUB_TOKEN` (and `GH_TOKEN`),
   `ANTHROPIC_API_KEY` (and `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `XAI_API_KEY`),
   `--dangerously-skip-permissions`, `git push --force` (or `-f`) to `main` or `master`, and `~/.harness`
   (`$RELAY_HOME`, `.harness/credentials`). A hit is `grader: precheck`, score 1, one reason per marker. These words
   have honest uses (an issue about relay itself will name `GITHUB_TOKEN`); the cost of a false hold is one click on
   the task page.
2. **The model grade**, on the worker, after the clone and before the lane runs: one call on the utility lane (Sonnet
   by default; `RELAY_GATE_MODEL=fable|opus|sonnet` overrides) through the Claude adapter with no tools,
   `--setting-sources ""`, MCP servers off, no instruction files or memory, and structured output against the schema
   `{ verdict: "clear" | "hold", score: 0..1, reasons: string[] }`. The prompt names what to look for (exfiltration or
   credential access; changes to CI, hooks, git config, package scripts or dependencies that execute code; contacting
   hosts; "ignore previous instructions"; disabling safety or pushing to a protected branch; anything addressed to the
   model) and puts the text under a `<<<TASK … TASK>>>` fence as data; the only output is the grade. The call is a
   `relay-usage@1` block of kind `gate` in the task's thread, like every other model call of a job. Measured 2026-10-17 on Sonnet: about 5.1 K context
   tokens per grade (the system context, the prompt and the text; cache-written on the first call, 2.2 K of it read
   back on the next), 170 to 200 output tokens, 4 seconds, $0.010 to $0.014 equivalent. A benign dark-mode request
   graded `clear` at 0.03; a body asking for a postinstall that fetches a URL and a committed `.env` graded `hold` at
   0.98 with four reasons. `RELAY_GATE=off` in the worker's environment skips this call; the pre-check still runs.

A grader that cannot run (no Claude login on a codex-only worker, a timeout) does **not** hold the task: the verdict
is `clear` with the error recorded, the worker logs `gate unavailable`, and the job runs under the sandbox as it would
have without the gate. Set `RELAY_GATE=off` on such a worker to say so on purpose.

Releasing, on the board: `relay task release <id>` posts a `relay-release@1` block with the digest of the text as it
stands (the title, the body, the notes in the thread), then lifts the hold. The board lets only the task's owner, or
someone with `manage` in its channel, lift a hold, and a worker takes the block only from who may decide: a trusted
principal itself or the site's `relay-site`, never a worker's profile ("Who may decide" above). The task is `queued`
again and that text is not graded a second time; text added to the thread afterwards changes the digest and is graded.
`relay task requeue` on a held task lifts the hold with no release, so the next job grades the same text again.

Releasing through the site (the task page's Held card, `relay_task_release({id})`, `POST /api/v1/tasks/{id}/release`)
goes through the desk (`packages/core/src/board/desk.ts`), the one layer the site's API, its pages and the MCP server
share. The site checks who asked, then posts the block as `relay-site` with `Released by <actor>.` beside it, so
workers that take the site's tasks believe it and the feed names who asked. A signed-in person may release anything
held. A bot, which is a token rather than a signed-in person, needs `tokens:write` (not `tasks:write`: releasing is
vouching for text, the same trust as approving another agent's access) and never releases a task whose text it wrote
any part of: the task itself or a note in its thread, since the gate grades both. The same layer keeps a bot from
approving a task it opened. Both are judged from who the board says wrote a message, and `bot:oauth:<name>` and
`bot:<name>` are the same bot.

Settling a task has a scope of its own. Approving one (which merges its pull request) and closing one take
`tasks:decide`; `tasks:write` opens tasks, sends one in review back and requeues one, and nothing more. The scope is
checked on relay's server for every call (`TOOL_SCOPES` in `packages/mcp/src/server.ts` for the MCP tools,
`ACTION_SCOPE` in `apps/web/app/api/v1/tasks/[...id]/route.ts` for the API), so a bot that opens work can hold a
token that cannot settle any, and that does not depend on the bot's own tool list. This is a change for bot tokens
that already exist: one minted with `tasks:write` before `tasks:decide` existed can no longer approve or close a task
until it is replaced by one that carries `tasks:decide`. A signed-in person is not affected.

## Workers (`relay work`)

A worker is the operator's own machine running the vendor CLIs under the operator's own logins (`docs/WORKERS.md`).
State the facts plainly:

- **The Claude lane's Bash runs inside Claude Code's OS sandbox** (Seatbelt on macOS, bubblewrap and socat on Linux).
  Every code run passes one settings document with `--settings` (`claudeSandboxSettings` in
  `packages/core/src/lanes/sandbox.ts`), and `--setting-sources ""` makes it the only settings the run sees, so
  neither the machine's `~/.claude` nor a `.claude/settings.json` in the clone can loosen it. Inside it, every Bash
  command and every child process (git, pnpm, a repository's own scripts, a git hook) may write only inside the clone
  and the pnpm/npm stores, may not read `~/.harness`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.fx`,
  `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.gitconfig` or the login the worker reaches the board
  with (the Vercel CLI's auth directories, `~/.vercel`, `~/.config/board`), and may reach only the package registries
  and GitHub download hosts on the network allowlist (`strictAllowlist`; `RELAY_LANE_ALLOWED_DOMAINS` adds hosts, and
  so does a capability set a person granted the task) through Claude Code's local proxy. `failIfUnavailable` and
  `allowUnsandboxedCommands: false` mean a machine that cannot sandbox fails the job with a message saying what to
  install; nothing ever falls back to running unsandboxed. Verified on macOS with Claude Code 2.1.280: `head
  ~/.gitconfig` and `touch ~/x` fail with "Operation not permitted", `curl` to an unlisted host gets a proxy 403 with
  a `deny network-outbound` violation.
- **What the sandbox does not cover.** It wraps Bash, not the Read/Edit/Write tools, so the same paths are refused
  again with `permissions.deny` rules (`Read(~/.ssh/**)`, `Edit(~/.gitconfig)`, ...) and
  `blockReadsOutsideWorkingDirectories` keeps the Read tool inside the clone. The Claude Code process itself (the
  model call, the login) runs outside the sandbox, which is why the subscription still works. Codex's `--sandbox
  workspace-write` is that vendor's own sandbox; Grok and fx have no OS sandbox, and run under their permission modes
  alone.
- **The permission allowlist (`CODE_TOOLS`, `CODE_DISALLOWED_TOOLS`) is the second layer.** It limits which tool
  calls Claude Code accepts without asking (named git, pnpm, npm, yarn and npx subcommands; no push, no git
  config, no fetchers); the sandbox limits what those commands can reach once they run. Either alone is weaker than both.
- **`relay work --no-sandbox` is the escape hatch, and it is recorded.** The worker logs a warning on start, says
  `sandbox OFF` in its banner line, and advertises the label `sandbox:off` in its message in `relay/workers`, which `relay work status` shows. Use it only on a machine where
  the Claude lane's Bash may run with the full rights of the worker's OS user.
- **The lane still runs as the worker's OS user.** The sandbox denies the credential paths above, but any other file
  that user can read, a fooled lane can read; `cleanEnv` strips the API keys, the board's and Vercel's tokens and
  the worker's `RELAY_TOKEN`, `RELAY_SITE` and `RELAY_HOME` from the lane's environment, and the clone under `$RELAY_HOME/work` is deleted after
  the job. The next tier is the container worker below.
- **`relay work --isolation container` is the recommended setup on a Mac** (docs/WORKERS.md, "Isolation"). The
  whole worker runs in one persistent Linux VM made with Apple's `container` CLI: the vendor and `gh` logins are
  created inside it and live in its volume, nothing from the Mac's home is mounted, and the lane's shell cannot see
  the host. The Claude lane's Bash still runs in Claude Code's sandbox, nested in the VM, when bubblewrap can start
  there (the container is created with the runtime's `/proc` masks off for that reason; verified on `container`
  1.5.0 with Anthropic's sandbox runtime); when it cannot, the lane runs with the allowlist alone and the worker says
  so with the label `sandbox:container`, never `sandbox:off`. The worker registers as `<host>-container` with
  `isolation:container`, so `relay work status` shows which machine is a container. The worker inside reaches the board
  with a Vercel login of its own, made inside the container (`relay work container login vercel`). What it does not change: the lane
  still pushes as the `gh` account inside, so branch protection stays required; the logins inside are real logins,
  destroyed only by deleting the volume (`relay work container rm --volume`); and the container's network is the
  Mac's, limited only by the nested sandbox's allowlist for the Claude lane.
- **A dedicated OS user is the alternative** where `container` is not available. Create a user that holds the vendor
  logins and the `gh` login and nothing else (no SSH keys, no sudo, no browser profile, no access to your home
  directory) and run the worker service as that user. A worker on your daily-use account works and is how `relay
  setup` gets you started; with the sandbox on it is acceptable, without it it should be temporary.
- **Linux prerequisites.** `bubblewrap` and `socat` must be on PATH (`sudo apt install bubblewrap socat`, or `dnf`);
  `relay doctor` has a `sandbox` line that says so. macOS needs nothing extra.
- **Branch protection on the default branch is required.** The worker pushes with the operator's `gh` login; only the
  repository's rules keep a `relay/<lane>-…` branch from becoming `main` without a review.
- Keep `board.from` short: a worker runs its own login's tasks and those of the owners that list names, and the
  board's grants decide who may make a task in a project's queue. `RELAY_ALLOWED_SENDERS` is the gate for the
  site's webhook: it keeps a label added by anyone with triage on a linked repo from becoming a task.

## The project's commands and grants

A project's profile, `.relay/project.json`, names commands a worker runs by itself and capability sets a task may be
granted (`docs/PROFILE.md`). What keeps that safe:

- **A task cannot change it.** The profile is read from the repository's default branch, never from the task's
  working tree or its base branch. Widening a set, adding a command or dropping a check takes a merged pull request.
- **Names, never values.** A set lists names of environment variables and hosts. No value is in the repository, the
  task's thread, a prompt or the log. A set may not name a credential no job may carry (`JOB_ENV_STRIPPED`).
- **Nothing by default.** A task gets a set only through a `relay-grant@1` block from an author who may decide ("Who
  may decide" above): a person at their own machine, or the site writing for a signed-in person, never a worker's
  profile. The block names the SHA-256 of the task's title and body, so a grant covers the text
  the person read: after an edit it counts for nothing.
- **A person grants.** On a site only a signed-in person may grant a set or a paid run; a token is refused with 403
  and there is no MCP tool for it (`grantFor` in `packages/core/src/board/desk.ts`). `relay task grant` on a machine
  acts as that machine's own Vercel login.
- **Where the values come from.** The worker's own environment, then the development environment of the Vercel
  project the profile names, read with the worker's own `vercel login` into a scratch directory outside the clone
  that is deleted before the lane starts. Only the granted names are taken. Nothing is copied between machines.
- **Where the values go.** Into the environment of the profile's commands, and of that run's lane only when the lane
  is `claude`: the Claude lane is the one relay can hold to the hosts the set names. On any other lane the values are
  withheld from the lane's process, and the thread and the prompt say so. The Claude lane is told the names and
  never to print a value or write one to a file. That is an instruction, not a boundary: a fooled lane holds the
  values it was granted, which is why a set is granted per task, by a person who read the task, with only the hosts
  the set names added to the network allowlist.
- **The commands are sandboxed.** `setup` and `verify` commands run without a model, and `npm ci` runs every
  dependency's install script. Each runs under Anthropic's sandbox runtime with the Claude lane's limits: writes
  inside the clone and the package caches, the credential paths unreadable, the network allowlist. The runtime is a
  dependency of relay, and `relay doctor`'s `sandbox` line warns when it is missing. A worker that should sandbox
  and cannot find it fails the command and never runs it unguarded. `--no-sandbox` on a host does not change this:
  the flag is about the Claude lane's Bash. They run directly only in relay's container when its nested sandbox
  cannot start, and in a paid run's microVM, where the container or the VM is the boundary and holds only the
  logins made in it (`packages/core/src/work/exec.ts`).
- **A granted value is taken out of what leaves the job.** A failing check prints its environment and a lane quotes
  what it saw. What a command printed and what a lane said are stripped of every granted value before they reach
  the thread, the pull request or the task's reason, and a change that contains one is not pushed (`redactor` in
  `packages/core/src/work/job.ts`). A set may not name a variable that steers the run (`STEERING_ENV`).
- **A grant covers what the lane is given.** Its digest is over the task's title, body and the thread's notes, so a
  note added after a grant voids it, and a grant or a release on an edited message is not believed.

### Grants and paid runs

One task can run on paid credits instead of a subscription, in a Vercel Sandbox a hosted relay starts
(`docs/PROFILE.md`, "Paid sandbox runs"; `docs/WORKERS.md`, "One task on paid credits"). The owner's rule is that
nothing spends money without the owner saying yes first, and waiting for one of their own machines is the default
and needs no action.

Paid runs are experimental. They stay off unless `RELAY_GATEWAY_TOKEN` is set on the deployment, and none has been
run against a real sandbox or a real gateway. Read "What a paid run's lane can reach" below before setting it.

What holds the owner's rule:

- **An offer is only a question.** The site computes it when it renders a queued task and writes nothing. It is
  never shown for a project whose profile says `cloud: never`, or on a deployment without the gateway's key.
- **The yes is a grant.** A `relay-grant@1` block with the cap, for the task's text as it stands, from who may
  decide. On the site only a signed-in person can give it, and the cap cannot exceed the deployment's limit
  (`RELAY_CLOUD_MAX_CAP_USD`). The label `cloud=approved` on the task only tells the site where to look; anyone who
  may label could set it, and it starts nothing.
- **One grant, one run.** The site marks a start in the thread as `relay-site` before the sandbox exists, under a
  key made from the task, the grant and the try, so two instances start one sandbox. Only a start that is known not
  to have come up is tried again, 3 times at most. A start that may have run is never followed by another.
- **No credential can be read in the sandbox.** The board's credential, an installation token of the site's GitHub
  App for the task's one repository and the gateway's key are set on requests by the sandbox's firewall. The
  environment inside holds placeholders, and the launcher refuses to start when a credential would be readable
  there. The network is deny by default: the board, the gateway's coding endpoint, GitHub for that repository, the
  npm registry, and the hosts of the capability sets granted to the task. A failure's text has the credentials
  removed before it is written to the thread or the log. Not readable is not the same as not usable: see "What a
  paid run's lane can reach" below.
- **The sandbox is held on the board.** It writes as the worker's profile only, and its rights there are narrowed
  to the task's own queue, `work/<project>`, and the workers channel. What it posts counts as a report and never as
  a decision. The launcher does not start a sandbox whose board policy names another queue or another profile.
- **The default branch is GitHub's to guard.** A run is approved and started only when GitHub says the repository's
  default branch requires a pull request with an approval of the most recent push, under a rule relay's GitHub App
  may not bypass (`apps/web/lib/cloud/guard.ts`; `docs/PROFILE.md`, "The branch rule"). Nothing in relay or in the
  sandbox's firewall can keep the run's token from merging or pushing there; that rule can.
- **The job checks again.** `relay work --task <id> --billing gateway --cap <usd>` runs on paid credits only when
  the thread holds that grant and the profile does not say `cloud: never`; otherwise it hands the task back. The
  cap is one for the whole job, the smaller of the grant and the flag, across the lane, its steps and the gate's
  grade. Only the Claude lane runs this way.
- **The cap is relay's own count.** It limits the model calls relay starts. It is not a limit at the gateway, and
  code the lane runs in the sandbox is not held to it (below).
- **The gateway's address and credential** come from the environment of whoever starts the worker
  (`RELAY_GATEWAY_URL`, `RELAY_GATEWAY_TOKEN`), never from a flag, a task or the board. No child of the job inherits
  them by name; the Claude Code process gets them as its endpoint and credential for that run. In a sandbox the
  credential's variable holds a placeholder.
- **Inside the sandbox the lane runs without Claude Code's OS sandbox.** The microVM and its network policy are the
  boundary there. The values of a granted capability set are not in it; only the set's hosts are allowed.
- **The tools are pinned.** The sandbox installs relay at the site's own version and Claude Code at one exact
  version (`CLOUD_CLAUDE_CODE_VERSION`), never whatever was published last.

None of this has been run against a real sandbox or a real gateway yet.

#### What a paid run's lane can reach

The lane is a model that reads the task's text, the repository and whatever it fetches. Assume it can be fooled. In
a paid run it works without the OS sandbox, so it can run any code in the microVM, and that code can send any
request the firewall signs. It cannot read a credential. It can use each one for this:

| Credential | What code in the sandbox can do with it | What it cannot |
|---|---|---|
| GitHub: an installation token of the site's App for the task's one repository, with `contents: write`, `pull_requests: write`, `metadata: read` | Push, force-push or delete any branch or tag of that repository that no rule protects. Open, edit, close, comment on, approve and merge pull requests there through `/graphql`, as far as the repository's rules allow. Read the repository | Reach any other repository, or any path on GitHub outside git's three endpoints, `/graphql` and reads under `/repos/<repo>`. Use the REST merge, ref and branch-protection paths (403 at the firewall). Touch issues, Actions, deployments, workflow files, settings or rulesets (the token lacks the permission, on REST and GraphQL alike). Change the default branch except through a pull request someone else approved, since no run starts without that rule |
| The model gateway: the site's one key, on the coding endpoint | Call the gateway from any process, outside relay's count, for as long as the sandbox lives (60 minutes at most). What that can cost is limited only by the budget on the key at the gateway | Reach any other path on the gateway's host |
| The board: the site's deployment as the worker's profile, in `work/<project>` and `relay/workers` | What any worker can in that project's queue: read every task and thread, post in them, label them, claim, hold and finish tasks, and post a run's result or an eval's verdict as a profile relay believes for reports. Post and label in the workers channel | Read or write another project's queue. Write as another profile. Grant a capability set, approve a spend, release a gate's hold or mark a start: those count only from a person or from `relay-site` ("Who may decide" above). Change grants, schemas or watchers on the board |

What follows from that, plainly:

- **A merge through GraphQL and a push to a branch cannot be blocked by the firewall.** `gh` needs `/graphql` to
  open the pull request, and a rule sees a path, not a body or a ref. The repository's branch rule is the only
  thing between a fooled lane and the default branch. Branches and tags that no rule covers are the lane's to
  overwrite or delete, and a tag or branch it pushes starts whatever workflows the repository runs on a push, with
  the secrets those workflows are given.
- **The cap does not bound what a fooled lane can spend.** A hard cap needs a gateway credential that is this run's
  alone, with a budget of its own. Vercel AI Gateway has API keys with budgets, made through its REST API with a
  person's Vercel access token; relay holds no such token and does not ask for one, so it makes no key per run.
  Set a budget on the key in `RELAY_GATEWAY_TOKEN` (`docs/HOSTING.md`, 8c). That budget is itself a soft cap: the
  gateway checks it when a request starts, so the request that crosses it still completes.
- **The sandbox writes to the board as the site's own principal.** Workers take tasks from that principal, and
  believe its `relay-…` profiles for reports. A fooled lane can therefore disturb its own project's queue: claim or
  finish tasks that are not its own, or leave a false report. It cannot make a task run with more than a person
  granted, and it cannot spend.
- **The rule on the default branch binds relay too.** relay's Approve merges as the same GitHub App, so on a
  repository that allows paid runs it merges a pull request only after a person approved it on GitHub. Putting the
  App on the rule's bypass list to avoid that gives the same bypass to every paid run; relay refuses a run when
  GitHub says the App may bypass, and cannot always be told.
- **Nothing here is verified against a live sandbox.** The firewall's rules, the narrowed token and `gh` behind
  them are tested against fakes only.

## The lead

The lead (`apps/lead`) is optional. It is a bot like any other: it reaches relay only through the site's MCP server
with a scoped token, and the desk's rules for a bot apply to it (`docs/ARCHITECTURE.md`, "The lead").

- Its token carries `tasks:read`, `tasks:write`, `memory:read`, `feed:read` and `events:write`. Never
  `tasks:decide` (approve, close), `tokens:write` (release, access for other agents) or `memory:write`. Revoking the
  token on the Access page stops it at once.
- Its tool allowlist has no approve, release or close tool, none that writes memory, and none of the asset, token,
  invite or access tools. That list is the lead's own lock. The one that holds if the lead is wrong is relay's
  server, which refuses each of those tools to a token without its scope. It has none of its framework's default
  tools: no shell, no file tools, no web tools.
- It reads relay's memory and never writes it. A decision or a preference is in every later brief, outside the fence
  that marks a task's text as data, and the lead reads text that workers wrote.
- What a worker wrote about a task reaches it as data (a wake-up's reason), never as instructions.
- Its routes that can start a turn take no anonymous caller: its conversation API takes Vercel OIDC tokens of its own
  project, and its wake route takes only a request signed with the secret it shares with the site.
- The site wakes it only when `RELAY_LEAD_URL` is set on the site, for a task that failed, was held at the gate or
  reached review. The call is signed with `RELAY_LEAD_WAKE_SECRET`, set on both projects: HMAC-SHA256 over the
  timestamp and the raw body, checked by the lead in constant time and refused when the timestamp is more than
  5 minutes off; a replay inside that window is the same wake-up, by its idempotency key. No token of any kind is
  sent, and never the site deployment's own Vercel OIDC token: that token is the site's identity on the team's board,
  where the site's word decides grants and releases, and whoever received it could act there as the site. The secret
  proves "this is the site" to the lead and is worth nothing elsewhere. Without it, or with one under 32 characters,
  the site sends nothing and the lead's wake route answers 503. The URL must be https, and a redirect is refused.
- Its model calls are billed per token through Vercel AI Gateway to the Vercel team that owns its project. A budget
  on that project in AI Gateway is the limit to rely on (`apps/lead/README.md`).

## The web app's reach

- The web app receives only webhooks (verified with `GITHUB_WEBHOOK_SECRET`, the GitHub App's own secret, and
  `VERCEL_WEBHOOK_SECRET`) and API and MCP calls carrying a scoped bearer token. It can never reach a worker; workers
  call it, not the reverse. It makes no outbound call to an address a caller chose: besides its database and blob
  store it talks to the team's Vercel Board, as its own deployment, and to GitHub.
- The web app's GitHub credential is an App, not a person's token: installation tokens are minted per repository, last
  an hour and live only in memory; the private key sits in `GITHUB_APP_PRIVATE_KEY` or, when the manifest flow created
  the app, sealed in the database under `RELAY_SESSION_SECRET` (`docs/HOSTING.md`).

## Never allowed

These are refused in code review regardless of who asks or why:

- Running any lane with permission checks disabled: `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `fx --full-access` / `--yolo`,
  `codex --dangerously-bypass-approvals-and-sandbox`, or equivalents. `relay work` never passes one, and CI greps
  the workflows and scripts for them.
- Copying or syncing a login between machines, or storing one as a GitHub secret or Vercel variable.
- Expanding `${{ github.event.* }}` user content inside a `run:` script of a workflow.
- Removing the sender gate on GitHub intake.
- Giving a worker's dedicated OS user sudo, SSH keys, or access to another user's home directory.
- Putting a value in a project's profile, or letting a token grant a capability set or a paid run.
- Giving the lead an approve, release or close tool, `tokens:write`, or a tool that does work.
- Sending a transcript, or anything other than the brief, to a model; storing transcripts in memory.
- Letting the lane merge, force-push to a protected branch, or push anything other than its own
  `relay/<lane>-…` branch (`--force-with-lease` on that branch only).
- Adding a non-official source domain to the onboarding registry without a user allowlist entry.

## Reporting

Security issues in relay itself: open a private security advisory on the repository rather than a public issue.
Include the task's ID and the worker's name if a run was involved.

## Signing in to the web app

The web app signs people in with GitHub OAuth, with no third-party auth library. Sign-in is allowed for the GitHub
logins listed in `RELAY_ALLOWED_USERS` (comma-separated, case-insensitive), the same identities the site trusts as issue
senders. An empty list means nobody can sign in, and the sign-in page says so. A successful sign-in mints a signed
session cookie scoped to the site; nothing else is stored. Agents, workers, and bots never use the browser flow: they
hold scoped bearer tokens, issued by the site's own authorization server after one approval by a signed-in person
("Access for agents" below) or minted by the operator with `relay token create`. There is no self-serve sign-up: every
token traces to a person on the allowlist. Public read of the feed is off in production; the landing, the trust pages,
the docs, the methodology, and the install skill stay public.

Needed in the environment: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `RELAY_SESSION_SECRET`,
`RELAY_ALLOWED_USERS`. `docs/HOSTING.md` has the OAuth app setup.

### The flow

| Route | What it does |
|---|---|
| `GET /auth/github/start?next=/path` | Stores a random `state` (and the same-site `next` path) in a 10-minute `HttpOnly` cookie and redirects to GitHub's authorize page with scope `read:user` and `allow_signup=false`. |
| `GET /auth/github/callback?code=&state=` | Checks `state` against the cookie, exchanges the code, reads `/user`, checks the login against `RELAY_ALLOWED_USERS`, mints a new session, and redirects to `next`. Failures redirect to `/sign-in?error=<code>` (`denied`, `no-allowlist`, `unconfigured`, `state`, `exchange`, `user`, `github`); the GitHub login is never put in a URL. |
| `POST /auth/sign-out` | Clears the cookie and redirects to `/sign-in`. A plain form post, so it works without JavaScript. |
| `GET /sign-in` | One button, "Continue with GitHub", the allowlist hint, a setup hint when the environment is incomplete, and a note that agents use tokens. A signed-in viewer is redirected to `next`. |

The GitHub access token is used once, to read `/user`, and dropped; relay never stores it.

### The session

The cookie is `relay_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days. Its value is a JWT signed with HS256
over `RELAY_SESSION_SECRET` (`jose`), issuer `relay`, carrying `{login, name, avatar_url, iat, exp}`. Every sign-in
mints a fresh token (new `iat` and `exp`); nothing is refreshed and there is no server-side session store, so signing
out is clearing the cookie and revoking everyone is rotating `RELAY_SESSION_SECRET`. `SameSite=Lax` means the cookie
is not sent on cross-site `POST`/`PUT`, which is what keeps the cookie-authenticated writes below free of CSRF.

Server code reads the viewer through `apps/web/lib/session.ts`: `getSession()` (null when anonymous) and
`requireSession()` (redirects to `/sign-in?next=`). Writes made in the browser, such as approving or rejecting an
asset, are attributed to `human:<login>`. A signed-in browser calling `/api/v1/*` without a bearer gets every scope
under that actor; API clients still use tokens.

### Public and protected routes

`apps/web/proxy.ts` runs on every request and classifies the path with `classifyRoute` (`apps/web/lib/access.ts`,
covered by `apps/web/test/access.test.ts`). Protected pages redirect to `/sign-in?next=<path>`; protected API paths
answer `401` as `application/problem+json` with a `WWW-Authenticate: Bearer` challenge.

| Public without a session | Why |
|---|---|
| `/` | the public landing for an anonymous visitor; the board for a signed-in viewer (`apps/web/lib/negotiate.ts` decides, the page renders accordingly) |
| `/info`, `/about`, `/contact`, `/privacy`, `/docs`, `/docs/*`, `/api/markdown` | the public overview, the trust pages and the docs, HTML and Markdown |
| `/openapi.json`, `/llms.txt`, `/llms-full.txt`, `/.well-known/*`, `/server.json`, `/robots.txt`, `/sitemap.xml`, `/manifest*`, `/skills/*` | the agent-readiness surface |
| `/sign-in`, `/auth/*` | the sign-in flow itself |
| `/oauth/*` | the authorization server: `register`, `token`, `device`, `revoke` are for clients; `authorize` asks for the session itself and returns to the consent page after sign-in |
| `/api/v1/info` | the API's own description |
| `/api/v1/*` with an `Authorization: Bearer` header | the token's scopes decide (`apps/web/lib/auth.ts`) |
| `/api/v1/*` `GET` without a bearer when `RELAY_PUBLIC_READ=1` | anonymous read, limited to the public read scopes (`feed:read`, `memory:read`); off by default outside mock mode |
| `/mcp` | its own bearer rules: anyone can `initialize`, `tools/list` and call `relay_get_info` and `relay_get_methodology`; the feed and project read tools answer anonymously when `RELAY_PUBLIC_READ=1`; every other tool needs a bearer with the scope and otherwise returns a tool error naming it |
| `/api/webhooks/*`, `/api/cron/*` | authenticated by `GITHUB_WEBHOOK_SECRET`, `VERCEL_WEBHOOK_SECRET`, `CRON_SECRET` |
| `/api/board`, `/api/board/*` | where the team's Vercel Board wakes the deployment's watchers; the board's own handle verifies each wake-up (`docs/ARCHITECTURE.md`, "The site and the board") |
| `/api/assets/stream`, `/api/assets/bundle/*`, `/api/assets/upload` | the signed URL is the authentication |
| `/_next/*`, `/icon.svg`, `/opengraph-image` | static output |

| Session required | |
|---|---|
| `/feed`, `/tasks/*`, `/projects`, `/projects/*`, `/usage`, `/workers`, `/assets`, `/assets/*`, `/access` (the Access page; `/tokens` redirects to it) | the app pages (and the board, which is what `/` shows a signed-in viewer) |
| `/activate`, `/setup/*` | approving a device code; the GitHub App setup |
| `/api/feed`, `/api/meters`, `/api/assets/mock/*` | the pages' internal routes |
| `/api/v1/*` without a bearer (and anonymous writes even with `RELAY_PUBLIC_READ=1`) | the signed-in viewer's scopes apply |
| anything not listed | neither: Next answers 404 (Markdown when `Accept: text/markdown`), never a redirect to sign-in, so agents and scanners see a real not-found |

In mock mode (`RELAY_DATA=mock`, or no `DATABASE_URL` with `RELAY_DATA` unset) there is no sign-in: every request
runs as the fake viewer `human:demo`, the header says "demo mode", and `RELAY_REVIEWER` may rename that actor. The
fake session never reaches `/api/v1`: anonymous API callers in mock mode get only what `RELAY_PUBLIC_READ` allows.

### Response headers

`apps/web/next.config.ts` sets on every response: `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Content-Type-Options: nosniff` and `Strict-Transport-Security: max-age=63072000; includeSubDomains`; and on every
route except the asset viewers under `/api/assets/` (which the app frames itself and which carry their own `sandbox`
CSP): `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other site can frame the
app. Writes that a browser makes, the consent decision (`POST /oauth/authorize/decision`), the `/activate` form and
every server action on the Access page, are refused when the browser marks the request `Sec-Fetch-Site: cross-site`
(`apps/web/lib/fetch-site.ts`), a second line behind the `SameSite=Lax` cookie. A `500` from `/api/v1/*` carries a
`correlation_id` and a fixed detail; the message goes to the server log only.

`RELAY_SESSION_SECRET` must be at least 32 characters (`openssl rand -hex 32` gives 64); shorter values are refused
with that hint when signing a session or sealing a setting, so a weak secret cannot be configured by accident.

## Access for agents

Tokens are never copied between people, machines or chats. The web app runs an OAuth 2.1 authorization server
(`/.well-known/oauth-authorization-server`, RFC 8414; the API and MCP server point at it from
`/.well-known/oauth-protected-resource`, RFC 9728, and from every `WWW-Authenticate` challenge) and every grant ends in
one approval by a person who signed in here. The code is `packages/core/src/oauth/server.ts`, framework-free and
covered by `packages/core/test/oauth.test.ts`; the routes under `apps/web/app/oauth` only parse requests.
`docs/INTEGRATIONS.md` is the how-to.

### What a token is

| Kind | Where it lives | Lifetime | Rotation |
|---|---|---|---|
| access token (`rly_…`) | a row in `tokens` named `oauth:<client name>`, SHA-256 only, with `expires_at` and `client_id` | **24 hours** | replaced on every refresh; the old one is revoked when the new one is minted |
| refresh token (`rrt_…`) | `oauth_refresh_tokens`, SHA-256 only, linked to its access token | **90 days** | single use: each refresh issues a new pair and marks the old refresh token used; **using an old one again revokes the whole lineage** (every descendant and their access tokens) and writes `access.revoked` |
| authorization code (`rac_…`) | `oauth_codes`, SHA-256, bound to the client, redirect URI and PKCE challenge | 10 minutes, one use | a second exchange fails and the code stays spent (a wrong `code_verifier` also spends it) |
| device code (`rdc_…`) | `oauth_device_codes`, SHA-256, with the `RLAY-XXXX` user code | 15 minutes, one redemption | polling faster than `interval` answers `slow_down` |
| invite code (`rin_…`) | `invites`, SHA-256, with `uses_left` | what `--expires` says (default 24 h), `--uses` redemptions (default 1) | spent atomically; revocable by id or name |
| operator token (`relay token create`, "Mint a token by hand" on `/access`) | the same `tokens` table, no expiry | until revoked | none |

### Who may approve, and how much

Three kinds of actor decide a device request or mint an invite, and the server tells them apart by the actor string:

| Actor | Where | May grant |
|---|---|---|
| a signed-in person (`human:<login>`) | the Access page, `/activate`, the operator's own CLI | anything, including `tokens:write` |
| a credential with `tokens:write` (`bot:oauth:concierge`, `token:ci`, the shared `RELAY_MEMORY_TOKEN` as `token:shared`) | `relay_access_approve`, `relay_invite_create` over `/mcp`; `POST /api/v1/access/{code}/approve`, `POST /api/v1/invites`, `POST /api/v1/tokens` | only scopes it holds itself, and never `tokens:write` |
| anything else | nothing: the scope gate refuses before the decision | nothing |

The ceiling is `grantCeilingError` in `packages/core/src/oauth/server.ts`, checked by `decideDeviceRequest` (approve
only; a deny is always allowed), `createInvite` and the by-hand mint at `POST /api/v1/tokens` from the scopes the
caller's grant carries, which the API routes and the MCP server pass explicitly. `human:` actors are only ever
sessions: the shared `RELAY_MEMORY_TOKEN` is `token:shared` over `/mcp` and `/api/v1`, a credential like any other. A refusal is `403` / an MCP tool error reading "a bot can approve only scopes it holds
itself, and never tokens:write; ask a person to approve this one at `<site>/activate`" and changes nothing: the code
stays pending for a person. So a chief-of-staff bot lets other agents in without anyone clicking, but an approved bot
can never widen itself, and `tokens:write` (the scope that makes an approver) is only ever handed out by a person.
Every decision is an `access.granted` or `access.denied` row naming the actor.

The Access page (`/access`) shows all of this to the operator: device requests with Approve and Deny (pending,
approved and waiting for the client to poll `/oauth/token`, and the last day's decisions), every token with how it was
issued (OAuth client, invite, by hand) and whether it renews, invites, registered clients, and the by-hand form folded
away at the bottom. Retention: a daily cron (`GET /api/cron/access-expire`, `CRON_SECRET`, 04:30 UTC in
`apps/web/vercel.json`) runs `purgeAccess`: device and authorization codes expired for more than a day, refresh tokens
expired for more than 30 days, and orphan clients (registered on the fly by the device flow, older than a day, with no
tokens, refresh tokens or live codes) are deleted; `access.*` feed rows stay as the audit trail and one `access.purged`
row records the counts when anything went. Any other client can be removed on the Access page once nothing live
depends on it (`removeClient` refuses otherwise).

PKCE `S256` is mandatory and `plain` is refused; `code_challenge_methods_supported` says only `S256`. Redirect URIs are
registered at `POST /oauth/register` and must be `https`, loopback `http` (any port, RFC 8252) or a private-use scheme;
an authorization request whose client or redirect URI does not match is answered on the page, never by redirecting
to the URI the attacker supplied. A `resource` indicator must name this site.

Scopes: a request must say what it is for. An authorization request or a device request without `scope` is
`invalid_scope`, never "everything"; only `POST /oauth/register` defaults (to the whole catalogue as the client's
ceiling) and a refresh without `scope` keeps the grant's own scopes. Scopes may only narrow on refresh.

Client names: the device flow registers a public client per machine from `client_name`, and an invite redemption may
name its client the same way. That name is read aloud on `/activate`, becomes the token's name (`oauth:<name>`) and
appears in feed rows, so it is 1 to 40 characters from letters, digits, space and `. _ @ : + -`
(`CLIENT_NAME_PATTERN`); anything else is `invalid_request` before a client row exists. The `access.requested` summary
is a fixed sentence, `client "<name>" asks for access: approve RLAY-XXXX at <site>/activate`; the requested scopes are
in the payload only, so a client cannot write its own feed line. At most 20 device requests may be pending site-wide
(`MAX_PENDING_DEVICE_REQUESTS`); the 21st is `slow_down` (429) until some are decided or expire. An approval does not
outlive its code: a device code approved but never collected within its 15 minutes is `expired_token` at the token
endpoint, and the row refuses redemption past `expires_at` as well.

### What the consent page shows

`/oauth/authorize` (and `/activate` for device codes) renders, for the signed-in person: the client's registered name
(`relay-cli@studio`, `Grok Bot`), each requested scope with the one-line description from `TOKEN_SCOPE_DESCRIPTIONS`,
where the browser returns afterwards (the redirect URI's host) and, when present, the `resource`, plus the two facts
that matter: the token lasts 24 hours and renews itself for 90 days, and it can be revoked on `/access` (Access). Approve and
Deny are plain form posts; the session cookie is `SameSite=Lax`, so a cross-site form cannot approve on the person's
behalf, and the decision route re-validates the client and redirect URI against the registration before issuing
anything the hidden fields could not have changed. A request that was not started by the person should be denied,
and the page says so.

Approvals without a browser go through `POST /api/v1/access/<user_code>/approve` with a `tokens:write` token or the
session; `GET /api/v1/access` lists what is pending. Giving a chat bot `tokens:write` is a deliberate choice: it can
then approve devices and mint invites. Every request and decision is a feed row (`access.requested`, `access.granted`,
`access.denied`, `access.revoked`) with the user code, client and scopes in its payload, so the trail is auditable.

### Revocation

- `relay token revoke oauth:<client>`, the Access page (`/tokens`), or `DELETE /api/v1/tokens/{id}` revoke an access token at
  once; its refresh token keeps working until it is also revoked, so revoke the refresh token too when the holder is
  not trusted: `POST /oauth/revoke` with `token=<refresh or access token>` (RFC 7009) does both at once.
- `relay invite revoke <id|name>`, Revoke under Invites on the Access page, or `DELETE /api/v1/invites/{id}` stops an
  unredeemed code. Revoking by name (an invite's name, or `relay token revoke oauth:<client>`) is within `tokens:write`
  by design: a holder of that scope may revoke any token or invite, including every token sharing a client name.
  Revocation is the lesser power next to minting, and the scope that can mint is the one that should be able to undo
  it; the audit row (`access.revoked`, `access.invite_revoked`) names who did it.
- Rotating `RELAY_SESSION_SECRET` signs every browser session out and makes the sealed GitHub App key unreadable;
  it does not touch tokens, which live in the database by hash.
- A reused refresh token revokes its lineage automatically; the holder sees `invalid_grant` and must be approved again.

### GitHub App

The web app's GitHub credential is an App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, or the sealed settings the
manifest flow on `/setup/github` wrote; the environment wins). It needs Actions read, Contents write (approve squash-merges the PR and deletes its branch), Deployments read,
Issues write, Metadata read, Pull requests write, and the events issues, pull_request,
pull_request_review, workflow_run, deployment_status. Installation tokens are minted per repository with a nine-minute
RS256 app JWT, cached in memory for their one-hour life and refreshed a minute early. The app's webhook deliveries are
verified with the same HMAC as an organization webhook. `installation` events write `project.github_connected` /
`project.github_disconnected`; a repository is auto-registered as a project only when it already holds a `relay.md`.
Rotation: a new private key in the environment wins immediately; or remove the stored app on `/setup/github` and run
the manifest flow again, then revoke the old key on GitHub.

## Edge rate limits

Per-IP limits on the device, registration and token endpoints and on anonymous API and MCP traffic are enforced by the Vercel WAF in front of the app (`apps/web/infra/firewall.json`, applied as in `docs/HOSTING.md`). They are the shared-store limiter the in-app one is not.
