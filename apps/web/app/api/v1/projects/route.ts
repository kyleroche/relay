import { api, json } from "@/lib/api";
import { getProjects } from "@/lib/data";

export const dynamic = "force-dynamic";

/** operationId: listProjects */
export const GET = api(
  async () => {
    const projects = await getProjects();
    return json({ projects, count: projects.length });
  },
  { scope: "feed:read" },
);
