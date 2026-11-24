import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import type config from "../evals.config.ts";
import { callsOutsideTheList, isRunnableTask, relay } from "../lib/shared.ts";

/** A clear ask becomes one task a stranger could run, on the lane the owner's memory names. */
export default defineEval<typeof config>({
  description: "Opens one task with a done-check for a clear ask, on the lane memory prefers.",
  async test(t) {
    const session = await t.session({
      stubs: [
        // The owner's standing preference. The lane must come from here: relay's own default would be claude.
        { id: "prefs", tool: relay.recall, outcome: { response: "Preferences:\n- lane = codex (project: clear-ask) — backend work goes to codex" } },
      ],
    });
    const turn = await session.send("In the clear-ask project: the `feed` command should take a `--json` flag that prints each event as one JSON object per line, instead of the table.");

    t.succeeded();
    t.toolOrder([relay.recall, relay.create]);
    t.calledTool(relay.create, { count: 1 });
    t.calledTool(relay.create, { input: { project: "clear-ask", lane: "codex" } }).label("lane from memory");
    t.calledTool(relay.create, { input: (input) => isRunnableTask(input) }).label("Do, Out of scope, Done when");
    // a plan task is for work that needs breaking down, and this does not
    t.calledTool(relay.create, { input: (input) => input.plan !== true }).label("not a plan task");
    t.check(turn.reply, includes(/msg_\w+/)).label("reply names the task");
    t.eventsSatisfy("no tool outside the lead's list", (events) => callsOutsideTheList(events).length === 0);

    const opened = t.context.relay.calls("clear-ask").filter((c) => c.tool === "relay_task_create");
    t.check(opened, satisfies((calls: typeof opened) => calls.length === 1, "one task reached relay"));
  },
});
