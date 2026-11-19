---
name: cleanup
description: A cleanup pass over the codebase, behaviour unchanged, as its own pull request
when: task
lane: any
mode: edit
---

Do a cleanup pass on this repository. Nothing a user or a caller can observe may change. Work through these in order and stop when the time is better spent elsewhere; a small pull request that is entirely safe beats a large one that needs faith.

1. **Easy refactors.** Code that is harder to read than what it does. Keep behaviour identical: same inputs, same outputs, same errors, same order of side effects.
2. **Obvious performance wins.** Work done twice, a query in a loop, a file read on every call. Benchmark before and after with a command you include in the summary; if you cannot measure it, do not claim it and do not change it.
3. **Dead code.** Exports nothing imports, branches that cannot run, flags that are always one value, files nothing reaches. Prove it with a search across the whole repository before deleting, and delete its tests and docs with it.
4. **Duplicated logic.** The same rule written in two places that will drift. Consolidate it where the rule belongs, not in a new utilities file.
5. **Tests that cannot fail.** A test that asserts on a mock it set up itself, that computes its expected value the same way the code does, that has no assertion, that still passes when the code under test is deleted, or that is skipped. Also a test tied to internals, which fails on a refactor that changes no behaviour. Fix them so they test the behaviour, or delete them and say what is now untested.
6. **Docs that disagree with the code.** A README command that does not exist, a comment that describes the old behaviour, an example that would not run. The code is the truth unless the code is the bug; when it is, report it instead of fixing it here.

Rules:

- Run the project's checks before you start and after every group of changes. If they were failing before you started, say so first and do not build on top of it.
- One concern per commit-sized change, so a reviewer can accept part of it.
- Do not change public names, file layout, dependencies or formatting. Do not fix bugs: list them.
- If the task text names a scope (a directory, a package), stay inside it. If it names none, start with the files that changed most in the last month (`git log --since="1 month ago" --name-only`): cleanup pays back where the next change will land.

End with a summary a reviewer can check: what you changed under each of the six headings, the benchmark numbers, what you deleted and how you proved it was dead, and a list of what you found and deliberately left alone.
