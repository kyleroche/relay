import { api, json, problem } from "@/lib/api";
import { absoluteDetail } from "@/lib/asset-hooks";
import { getAsset } from "@/lib/data";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: getAsset. Metadata, the version chain, and signed view URLs that expire. */
export const GET = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const d = await getAsset(id);
    if (!d) return problem(404, "Not Found", `No asset with id '${id}'.`, req.nextUrl.pathname);
    const full = absoluteDetail(d);
    return json({ ...full.asset, versions: full.versions, task_url: full.task_url });
  },
  { scope: "assets:read" },
);
