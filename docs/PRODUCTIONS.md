# Productions: a short on the board

relay runs work that is not code the same way it runs code: a task is opened, a worker claims it, the result waits for a decision, every step is on record. For a production (a short: script, characters, shots, voice-over, the cut) three things differ, and this page is about those three. The deliverable is a set of output files attached to the task, not a pull request. The lane is `nodes`: a [Griptape Nodes](https://docs.griptapenodes.com) workflow run headless on a machine that has the engine and the vendor keys. And the GitHub repository is a tracker: one repo holds the workflow files of every production, and each production is its own relay project on it, with its own queue on the board.

Code: `packages/core/src/tasks/manifest.ts` (the manifest), `packages/core/src/lanes/nodes.ts` and `packages/cli/python/run_workflow.py` (the lane), `packages/core/src/work/job.ts` `runNodesTask` (the run), `packages/core/src/board/tasks.ts` `approveTask` (accepting the outputs), `apps/web/lib/webhooks/project.ts` (a shared repo's project), `apps/web/app/tasks/[id]/page.tsx` (the task's page, which lists the outputs). `docs/WORKERS.md` "The nodes lane" has the worker side in full.

## The model

| | Code | Production |
|---|---|---|
| Project | one per repository, `relay link` in a checkout | one per short, `relay project add <slug> --repo <owner>/<tracker>`; several share the tracker |
| Task | a thread in the project's queue on the board (`work/<slug>`), with a code lane | a thread in the production's queue, lane `nodes` |
| Text | the task's body, written for the model | the task's body: the shot's intent for people, and a ```relay-nodes block the lane runs (`stage` is a field of that block) |
| Worker | a machine with the lane's login | a machine with the Griptape Nodes engine and the vendor keys (`relay doctor` shows `nodes`) |
| Result | a pull request | output files attached to the task's thread, versioned per output |
| Review | approve merges, request changes sends it back | approve completes the task with no merge, request changes sends it back with your note |
| Memory | decisions and preferences per project | the same, per production |

The tracker repository (say `acme/productions`) is what a nodes worker clones, with its own `gh` login. Its layout is up to you; what relay reads is the workflow files the manifests name, so a folder per production keeps them apart:

```
productions/
  blackgate/
    script.md
    shots.md
    workflows/
      character-ref.py
      cutscene.py
      news-vo.py
  halloween-1/
    …
```

A workflow file is what Griptape Nodes saves (`~/Documents/GriptapeNodes/<name>.py` on a Mac): commit it to the tracker and name it in the manifest by its repo-relative path.

## Opening a production

```bash
relay project add blackgate --repo acme/productions --stack "Griptape Nodes · Seedance · ElevenLabs"
relay decide --project blackgate "Night exteriors are wet asphalt, sodium light, no lens flares"
relay prefer --scope project --scope-id blackgate style "35mm, shallow focus, muted palette"
```

The first command registers the project (idempotent; `PUT /api/v1/projects/{slug}` does the same for a bot with `projects:write`). The others seed its memory, which `relay brief` and `relay_brief` return for the production; the nodes lane itself runs the manifest and takes no brief.

## Opening a shot

A task is a thread in the production's queue. Write the body for the people and agents who will look at the result, and put the run in the fence:

````markdown
Shot 12, exterior, night. Reza crosses the street toward the diner; rain starting. 8 seconds, no dialogue.

```relay-nodes
workflow: blackgate/workflows/cutscene.py
inputs:
  Start Flow:
    prompt: "Night street, wet asphalt, a man in a grey coat crossing toward a lit diner, rain beginning, 35mm, shallow focus"
    duration: 8
outputs: [End Flow]
stage: shot
```
````

From a terminal:

```bash
relay task create --project blackgate --lane nodes --title "Shot 12: Reza crosses to the diner" --body-file shot-12.md
relay task create --project blackgate --lane nodes --title "Shot 12" --body "…" --manifest shot-12.yaml   # the fence is appended for you
```

From a bot: `relay_task_create({project: "blackgate", lane: "nodes", title, body})`, which opens the same thread as the bot's profile. From GitHub, where the site is connected to the tracker: an issue labelled `agent:nodes` by an allowed sender opens a task that answers it, and on a tracker several productions share, a `production:blackgate` label on the issue names the production. The injection gate reads the body like any other task; a manifest is data, and a body that tells the agent to do something else is held.

## What happens

1. **Queue.** The task appears on the board under its production (the project filter at the top of `/`).
2. **Running.** A worker that serves `nodes` claims it, clones the tracker, runs the workflow through the engine with the manifest's inputs, and attaches every output of the listed end nodes to the task's thread (titled `<task title> v<n>`, with a `relay-asset@1` block: the node, the parameter, the index, the version, the stage). A re-run adds the next version of the same output, so each output has a version history in the thread. The summary and the usage blocks follow, and the task is held for review.
3. **Review.** The task is in the board's Review column. Its page (`/tasks/<id>`) lists the outputs with their file name, kind, size and version. They cannot be downloaded from the site yet: open them on the board itself (`vercel board`). Approve, or Request changes with a note; `relay task approve <id>` and `relay task changes <id> --note "…"` are the same decisions from a terminal, `relay_task_approve` and `relay_task_request_changes` from a bot.
4. **Done.** Approve completes the task (`approved N outputs by <you>`), with no GitHub involved. Request changes puts your note in the thread and the task back in the queue; the next run attaches the next version of each output. Record a note as a decision (`relay decide --project blackgate "…"`) when later shots should see it too. To change a prompt or a parameter, open a new task with the new manifest: only a task's owner can edit its text without the board holding it.

The task's thread has every step of the worker: the line that says where it runs, the outputs, the summary, and a `relay-usage@1` block per output model with its cost (0 when relay has no price for the model); `relay task get <id>` sums the usage.

## The agents

Nothing here needs a person at a keyboard except the decision, and even that can be delegated to a bot with `tasks:decide`.

- **A script or story agent** (Claude, Codex, Grok through a `relay link`-ed checkout of the tracker, or a bot over MCP) writes `script.md` and `shots.md` and opens one task per character pass and per shot, with the prompt in the manifest. It reads the production's memory first (`relay_brief` / `relay brief`): the decisions and preferences, and the vendor guidance for the model it is prompting (`relay onboard bytedance/seedance-2.5`, `relay_guidance`).
- **The nodes workers** do the rendering: the Mac with the engine, the mini, a machine with a local model; a machine serves the lane when `relay doctor` shows `nodes` and the keys the workflow needs are in its environment. Nothing of the workflow's keys leaves that machine.
- **A chief of staff** (the Grok Bot walkthrough in `docs/INTEGRATIONS.md`, "Running a production") asks `relay_task_list({project, state: "review"})` for what is waiting, tells you with the task's page link, opens the next stage when the previous one is approved, and sends a task back on your word with `relay_task_request_changes`. It cannot approve a task it opened itself (a bot never approves its own work): you approve on the task's page, or a second bot that did not open the task calls `relay_task_approve`.
- **You** look at the board.

## Limits, stated

- The engine does not report what a generation cost. relay records the model and the duration per output; the cost only when `MEDIA_PRICES` (`packages/core/src/ledger/ledger.ts`) has the vendor's price for it; otherwise the usage block's cost is 0.
- An output is a board attachment: 100 MB at most per file, and a larger one fails the run. The site lists a task's outputs and cannot serve them yet. The asset library (`docs/ASSETS.md`) is a separate store that a nodes run does not write to.
- The lane runs what the manifest says. An agent that must "make the shot work" by iterating on prompts is a later lane (an agent with the engine's MCP); today the iteration is the review note and the next manifest.
- The container tier does not run the engine; a nodes worker runs in host mode.
