import { api, callerGrant, json, problem } from "@/lib/api";
import { absoluteAsset, afterReview } from "@/lib/asset-hooks";
import { reviewAsset } from "@/lib/data";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: reviewAsset. Body: { decision: "approved" | "rejected", note?, by? }. A rejection note becomes a project decision. */
export const PUT = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return problem(400, "Bad Request", "Body must be JSON.", instance);
    }
    const decision = body.decision;
    if (decision !== "approved" && decision !== "rejected") return problem(400, "Bad Request", "decision must be 'approved' or 'rejected'.", instance, { parameter: "decision" });
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    if (decision === "rejected" && !note) return problem(400, "Bad Request", "A rejection needs a note; it becomes the decision the next attempt reads.", instance, { parameter: "note" });
    const grant = await callerGrant(req);
    const by = typeof body.by === "string" && body.by ? body.by : grant?.actor ?? "token:unknown";
    const asset = await reviewAsset(id, { decision, by, note });
    if (!asset) return problem(404, "Not Found", `No asset with id '${id}'.`, instance);
    await afterReview(asset);
    return json(absoluteAsset(asset));
  },
  { scope: "assets:review" },
);
