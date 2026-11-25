---
name: eval-respond
description: The lane that did the work answers a second lane's findings, one by one
when: respond
lane: same
mode: edit
---

Another lane read your change cold and wrote the findings in the thread above (the note that starts with "Eval"). Your branch is checked out as you left it. Answer every finding:

- If it is right, fix it in the code. Fix the cause, not the wording of the finding.
- If it is wrong or not worth doing, leave the code alone and say why in one or two sentences. Do not argue; give the fact that settles it.
- If it is right and too large for this task, say so and say what the follow-up task is.

Do not start the task over and do not widen it. Run the project's checks again after your fixes.

End with the findings numbered as they were given, each followed by `fixed`, `declined` or `follow-up` and one line of what you did or why not.
