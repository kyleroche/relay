import { PublishUnsupportedError } from "@relay/core";
import { api, callerGrant, json, problem } from "@/lib/api";
import { absoluteAsset } from "@/lib/asset-hooks";
import { publishAsset } from "@/lib/data";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** operationId: publishAsset. Copies the bytes to the public Blob store and records the permanent URL. 501 when no public store exists. */
export const POST = api<Ctx>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const grant = await callerGrant(req);
    try {
      const asset = await publishAsset(id, grant?.actor ?? "token:unknown");
      if (!asset) return problem(404, "Not Found", `No asset with id '${id}'.`, instance);
      return json(absoluteAsset(asset));
    } catch (e) {
      if (e instanceof PublishUnsupportedError) return problem(501, "Not Implemented", e.message, instance);
      throw e;
    }
  },
  { scope: "assets:write" },
);
