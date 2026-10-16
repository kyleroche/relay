import { repo } from "@relay/core";
import { api, json, problem } from "@/lib/api";
import { getDb } from "@/lib/db";
import { int, needsDb, readJson, str } from "@/lib/integrations";
import { recordUploadedUsage, type UsageItem } from "@/lib/project-uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

const MAX_FILES = 5000;

/**
 * operationId: putProjectDigests. Body: { files: [{ path, sha256, size, summary?, summary_sha?, tokens? }], prune?,
 * usage? }. `relay link` in site mode hashes and digests locally (the Claude login stays on the machine) and uploads
 * the result here; `prune` drops rows for files no longer present; `usage` carries the step.usage rows the digest
 * calls produced so the site's ledger stays complete.
 */
export const PUT = api<Ctx>(
  async (req, ctx) => {
    const { slug } = await ctx.params;
    const instance = req.nextUrl.pathname;
    const refused = needsDb(instance);
    if (refused) return refused;
    const body = await readJson(req);
    if (!body || !Array.isArray(body.files)) return problem(400, "Bad Request", "Body must be JSON with a files array.", instance, { parameter: "files" });
    if (body.files.length > MAX_FILES) return problem(400, "Bad Request", `At most ${MAX_FILES} files per request.`, instance, { parameter: "files" });
    const db = await getDb();
    if (!(await repo.getProject(db, slug))) return problem(404, "Not Found", `No project with slug '${slug}'.`, instance);
    const files: Array<{ path: string; sha256: string; size: number; summary?: string; summary_sha?: string; tokens?: number }> = [];
    for (const raw of body.files as unknown[]) {
      const f = raw as Record<string, unknown>;
      const path = str(f.path);
      const sha = str(f.sha256);
      const size = int(f.size) ?? 0;
      if (!path || !sha || !/^[0-9a-f]{64}$/.test(sha) || path.startsWith("/") || path.includes("..")) return problem(400, "Bad Request", `Bad file entry: ${JSON.stringify(f).slice(0, 120)}.`, instance, { parameter: "files" });
      const summary = str(f.summary);
      files.push({ path, sha256: sha, size, ...(summary ? { summary, summary_sha: str(f.summary_sha) ?? sha, tokens: int(f.tokens) ?? Math.ceil(summary.length / 4) } : {}) });
    }
    await repo.upsertFileDigests(db, slug, files.map(({ path, sha256, size }) => ({ path, sha256, size })));
    const summarized = files.filter((f): f is typeof f & { summary: string; summary_sha: string; tokens: number } => !!f.summary);
    await repo.setFileSummaries(db, slug, summarized.map((f) => ({ path: f.path, summary: f.summary, tokens: f.tokens, sha256: f.summary_sha })));
    let removed = 0;
    if (body.prune === true) removed = await repo.removeMissingFileDigests(db, slug, files.map((f) => f.path));
    const usage = await recordUploadedUsage(db, slug, body.usage as UsageItem[] | undefined);
    return json({ files: files.length, summarized: summarized.length, removed, usage });
  },
  { scope: "projects:write" },
);
