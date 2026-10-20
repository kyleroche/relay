# Productions: a short on the board

relay runs work that is not code the same way it runs code: a task is a GitHub issue, a worker claims it, the result waits for a decision, every step is a feed row. For a production (a short: script, characters, shots, voice-over, the cut) three things differ, and this page is about those three. The deliverable is an asset, not a pull request. The lane is `nodes`: a [Griptape Nodes](https://docs.griptapenodes.com) workflow run headless on a machine that has the engine and the vendor keys. And the GitHub repository is a tracker: one repo holds the issues and the workflow files of every production, and each production is its own relay project on it.

Code: `packages/core/src/tasks/manifest.ts` (the manifest), `packages/core/src/lanes/nodes.ts` and `packages/cli/python/run_workflow.py` (the lane), `packages/core/src/work/job.ts` `runNodesStage` (the run), `packages/core/src/db/tasks.ts` (the asset path of the task state), `apps/web/lib/webhooks/project.ts` (a shared repo's project), `apps/web/components/board/board.tsx` (the card). `docs/WORKERS.md` "The nodes lane" has the worker side in full; `docs/ASSETS.md` the library.

## The model

| | Code | Production |
|---|---|---|
| Project | one per repository, `relay link` in a checkout | one per short, `relay project add <slug> --repo <owner>/<tracker>`; several share the tracker |
| Task | an issue in the project's repo, `agent:<lane>` | an issue in the tracker, `agent:nodes`, `production:<slug>`, `stage:<name>` |
| Brief | the issue body, written for the model | the issue body: the shot's intent for people, and a ```relay-nodes block the lane runs |
| Worker | a machine with the lane's login | a machine with the Griptape Nodes engine and the vendor keys (`relay doctor` shows `nodes`) |
| Result | a PR with a preview | assets on the issue, versioned per output |
| Review | approve merges, request changes sends it back | approve closes the issue, reject with a note sends it back |
| Memory | decisions and preferences per project | the same, per production; a rejection note is the next run's review feedback |

The tracker repository (say `acme/productions`) needs the GitHub App installed once (`docs/INTEGRATIONS.md`, "GitHub: one app install"). Its layout is up to you; what relay reads is the issues and the workflow files the manifests name, so a folder per production keeps them apart:

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

The first command registers the project (idempotent; `PUT /api/v1/projects/{slug}` does the same for a bot with `projects:write`). The others seed its memory; every brief for a `blackgate` task carries them.

## Opening a shot

A task is an issue. Write the body for the people and agents who will look at the result, and put the run in the fence:

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

From a bot: `relay_task_create({project: "blackgate", lane: "nodes", title, body})`. The site opens the issue with `agent:nodes`, `production:blackgate` and `priority:<p>`; `stage:` is yours to add. The injection gate reads the body like any other task; a manifest is data, and a body that tells the agent to do something else is held.

## What happens

1. **Queue.** The task appears on the board under its production (the project filter at the top of `/`).
2. **Running.** A worker that serves `nodes` claims it, clones the tracker, runs the workflow through the engine with the manifest's inputs, and uploads every output of the listed end nodes as an asset on the issue (`asset.uploaded`, titled `<issue title> v<n>`, tagged with the production, the stage, the node and `nodes:<node>/<parameter>`). A re-run supersedes the previous version of the same output, so each output has a version strip. One issue comment lists the assets and the usage.
3. **Review.** The card shows the thumbnail, the kind and the version where a code task shows its PR. Open it on the card or at `/assets/<id>` (the viewer plays video and audio, shows images and PDFs). Approve (two clicks) or Reject with a note.
4. **Done.** Approve writes `asset.reviewed` approved: the task is done and the site closes the issue. Reject writes it rejected with your note: the task is queued again, the note is the review feedback in the next run's brief (and a project decision, so later shots see it), and the issue is reopened. Edit the manifest on the issue before the next run when the fix is a prompt or a parameter; a worker claims it again on the next doorbell.

The feed has every row (`run.started`, `step.usage` per output model with its cost or `cost_unknown`, `asset.uploaded`, `asset.reviewed`, `issue.closed`); `relay usage` sums the generation spend it could price.

## The agents

Nothing here needs a person at a keyboard except the decision, and even that can be delegated to a bot with `assets:review`.

- **A script or story agent** (Claude, Codex, Grok through a `relay link`-ed checkout of the tracker, or a bot over MCP) writes `script.md` and `shots.md` and opens one task per character pass and per shot, with the prompt in the manifest. It reads the production's memory first (`relay_brief` / `relay brief`): the decisions and preferences, and the vendor guidance for the model it is prompting (`relay onboard bytedance/seedance-2.5`, `relay_guidance`).
- **The nodes workers** do the rendering: the Mac with the engine, the mini, a machine with a local model; a machine serves the lane when `relay doctor` shows `nodes` and the keys the workflow needs are in its environment. Nothing of the workflow's keys leaves that machine.
- **A chief of staff** (the Grok Bot walkthrough in `docs/INTEGRATIONS.md`, "Running a production") subscribes to `asset.uploaded`, `asset.reviewed`, `run.failed`, tells you what is waiting with the asset's link, opens the next stage when the previous one is approved, and reviews on your word with `relay_asset_review`.
- **You** look at the board.

## Limits, stated

- The engine does not report what a generation cost. relay records the model and the duration per output; the cost only when `MEDIA_PRICES` (`packages/core/src/ledger/ledger.ts`) has the vendor's price for it, else `cost_unknown`.
- Assets are read into memory on ingest: fine for stills and 720p clips, not for long masters. Keep the cut's master out of the library or add it as a link.
- The lane runs what the manifest says. An agent that must "make the shot work" by iterating on prompts is a later lane (an agent with the engine's MCP); today the iteration is the review note and the next manifest.
- The container tier does not run the engine; a nodes worker runs in host mode.
