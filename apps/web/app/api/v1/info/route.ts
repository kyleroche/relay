import { api, json } from "@/lib/api";
import { infoDocument } from "@/lib/info-doc";

export const dynamic = "force-dynamic";

/** operationId: getInfo */
export const GET = api(async () => json(infoDocument(), { headers: { "cache-control": "public, max-age=300" } }));
