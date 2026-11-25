import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { isRunnableTask, questions, relay } from "../lib/shared.ts";

/**
 * Two readings that lead to different work: the lead asks once and opens nothing, then opens the task when answered.
 * The project record is what makes the ask ambiguous, so it is fixed here.
 */
export default defineEval({
  description: "Asks one question for an ambiguous ask, and opens the task once it is answered.",
  async test(t) {
    const session = await t.session({
      stubs: [
        { id: "prefs", tool: relay.recall, outcome: { response: "Preferences:\n- lane = claude (project: ambiguous-ask)" } },
        {
          id: "record",
          tool: relay.project,
          outcome: {
            response:
              "slug: ambiguous-ask\nrepo: example/ambiguous-ask\nstack: typescript\ncheck: pnpm test\n\nTwo exports exist and share no code: the CSV export of invoices (src/export/csv.ts) and the PDF export of statements (src/export/pdf.ts).",
          },
        },
      ],
    });

    const first = await session.send("In the ambiguous-ask project, fix the export. It is broken for our biggest customer.");
    first.expectOk();
    first.notCalledTool(relay.create);
    t.check(first.reply, satisfies((reply: string | undefined) => questions(reply) === 1, "exactly one question")).label("one question");

    const second = await session.send("The CSV export of invoices. It times out past 10,000 rows; it should stream instead of building the file in memory.");
    second.expectOk();
    second.calledTool(relay.create, { count: 1 });
    second.calledTool(relay.create, { input: (input) => isRunnableTask(input) && /csv/i.test(String(input.body)) }).label("the CSV task, runnable");
    t.succeeded();
  },
});
