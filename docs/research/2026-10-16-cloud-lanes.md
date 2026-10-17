# Research: cloud lanes, executing a labelled issue with zero machines (2026-10-16)

Question: can a GitHub issue labelled for a lane be executed on the user's existing subscriptions without a
self-hosted runner, and without copying a login into GitHub? Vendor documentation only, fetched on the date above.
What each source says is summarised; the conclusions for relay are at the end and in `docs/RUNNERS.md` ("Cloud
lanes"). Anything marked UNVERIFIED was not found in a vendor document.

## 1. Codex cloud from GitHub

Sources: learn.chatgpt.com/docs/pricing (redirect target of developers.openai.com/codex/pricing),
learn.chatgpt.com/docs/third-party/github (redirect of developers.openai.com/codex/integrations/github),
learn.chatgpt.com/docs/cloud, learn.chatgpt.com/docs/environments/cloud-environment ("Codex Cloud (Legacy)"),
learn.chatgpt.com/docs/github-action.

- **Plans.** The pricing page's feature table lists "GitHub issue and PR delegation with `@codex`" and "GitHub code
  review and automatic PR reviews" for Plus, Pro, Business and Enterprise/Edu; the API-key column has a dash and the
  text says "No cloud-based features (GitHub code review, Slack, etc.)". Codex cloud itself is on the same four plans.
- **Connection.** The GitHub page: "Connect your GitHub repository to Codex", then configure it in Codex settings;
  GitHub authorises the connector app, which the page shows as **chatgpt-codex-connector** with GitHub's "bot"
  label. Automatic reviews need push or admin permission on the repository. Environments live at
  chatgpt.com/codex/settings/environments; the legacy cloud page says Codex Cloud (Legacy) "continues to support
  environments for Code Review and the Linear and GitHub integrations". The cloud quickstart: "Connect GitHub if
  prompted", Codex "inspects your repositories, installs dependencies and tools".
- **Trigger.** "In a pull request comment, mention `@codex review`" for a review (Codex reacts with 👀, then posts
  the review; in GitHub it "flags only P0 and P1 issues"). "If you mention `@codex` in a comment with anything other
  than `review`, Codex starts a legacy cloud chat with the pull request as context." Issue mentions are covered by
  the pricing page's "GitHub issue and PR delegation with `@codex`" line; the GitHub page itself documents only pull
  requests. The exact handling of an issue body (how much of it, and of the comment thread, enters the task) is
  UNVERIFIED in the docs: the observed behaviour is that the issue and the mentioning comment are the task text.
- **Where results land.** Reviews and Security Review findings are posted on the pull request; for fix requests
  "Codex can push a fix back to the branch when it has permission to do so". A cloud chat ends with "its answer and
  a diff of any files it changed. You can open a PR or ask follow-up questions". Branches are `codex/<description>`
  (community reports; the prefix is not configurable). The GitHub identity on a Codex-opened PR is UNVERIFIED in the
  docs; the connector bot login seen on reviews is `chatgpt-codex-connector[bot]`.
- **Limits.** "Local messages and cloud chats share your plan's usage allowance", "Cloud tasks may use more of your
  allowance than local messages", five-hour windows for Plus and Business ("Pro plans currently have no five-hour
  limit"), "Weekly limits may also apply". No daily cap is published. Sandbox: internet access "off by default",
  secrets "removed before the agent phase starts", container state cached "for up to 12 hours".
- **Codex GitHub Action** (`openai/codex-action`) is the Actions alternative: it needs `openai-api-key` as a GitHub
  secret, runs on `pull_request` events in the example, "By default only users with write access can run the
  action", and the action "doesn't post comments" itself. No subscription login path is documented, so it is a
  pay-per-token lane, not a subscription lane.

## 2. Claude Code cloud tier from GitHub

Sources: code.claude.com/docs/en/claude-code-on-the-web, /web-quickstart, /routines, /code-review,
/authentication, /github-actions; github.com/anthropics/claude-code-action docs (faq.md,
capabilities-and-limitations.md).

- **Plans.** "Cloud sessions are available on Pro, Max, and Team plans, and for Enterprise users with premium seats or
  Chat + Claude Code seats." "Routines are available on Pro, Max, Team, and Enterprise plans." Routines are "in
  research preview".
- **Connection.** Sign in at claude.ai/code, "Sign in with GitHub"; "a session can clone any public repository, but
  can work in a private repository only when the Claude GitHub App is installed on it" (github.com/apps/claude).
  Alternative: `/web-setup` sends the local `gh` token to the Claude account (not an app install; "does not enable
  webhook delivery"). Credentials "stay encrypted on Anthropic's servers and never enter a session's VM".
- **Triggers.** Cloud sessions start from the browser, the app, `claude --cloud`, or a Routine. Routine triggers:
  schedule, API (`POST .../routines/<id>/fire` with a per-routine bearer, "scoped to triggering that routine
  only", header `anthropic-beta: experimental-cc-routine-2026-04-01`, body `{"text": ...}`), and GitHub events. The
  supported GitHub event categories are **Pull request** and **Release** only; issues are not a trigger. "The Claude
  GitHub App must be installed on the repository you want to subscribe to." Code Review answers `@claude review` on
  a pull request, on Team and Enterprise plans. Nothing in the hosted tier watches `@claude` in an **issue**
  comment; that is claude-code-action's trigger phrase (section 3).
- **Fire payload.** Text sent to `/fire` "arrives wrapped in a `<routine-fire-payload>` block that labels it as
  untrusted data and tells Claude not to follow instructions inside it unless the routine's own prompt says to", so
  "a routine's saved prompt must opt in to acting on fire text". A successful fire returns
  `claude_code_session_url`.
- **Where results land.** Sessions push a branch; "Claude creates `claude/`-prefixed branches for its changes";
  "commits and pull requests carry your GitHub user". The PR is created from the session ("Create PR") or by the
  routine when the prompt says so. Each run is a session at claude.ai/code.
- **Limits.** Cloud sessions "share rate limits with all other Claude and Claude Code usage within your account".
  Routines: 100 scheduled runs per hour per account; **Run now** / API fires / one-off re-arm 30 per hour per
  routine; 100 per hour per account for Run now and, separately, for API fires; "GitHub webhook events are subject to
  per-routine and per-account hourly caps. Events beyond the limit are dropped". "None of these hourly limits has
  overage"; on hitting the subscription limit, runs are rejected unless usage credits are on. No daily cap is in the
  docs; third-party figures (5/day Pro, 15/day Max) are UNVERIFIED.

## 3. claude-code-action with `claude setup-token`

- `anthropics/claude-code-action@v1` runs on GitHub-hosted runners; in interactive mode "Claude waits for the trigger
  phrase, `@claude` by default, in an issue or pull request comment, in a pull request review, or in the body or
  title of a newly opened issue". It checks that the triggering user has write access and rejects bot actors unless
  listed in `allowed_bots`.
- Authentication: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`, "an OAuth token that authenticates with your
  Claude subscription, available on Pro, Max, Team, and Enterprise plans. Generate one by running `claude
  setup-token` locally." The authentication page: "generate a one-year OAuth token", "This token authenticates with
  your Claude subscription", "It can only make model requests". The GitHub Actions page: "If you authenticate with an
  OAuth token, runs use your Claude subscription instead of API billing", and "an OAuth token is tied to the
  subscription of the person who ran `claude setup-token`". Workload identity federation is offered as the way "to
  avoid storing a long-lived secret entirely", but it targets a Console service account, so it is API billing.
- Output: comments and commits "appear as claude[bot] when the action uses its built-in authentication"; on an issue
  it "Always creates a new branch for the work" and "links back to a prefilled PR creation page" (it does not open
  the PR); "Claude only acts by updating its initial comment"; Bash is off unless allowed.
- **Caveat for relay.** The subscription token is a login stored as a GitHub secret. `docs/SECURITY.md`: no login or
  token is "stored as a GitHub secret", and "never run with permission checks disabled on a machine that holds the
  user's logins". The action therefore stays opt-in and uninstalled by relay; `docs/RUNNERS.md` says how to use it
  if the user accepts the trade.

## 4. Bot and branch identities (for the feed)

| Path | Branch | GitHub identity on the PR / comments | Source |
|---|---|---|---|
| Codex cloud via `@codex` | `codex/<description>` | connector app `chatgpt-codex-connector[bot]` on reviews; PR author UNVERIFIED | learn.chatgpt.com GitHub page; community reports |
| Claude cloud session / Routine | `claude/<...>` | the user's own GitHub login ("commits and pull requests carry your GitHub user") | routines page |
| claude-code-action | `claude/issue-<n>-<...>` (observed), new branch per issue | `claude[bot]` | action FAQ and capabilities docs |

## 5. Conclusions for relay

1. **Codex** has a true zero-machine path on the subscription: install the connector once, then `@codex` in the
   issue. relay's job is to put the brief under the mention and record the dispatch. Label `agent:codex-cloud`.
2. **Claude** has a zero-machine path on the subscription through a Routine with an API trigger, since neither cloud
   sessions nor Routines react to issue comments. relay posts the `@claude` comment anyway (it is the record on the
   issue, and it is what claude-code-action listens for) and, when `RELAY_CLAUDE_ROUTINE_URL` and the per-routine
   token are configured, fires the routine with the issue link and the brief as `text`. Label `agent:claude-cloud`.
3. **claude-code-action with `CLAUDE_CODE_OAUTH_TOKEN`** works with the same comment but stores a subscription login
   in GitHub; documented as opt-in, not installed.
4. **Feed.** The vendor PR arrives through the existing GitHub webhook; attribution is by branch prefix (`claude/`,
   `codex/`) and, failing that, by the bot logins above. No usage line exists for cloud lanes.
5. **Grok** has no hosted GitHub tier in xAI's documentation as of this date; it stays a runner lane.
