# Steps

A **step** is a named instruction a lane runs at a fixed point of a task: tidy the comments before the pull request
opens, have a second lane judge the work once it is up, run a cleanup pass on demand. A step is one Markdown file.
relay ships four, any of them can be replaced, and a project decides which ones its tasks run.

Code: `packages/core/src/steps/index.ts` (the file format, the layers, the profile), `packages/core/src/work/job.ts`
(where a job runs them), `packages/cli/src/commands/steps.ts` (`relay steps`), `packages/cli/steps/*.md` (the steps
relay ships; `dist/steps/` in the npm package). What a job does around them is in `docs/WORKERS.md`.

## A step file

```markdown
---
name: remove-yap
description: Delete the comments this change added that do nothing for the next reader
when: before-pr
lane: same
mode: edit
---

The change in this working tree is finished and about to be committed. Go over it once more and ...
```

The frontmatter is `key: value` lines between two `---` lines; everything under it is the instruction the lane gets.

| Key | Values | Default | Meaning |
|---|---|---|---|
| `name` | lowercase letters, digits and dashes, a letter first, at most 48 characters | the file's name | must equal the file's name without `.md` |
| `description` | one line | empty | what `relay steps ls` prints |
| `when` | `before-pr`, `after-pr`, `respond`, `task` | required | the point of a task it runs at (below) |
| `lane` | `same`, `other`, `any`, or a lane by name | `other` for `after-pr`, `any` for `task`, `same` otherwise | `same` is the lane that did the work, `other` a code lane that did not; a `task` step takes `any` or a lane name |
| `model` | a model id | the lane's own | the model the lane is asked for |
| `mode` | `edit`, `read-only` | `edit` | `read-only`: the lane may read and run checks, and nothing it changes is kept |

A key outside this list is refused, so a typo is never a silent default. In the body, `{{base}}` is replaced with the
branch the work started from (`git diff origin/{{base}}...HEAD`).

| `when` | Runs |
|---|---|
| `before-pr` | in the job's own clone, after the lane's work and before the commit, over the change that is about to be committed |
| `after-pr` | as a task of its own once the pull request is up; its findings go back to the work's thread |
| `respond` | as the answer to an `after-pr` step's findings, by the lane that did the work, on its branch as it was left |
| `task` | by itself: `relay steps run <name>` opens a task whose text is the step |

## Three layers, the nearest wins

A step is looked up by name in three places, and a nearer one replaces a farther one:

1. **relay's**: `packages/cli/steps/` in a checkout, `dist/steps/` in the installed package.
2. **The user's**: `~/.harness/steps/` (`$RELAY_HOME/steps`), for every project on that machine.
3. **The project's**: `.relay/steps/` in the repository.

A file that cannot be read as a step is reported as a problem and replaces nothing: the step of the farther layer
stays in effect. `relay steps ls` prints the problems and exits 1; a job writes them to the worker's log.

## What a project runs

A project lists the steps its tasks run, in order, in `.relay/project.json`:

```json
{ "steps": ["remove-yap", "eval"] }
```

A name with no step behind it is a problem, not a silent skip. A `respond` step is never listed: it runs by itself
when the step it answers is listed. A `task` step is not listed either: it is run on demand.

**A job reads both from the repository's default branch.** After the clone, the profile and the project's
`.relay/steps/` are read with `git show` from the default branch on the remote, never from the task's working tree
and whatever `base` the task starts from. A task therefore cannot rewrite the steps that judge it or pick its own
judges, and a change to the list or to a project step takes effect once it is merged there. The user's layer is the
one on the worker that runs the job.

## The steps relay ships

