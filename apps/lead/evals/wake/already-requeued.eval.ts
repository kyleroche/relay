import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import type config from "../evals.config.ts";
import { relay } from "../lib/shared.ts";
import { silent, wake } from "../lib/wake.ts";

/**
 * The lead's own session does not remember the requeue (a session ends after 30 idle days, and a new one starts
 * empty), but relay's feed does. The rule is to look there first, so a fresh session must still leave the task alone.
 */
export default defineEval<typeof config>({
  description: "Does not requeue a task its feed says it already requeued, even with no memory of doing so.",
  async test(t) {
    const { relay: fake } = t.context;
    const project = "already-requeued";
    const id = "msg_already_requeued";
    const reason = "grok did not finish: the login expired; run grok login on the worker.";
    fake.seedTask({ task_id: id, project, title: "Rename the settings route", state: "failed", lane: "grok", model: null, reason });
    fake.seedFeed(project, "external.lead.requeued", `Requeued ${id} from codex to grok: usage limit on codex`);

    const { turn } = await wake(t, { project, task: { id, title: "Rename the settings route", lane: "grok" }, event: { kind: "failed", cursor: "c_already_1", reason } });

    t.succeeded();
    turn.calledTool(relay.feed, { input: { project } });
    turn.notCalledTool(relay.requeue);
    turn.calledTool("no_reply", { count: 1 });
    t.check(turn.reply, satisfies(silent, "no message")).label("no message");
    t.check(fake.task(id)?.lane, satisfies((lane: unknown) => lane === "grok", "the task stayed on its lane"));
  },
});
