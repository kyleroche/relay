# Runners

A runner is a machine you own that holds your vendor logins and executes lanes. GitHub Actions only schedules the
work; the vendor CLI runs locally under your subscription, and nothing secret ever leaves the machine. This guide
takes one machine from zero to serving a lane.

## 1. One OS user that holds only the agent logins

Create a dedicated user for the runner. It owns the CLI logins and nothing else: no SSH keys to production, no
password manager, no browser profile with your real accounts, no access to your home directory.

macOS (as an admin):

```text
sysadminctl -addUser relay -fullName "relay runner" -password - -home /Users/relay
```

Linux:

```text
sudo useradd --create-home --shell /bin/bash relay
```

Do not give this user sudo. Everything below happens in a shell as that user (`su - relay` or a login session).

Install the tools the lanes need, as this user or system-wide: `git`, `gh`, `jq`, Node 24 and `pnpm` (for repos that
use them), plus the vendor CLIs you own: `claude`, `codex` or `fx`, `grok`.

## 2. Log in to each CLI once, interactively

Logins are browser flows and are done by you, by hand, one time per machine. Never copy a token, `auth.json`, or a
config directory from another machine (see `docs/SECURITY.md`).

| Tool | Command | Check |
|---|---|---|
| Claude Code | `claude`, then `/login` | `claude -p --output-format json -- "pong"` returns JSON with `usage` |
| Codex | `codex login` or `fx login codex` | `codex exec --sandbox read-only "pong"` or `fx status` shows `auth=Codex subscription` |
| Grok Build | `grok login` or `fx login grok` | `grok -p "pong" --output-format json` |
| GitHub | `gh auth login` (HTTPS, then `gh auth setup-git`) | `gh auth status`; the account must be allowed to push to the repos it will serve |

`gh auth setup-git` makes git push with the gh login, which is what `run-lane.sh` relies on. Pull requests the
runner opens are therefore authored by this GitHub account; add it to `RELAY_ALLOWED_SENDERS` (step 4) so the review
lane can run on the PRs it opens.

If the machine will use `fx` for the codex or grok lane, run `fx provider codex` (or `grok`) once and confirm with
`fx status`. `run-lane.sh` sets `FX_PROVIDER` too, but fx stores the provider globally per user: if one OS user
serves both the codex and the grok lane through fx, concurrent jobs can race on that setting. Either serve one fx
lane per OS user or install the native `codex` and `grok` CLIs (the script prefers fx only when it is present).

Then run `pnpm relay doctor` from a clone of relay to see the same picture relay sees.

## 3. Register the runner with lane labels

Register at the organization level so one runner serves every repo in the org, and give it the labels
`relay` plus one label per lane the machine can serve:

1. GitHub: Organization → Settings → Actions → Runners → New runner. Pick the OS and architecture
   (macOS arm64, Linux arm64 or x64) and follow the download and `./config.sh` steps as the `relay` user.
2. When `config.sh` asks for labels, enter `relay,claude` (or `relay,codex`, `relay,grok`, or several:
   `relay,claude,codex`). The reusable workflow targets `[self-hosted, relay, <lane>]`, so a machine without a
   lane's login must not carry that label.
3. Name the runner after the machine (`mini`, `studio`). The name shows up in the feed as the worker.
4. Organization → Settings → Actions → Runner groups: restrict the group to the repos that should run lanes.

Repository-level registration works the same way but has to be repeated per repo.

Variables the workflows read (set them at the org level under Settings → Secrets and variables → Actions →
Variables, or per repo):