| Step | When | Lane | Mode | What it does |
|---|---|---|---|---|
| `remove-yap` | `before-pr` | `same` | `edit` | Goes over the comments this change added (`git diff origin/{{base}}` and the new files) and nothing else. A comment that is too long is shortened, a block of notes is moved next to the lines it is about, a note about how the code used to work is rewritten as the reason it is this way now. Deleted outright: narration of the change, a restatement of the line under it, words to a reviewer, banners, a TODO the same change resolved, commented-out code. Comments that say what the code cannot are kept and checked against the code. No code, name, string or test changes. Ends with one line of counts. |
| `eval` | `after-pr` | `other` | `read-only` | A lane that did not write the change judges it cold. First against the task: what is missing, what nobody asked for, what looks finished and is not. Then four questions: is this how it would have been built from scratch, does it paper over a deeper issue, did it make the codebase healthier, would you put your name on it. The answer is `Verdict: ship \| fix first \| rethink` and at most seven numbered findings, each with a file and line, why it matters and what to do instead. |
| `eval-respond` | `respond` | `same` | `edit` | The lane that did the work answers every finding: fixes it in the code when it is right, leaves the code alone and gives the fact that settles it when it is wrong, names the follow-up task when it is right and too large. It runs the project's checks again and ends with the findings numbered as given, each `fixed`, `declined` or `follow-up`. |
| `cleanup` | `task` | `any` | `edit` | A cleanup pass with behaviour unchanged, as its own pull request, in this order: easy refactors, performance wins it can measure, dead code it can prove dead, duplicated logic, tests that cannot fail, docs that disagree with the code. It runs the checks before and after, changes no public names, layout or dependencies, lists bugs instead of fixing them, and stays inside the scope the task names. |

## The eval round on the board

With `eval` listed, a task goes through one more round before a person is asked. Nothing in it rests on a label:
each move is a hold only the claim holder could write, or a block whose author the board verifies and the worker
trusts (its own login, the owners in `board.from`, their profiles; `docs/WORKERS.md`, "The board"). In order:

1. **The work.** The lane runs, the `before-pr` steps go over the change, the worker commits, pushes and opens the
   pull request with the lane's summary as a comment.
2. **The step's task is opened, held back.** The runner opens it in the same queue as the worker's own login, with
   no profile, so any worker that takes that login's tasks can claim it: `eval: <title>`, the step's `model` when
   it has one, and a `relay-task@1` block with `step`, `evaluates` (the work's task) and `branch` (the work's
   branch). It is out of every worker's reach for now. `lane: other` is the first of `claude`, `codex`, `grok`
   that has a worker online or idle and did not do the work; with none, the same lane judges on a fresh run and
   the thread says so. The work's `lane` label is set to the lane that ran it, so a task opened on `any` is
   answered by the same lane.
3. **The work is held for it.** The run's reply carries a `relay-run@1` block with the branch, the pull request and
   `eval_task`, and the work is held with kind `awaiting_eval` and the reason `eval on the codex lane: task <id> on <pull request URL>`:
   `relay task ls` shows it `blocked`. Only then is the step's task released to the queue. If the step's task
   cannot be opened, the work is held for review as it is.
4. **The eval.** A worker that serves the eval's lane claims its task. It acts only while the work is held for
   exactly this task; otherwise (the work was requeued, closed or already answered) it completes having run
   nothing. It checks out the work's branch, runs the step read-only with the work's task as its subject, and in
   the work's thread posts the findings as a note (`Eval (eval) by the codex lane…`), then a `relay-eval@1` block
   (`step`, `task`, `lane`, `verdict`, `ran: true`), then lifts the work's hold. Its own task is completed with the
   verdict line as its result.
5. **The answer.** The work's lane claims it again. The job finds an eval that ran after a run that asked for one,
   so this run is the answer: it continues that run's branch as it was left instead of starting from the base, with
   the `respond` step (`<step>-respond` when there is one, else `eval-respond`) and the task and its thread,
   findings included. The injection gate grades the thread first, as on every run. New commits are pushed to the
   same pull request, with an "Answer to the eval" comment.
6. **Review.** The task is held `awaiting_review` with the pull request's URL. A person approves or sends it back.

