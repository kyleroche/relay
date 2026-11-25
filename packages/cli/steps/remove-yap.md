---
name: remove-yap
description: Delete the comments this change added that do nothing for the next reader
when: before-pr
lane: same
mode: edit
---

The change in this working tree is finished and about to be committed. Go over it once more and remove the comments that only add noise. Touch comments and nothing else.

Look only at what this run changed: `git diff origin/{{base}}` for edited files (committed or not) and `git status --short` for new ones. Leave every other line of the repository alone, including comments you would have written differently.

Repair before you delete. For each comment this change added, take the first of these that applies:

1. It is longer than it needs to be: say the same thing in fewer words.
2. It bundles several notes in one block at the top of a function or file: move each note next to the line it is about.
3. It explains how the code used to work or why an earlier approach was dropped: rewrite it as the reason the code has to be this way now, or delete it if there is no such reason.
4. It has nothing left once the above is done: delete it.

Delete a comment outright when it:

- narrates the change instead of the code: "added", "now we", "updated to", "new:", "fixed", "as requested", "per the task", "changed from X to Y";
- restates the line under it in words (`// increment the counter` above `count++`);
- talks to a reviewer or about this conversation, the task, the issue, the prompt or the model;
- marks a section with a banner, a row of dashes or an emoji;
- is a TODO, FIXME or "for now" that this same change already resolved, or a promise nobody will keep;
- is commented-out code;
- is a docstring that only repeats the name and the types of what it documents;
- repeats the wording of the task instead of describing this code;
- is longer than the thing it sits on and that thing is simple.

Keep a comment when it says something the code cannot: why it is done this way, what breaks if it is done the obvious way, a unit, a limit, an invariant, a link to the spec or the bug, or the documentation of a public function, type or command. When a comment is half useful, cut it down to the useful half instead of deleting it.

Nothing checks a comment the way a compiler checks code, so check the ones you keep: read each against the code as it now stands, and fix or delete any that is no longer true.

Match the file: if the surrounding code documents every export, keep that documentation; if it has almost no comments, the new code should not be the exception.

Do not change code, names, formatting, strings, tests or behaviour. Do not add comments. If nothing needs removing, change nothing.

End with one line: how many comments you removed, shortened or moved, in how many files.
