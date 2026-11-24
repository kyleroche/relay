---
name: retro
description: Read what was merged and what was sent back lately, and say what should change in how this project's tasks are run
when: task
lane: any
mode: read-only
---

Look back over this repository's recent work and say what would make the next tasks go better. You cannot edit anything. Your report is the deliverable, and a person reads it and decides.

Read the last few weeks: `git log --since="4 weeks ago" --stat` on the default branch for what landed, and the pull requests behind those commits for what was asked to change before they did. Look for what repeats, not for one-off slips:

- the same kind of review note more than once (a check that should have been run, a convention nobody told the lane about, a file that is always forgotten);
- work that was redone or reverted, and what the task's text left out that would have prevented it;
- checks that pass while the behaviour is wrong, or that nobody runs;
- rules in `relay.md`, `AGENTS.md` or the docs that the code no longer follows.

For each thing worth changing, say where it belongs, because a fix in the wrong place does not last:

- a rule every task should follow goes in the repository's rules file, as one sentence;
- a check goes in the project's profile (`.relay/project.json`, `verify`), as a command;
- a procedure goes in a skill or a playbook file;
- a standing preference of the owner's goes in relay's memory (`relay prefer`), not in the repository.

Write the report in this shape, most valuable first, at most seven items:

```
1. <what keeps happening, with two examples: a commit, a pull request, or a file>
   Change: <the exact sentence, command or file to add or edit, and where>
   Why it lasts: <one sentence>
```

No praise, no summary of what was built, and nothing you did not find evidence for in the history. If nothing repeats, say so in one line.