| Variable | Required | Meaning |
|---|---|---|
| `RELAY_ALLOWED_SENDERS` | yes | Comma-separated GitHub logins allowed to start a lane (the people who label issues, plus the runner's own gh account for reviews) |
| `RELAY_REPO` | no | `owner/relay` if the relay repo is not `kyleroche/relay` |
| `RELAY_REF` | no | Branch, tag or SHA of relay to take `scripts/runner` from (default `main`) |
| `RELAY_MODEL_CLAUDE`, `RELAY_MODEL_CODEX`, `RELAY_MODEL_GROK` | no | Model override per author lane |
| `RELAY_REVIEWER_FOR_CLAUDE`, `..._CODEX`, `..._GROK` | no | Which lane reviews which author lane (defaults: codex, claude, claude) |
| `RELAY_MAX_MINUTES` | no | Job time limit for code lanes (default 60) |
| `RELAY_KEEPALIVE_LANES` | no | JSON array of lanes the weekly keep-alive pings (default `["codex"]`) |

## 4. Run the runner as a service

One runner process serves one job at a time. That is intentional: the subscriptions are personal-use logins and
should never run a parallel farm. If you want two jobs at once on one machine (for example a codex review while a
claude lane codes), register a second runner directory with its own labels; each registration is one process.

### macOS: LaunchAgent via `svc.sh`

As the `relay` user, inside the runner directory:

```text
./svc.sh install
./svc.sh start
./svc.sh status
```

This creates a LaunchAgent (`~/Library/LaunchAgents/actions.runner.<org>.<name>.plist`) that starts at login. A
LaunchAgent only runs while the user is logged in, so:

- enable automatic login for the `relay` user, or keep a logged-in session for it (fast user switching is fine);
- in System Settings → Energy, disable sleep and enable "Start up automatically after a power failure";
- the vendor CLIs keep their logins in the user's keychain and home directory, which is why a LaunchDaemon
  (system context, no keychain) is not used.

### Linux arm64: systemd

As root, inside the runner directory the `relay` user configured:

```text
sudo ./svc.sh install relay
sudo ./svc.sh start
sudo ./svc.sh status
```

The unit is `actions.runner.<org>.<name>.service`, running as `relay`. Add any environment the CLIs need (for
example a `PATH` that includes `~/.local/bin`) to the `.env` file in the runner directory; the runner passes it to
every job. Arm64 builds of the runner are published alongside x64; the vendor CLIs all ship arm64 Linux binaries.

### What a job does on the machine

`.github/workflows/relay-run.yml` clones relay (for `scripts/runner/run-lane.sh`) and the target repo into
`$RUNNER_TEMP`, runs the lane there, and deletes both directories afterwards. Nothing accumulates in the runner's
`_work` directory, and no two jobs share a checkout. The lane itself runs with the vendor's own permission model:
Claude Code with `--permission-mode acceptEdits` and an explicit tool allowlist, Codex with `--sandbox
workspace-write`, Grok with `--permission-mode acceptEdits`. No lane ever runs with permission checks bypassed.

## 5. Codex `auth.json` goes stale; keep it warm

Codex stores a refresh token in `~/.codex/auth.json` and refreshes it when the CLI is used. A runner that serves no
codex jobs for a few weeks can wake up to an expired token, and every codex lane then fails until someone logs in
again by hand. The same can happen to fx's stored Codex login (`fx status` reports `auth_expired=true`).

`.github/workflows/relay-keepalive.yml` in the relay repo runs one tiny read-only call per lane every Monday on the
runners that carry the label, and prints the host that answered. Enable it by setting `RELAY_KEEPALIVE_LANES` to the
lanes you actually serve, for example `["codex","claude"]`. If a ping fails, the job is red in the Actions tab and
the fix is step 2 on that machine.

## 6. Private repos only

Self-hosted runners must only serve private repositories. On a public repo anyone can open a pull request from a
fork, and GitHub can run workflows from that PR on your runner. The `RELAY_ALLOWED_SENDERS` gate and the
fork check in `relay-review.yml` reduce that risk; they do not remove it. Keep the runner group restricted to
private repos, and keep "Require approval for all outside collaborators" on in the org's Actions settings.

## 7. When the runner is offline

Jobs for a label with no online runner stay queued. GitHub cancels a queued job after 24 hours, and the
`relay-run.yml` job itself is capped by `max_minutes` once it starts. What to do:

- `./svc.sh status` as the runner user; `./run.sh` in the foreground shows connection errors directly.
- Check the machine is awake and online (Tailscale or LAN), and that the logged-in session for the `relay` user is
  still there on macOS.
- Organization → Settings → Actions → Runners shows `Offline` or `Idle`. A runner that was removed for being offline
  for 30 days has to be registered again (`./config.sh`).
- If the runner is up but the job fails at "Check the runner's own logins", a login expired: redo step 2.
- To cancel queued work, cancel the workflow run in the Actions tab; re-label the issue later to run it again.
  `run-lane.sh` starts every run from the base branch and reuses the PR if one exists, so re-running is safe.

## 8. Upgrading

The runner updates itself. The vendor CLIs are updated by you, as the `relay` user, with the vendor's own command
(`claude update`, `codex` and `grok` installers, `fx` self-update). Pin and verify versions where the vendor offers
checksums; relay's `scripts/runner/run-lane.sh` only depends on documented flags and reports the CLI's own JSON, so
a CLI update that changes output shape shows up as a usage line with zeros, not as lost work.
