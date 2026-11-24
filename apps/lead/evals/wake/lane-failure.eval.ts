import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import type config from "../evals.config.ts";
import { relay } from "../lib/shared.ts";
import { silent, wake } from "../lib/wake.ts";

/**
 * A task fails because the lane could not run, not because of what the task asks: the lead moves it to another lane
 * once and logs why. The task then fails the same way on the new lane, and the lead leaves it: the same task is
 * never requeued twice.
 */
export default defineEval<typeof config>({
  description: "Requeues once on a lane failure, logs it, and does not requeue the same task again.",
  async test(t) {
    const { relay: fake } = t.context;
    const project = "lane-failure";
    const id = "msg_lane_failure";
    const limit = "codex did not finish: You've hit your usage limit. Try again at 9:00 PM.";
    fake.seedTask({ task_id: id, project, title: "Add a --json flag to the feed command", state: "failed", lane: "codex", model: null, reason: limit });

    const first = await wake(t, { project, task: { id, title: "Add a --json flag to the feed command", lane: "codex" }, event: { kind: "failed", cursor: "c_lane_1", reason: limit } });
    first.turn.calledTool(relay.get, { input: { task_id: id } });
    first.turn.calledTool(relay.requeue, { count: 1 });
    first.turn.calledTool(relay.requeue, { input: { id, lane: (lane: unknown) => lane === "claude" || lane === "grok" } }).label("another code lane");
    first.turn.calledTool(relay.eventLog, { input: { kind: "external.lead.requeued", project, summary: (s: unknown) => String(s).includes(id) } }).label("logged with the reason");
    first.turn.toolOrder([relay.requeue, relay.eventLog, "no_reply"]);
    t.check(first.turn.reply, satisfies(silent, "no message")).label("first wake-up: no message");
    const moved = fake.task(id);
    t.check(moved, satisfies((task: typeof moved) => task?.state === "queued" && task.lane !== "codex", "the task is queued on another lane"));

    // The new lane's worker hits its own limit: the task is failed again, and relay wakes the lead again.
    const again = `${moved?.lane ?? "claude"} did not finish: rate limited by the provider (429).`;
    fake.seedTask({ ...moved!, state: "failed", reason: again });
    const second = await wake(t, { project, task: { id, title: "Add a --json flag to the feed command", lane: moved?.lane ?? "claude" }, event: { kind: "failed", cursor: "c_lane_2", reason: again } }, first.session);
    second.turn.notCalledTool(relay.requeue);
    second.turn.calledTool("no_reply", { count: 1 });
    t.check(second.turn.reply, satisfies(silent, "no message")).label("second wake-up: no message");

    const requeues = fake.calls(project).filter((c) => c.tool === "relay_task_requeue");
    t.check(requeues, satisfies((calls: typeof requeues) => calls.length === 1, "one requeue reached relay, ever")).label("requeued once");
    t.succeeded();
  },
});
