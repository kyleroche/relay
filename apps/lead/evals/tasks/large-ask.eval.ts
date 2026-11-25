import { defineEval } from "eve/evals";
import { relay } from "../lib/shared.ts";

/** Work whose pieces depend on the repository: the lead has not read it, so it opens a plan task instead of guessing them. */
export default defineEval({
  description: "Opens one plan task for work that needs breaking down.",
  async test(t) {
    const session = await t.session({
      stubs: [{ id: "prefs", tool: relay.recall, outcome: { response: "Preferences:\n- lane = claude (project: large-ask)" } }],
    });
    await session.send(
      "In the large-ask project, move the whole app from the REST API to GraphQL: every endpoint, the web client's data layer and the tests. Keep REST working until the last screen has moved.",
    );

    t.succeeded();
    t.calledTool(relay.create, { count: 1 });
    t.calledTool(relay.create, { input: { project: "large-ask", plan: true } }).label("a plan task");
    // the constraint the requester gave has to survive into the plan task: the worker cannot ask for it
    t.calledTool(relay.create, { input: (input) => /REST/.test(String(input.body)) && /## Done when/.test(String(input.body)) }).label("goal, constraint and done-check");
  },
});
