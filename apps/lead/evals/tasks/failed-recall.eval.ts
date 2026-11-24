import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { relay } from "../lib/shared.ts";

/**
 * Memory cannot be read. The lead says so, names the tool and the error, and opens nothing: a lane picked without the
 * owner's preferences would be its own taste, and "no preferences on record" would be a false statement.
 */
export default defineEval({
  description: "Reports a failed relay_recall as a failure, not as an empty result, and opens no task.",
  async test(t) {
    const session = await t.session({
      stubs: [{ id: "recall-down", tool: relay.recall, outcome: { throw: { message: "relay: the memory database did not answer (connection timed out)" } } }],
    });
    const turn = await session.send("In the failed-recall project, add a `--since <date>` option to the `usage` command.");

    turn.expectOk();
    t.calledTool(relay.recall, { status: "failed", count: (n) => n >= 1 && n <= 2 }).label("tried, retried at most once");
    t.notCalledTool(relay.create);
    t.check(turn.reply, includes(/relay_recall/)).label("names the tool");
    t.check(turn.reply, includes(/fail|error|timed out|could not/i)).label("says it failed");
    t.check(turn.reply, satisfies((reply: string | undefined) => !/no (matching |standing )?(preferences|decisions)|nothing (was )?found|none on record/i.test(reply ?? ""), "does not call a failure an empty result")).label(
      "not reported as empty",
    );
  },
});
