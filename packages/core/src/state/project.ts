/**
 * Project registration and file digests. A FileDigest is a ≤300-token summary keyed by content hash: the context
 * builder can name files by summary without a model ever re-reading them, and only files whose sha changed get
 * re-digested. Digests are produced by the cheapest Claude lane (Sonnet, no tools) in batches.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import * as repo from "../graph/repo.ts";
import type { GraphClient } from "../graph/client.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { runClaude } from "../lanes/claude.ts";
import { recordLane } from "../lanes/types.ts";
import { approxTokens, sha256, type Log, noopLog } from "../util.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".vercel", "out", "coverage", ".turbo", "DerivedData", "xcuserdata", ".venv", "venv", "__pycache__", ".cache", "target", "Pods"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml", ".swift", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".m", ".mm", ".css", ".scss", ".html", ".sh", ".zsh", ".sql", ".graphql", ".proto", ".env.example", ".plist", ".xml", ".cs", ".uplugin", ".uproject"]);
const MAX_BYTES = 200 * 1024;

export interface ScannedFile {
  path: string;
  sha256: string;
  size: number;
  abs: string;
}

export function scanFiles(root: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (e.startsWith(".") && e !== ".env.example") continue;
      const abs = join(dir, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e)) walk(abs);
        continue;
      }
      if (!st.isFile() || st.size > MAX_BYTES || st.size === 0) continue;
      if (!TEXT_EXT.has(extname(e)) && !/^(Makefile|Dockerfile|Package\.swift|AGENTS\.md|CLAUDE\.md)$/.test(e)) continue;
      const buf = readFileSync(abs);
      out.push({ path: relative(root, abs), sha256: sha256(buf), size: st.size, abs });
    }
  };
  walk(root);
  return out;
}

export interface ProjectHandle {
  graph: GraphClient;
  ledger?: Ledger;
}

export async function registerProject(h: ProjectHandle, p: { slug: string; path: string; stack?: string; checkCmd?: string }, log: Log = noopLog): Promise<{ files: number; removed: number }> {
  await repo.upsertProject(h.graph, p);
  const files = scanFiles(p.path);
  await repo.upsertFileDigests(h.graph, p.slug, files.map(({ path, sha256, size }) => ({ path, sha256, size })));
  const removed = await repo.removeMissingFileDigests(h.graph, p.slug, files.map((f) => f.path));
  log(`project ${p.slug}: ${files.length} files hashed, ${removed} stale digests removed`);
  return { files: files.length, removed };
}

const DIGEST_SYSTEM = "You write terse technical file summaries for an index. For each file, output 1-3 sentences (max 60 words): what it is, its main exports or responsibilities, and anything a future editor must know. No preamble.";

/** Re-digest every file whose sha changed since its summary. Batches several files per Sonnet call, no tools. */
export async function digestProject(h: ProjectHandle, slug: string, opts: { batchFiles?: number; maxFiles?: number; log?: Log } = {}): Promise<{ digested: number; calls: number }> {
  const log = opts.log ?? noopLog;
  const project = await repo.getProject(h.graph, slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  const stale = (await repo.listFileDigests(h.graph, slug, { staleOnly: true })).slice(0, opts.maxFiles ?? 400);
  if (!stale.length) return { digested: 0, calls: 0 };
  const batchN = opts.batchFiles ?? 8;
  let digested = 0;
  let calls = 0;
  for (let i = 0; i < stale.length; i += batchN) {
    const batch = stale.slice(i, i + batchN);
    const parts: string[] = [];
    for (const f of batch) {
      let content: string;
      try {
        content = readFileSync(join(project.path, f.path), "utf8");
      } catch {
        continue;
      }
      // cap each file's contribution so a batch stays well under the digest lane budget
      const cap = 6000;
      parts.push(`=== FILE: ${f.path} ===\n${content.length > cap ? content.slice(0, cap) + "\n…[truncated]" : content}`);
    }
    const prompt = `Summarize each file below. Respond as JSON: {"files":[{"path":"…","summary":"…"}]} with one entry per file, same paths.\n\n${parts.join("\n\n")}`;
    const req = { lane: "digest" as const, prompt, system: DIGEST_SYSTEM, cwd: project.path, readOnly: true, project: slug, jsonSchema: { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, summary: { type: "string" } }, required: ["path", "summary"] } } }, required: ["files"] } };
    const r = await runClaude(req, { model: "sonnet", tools: [] });
    recordLane(h.ledger, req, r, "anthropic");
    calls++;
    if (!r.ok) {
      log(`digest batch failed: ${r.error}`);
      continue;
    }
    const out = (r.json as { files?: Array<{ path: string; summary: string }> } | undefined)?.files ?? [];
    const byPath = new Map(batch.map((f) => [f.path, f]));
    const items = out.filter((o) => byPath.has(o.path)).map((o) => ({ path: o.path, summary: o.summary.trim(), tokens: approxTokens(o.summary), sha256: byPath.get(o.path)!.sha256 }));
    await repo.setFileSummaries(h.graph, slug, items);
    digested += items.length;
    log(`digested ${items.length}/${batch.length} files (${r.cacheRead + r.tokensIn} in, ${r.tokensOut} out)`);
  }
  return { digested, calls };
}

/** Build the ≤2 K-token Project.summary from README/AGENTS/CLAUDE files plus the digest index. */
export async function summarizeProject(h: ProjectHandle, slug: string, log: Log = noopLog): Promise<string> {
  const project = await repo.getProject(h.graph, slug);
  if (!project) throw new Error(`unknown project ${slug}`);
  const digests = await repo.listFileDigests(h.graph, slug);
  const heads: string[] = [];
  for (const name of ["README.md", "AGENTS.md", "CLAUDE.md", "relay.md", "package.json"]) {
    try {
      heads.push(`=== ${name} ===\n${readFileSync(join(project.path, name), "utf8").slice(0, 4000)}`);
    } catch {
      /* absent */
    }
  }
  const index = digests.filter((d) => d.summary).map((d) => `- ${d.path}: ${d.summary}`).join("\n").slice(0, 24000);
  const prompt = `Write the project brief that every future model call will receive instead of reading the repo. Max 500 words. Sections: Purpose; Stack & layout (key dirs/files); Commands (build/test/check if known, else say unknown); Conventions & hard rules; Gotchas. Be concrete, no filler.\n\n${heads.join("\n\n")}\n\n=== FILE INDEX ===\n${index}`;
  const req = { lane: "digest" as const, prompt, cwd: project.path, readOnly: true, project: slug };
  const r = await runClaude(req, { model: "sonnet", tools: [] });
  recordLane(h.ledger, req, r, "anthropic");
  if (!r.ok) throw new Error(`summary failed: ${r.error}`);
  await repo.setProjectSummary(h.graph, slug, r.text.trim(), approxTokens(r.text));
  log(`project summary: ${approxTokens(r.text)} tokens`);
  return r.text.trim();
}