**When the step cannot run**, the work goes to review without it: why is said in the work's thread, a `relay-eval@1`
block with `ran: false` follows, and the work is held for review with its pull request. That covers every way the
step's task ends without findings: its lane did not finish or said nothing, the work's branch is not on the
repository, the clone failed, the step is not an `after-pr` step of the project, the injection gate held the step's
own task, or a person closed it (`relay task close <the step's task>`). The work never waits for an eval that is
not coming. A step's task that failed is `failed` with the reason.

**One round per task.** A task whose thread has a run that asked for an eval is not evaluated again: a run after
`relay task changes` goes straight to review. `relay task requeue <the work's task>` while it waits sends the work
through a fresh run to review, and the step's task then finds nothing waiting for it. `relay task close <the work's
task>` calls the step's task off.

Every step's model call is a `relay-usage@1` row with `kind: step` and the step's name: a `before-pr` step's in the
work's thread, the eval's in its own task's thread. The answer is a `run` row in the work's thread, like the work.

## Commands

```text
relay steps ls                                   # what this repository runs, in order, then every step it could with when, lane, mode and where it comes from
relay steps show eval                            # one step as this repository would run it: settings, source file, instruction
relay steps add remove-yap                       # list it in .relay/project.json (refused for a respond or a task step)
relay steps rm remove-yap                        # take it off the list
relay steps eject eval                           # copy the step that runs into .relay/steps/eval.md, to change it
relay steps eject eval --user                    # copy it to ~/.harness/steps instead; --force replaces a copy that is there
relay steps run cleanup                          # open a task in the project's queue that runs a task step by itself
relay steps run cleanup --scope packages/core --lane codex --model <id>
```

`ls`, `show`, `eject`, `add` and `rm` read and write the working tree (`--cwd <path>` names another one); they need
no board. Commit what `add`, `rm` and `eject` wrote: a job reads the default branch. `run` needs the board login
(`relay setup --board`) and takes `--project`, `--repo`, `--lane` (default: the step's), `--model` (default: the
step's, else the lane's), `--scope <path>` and `--json`. It copies the step's instruction into the task's text as it
is in the working tree at that moment, names the step in the task's `relay-task@1` block, and prints the task's ID;
the task then runs like any other, in a fresh clone, to its own pull request.

## Writing your own

1. Start from one that exists: `relay steps eject remove-yap`, rename the file and its `name`, or write
   `.relay/steps/<name>.md` from nothing. The file name and `name` must match.
2. Pick `when`. A `before-pr` step edits the change in place, so say exactly what it may touch and tell it to change
   nothing when nothing needs changing. An `after-pr` step's deliverable is its findings: use `mode: read-only`, ask
   for a first line that starts with `Verdict:` (it becomes the result of the step's task; without one the first
   line is used) and for findings a lane can act on one by one.
3. To answer your `after-pr` step differently from `eval-respond`, add `<name>-respond.md` with `when: respond`.
4. `relay steps ls` reports a file that does not parse and `relay steps show <name>` prints the step as it would
   run; `relay steps add <name>` lists it. Commit and merge both.

The instruction is the whole prompt the step adds. A job puts the repository's `relay.md` rules in front of it, then
the task's text for an `after-pr` step, the task, its thread and the project's memory for a `respond` step, and the
task's title only for a `before-pr` step.

## Limits

- Only the first `after-pr` step in the list runs. A second one is ignored.
- `before-pr` steps run on the job's own lane whatever their `lane` says; their `model` is honoured. Each has 20
  minutes at most (less when the job's own limit is shorter).
- A `before-pr` step that does not finish does not fail the job: the pull request comment and the thread say
  `Steps: <name>: did not finish (…)`.
- Steps are for the code lanes. A `nodes` task runs none, and a step's own task runs none on itself.
- `relay steps run` takes `task` steps only; `relay steps add` takes `before-pr` and `after-pr` steps only.
