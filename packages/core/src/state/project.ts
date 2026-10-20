/**
 * Project registration and file digests. A FileDigest is a ≤300-token summary keyed by content hash: the context
 * builder can name files by summary without a model ever re-reading them, and only files whose sha changed get
 * re-digested. Digests are produced by the cheapest Claude lane (Sonnet, no tools) in batches.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import * as repo from "../db/repo.ts";
import type { Db } from "../db/client.ts";
import type { FileDigestRow } from "../db/projects.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { runClaude } from "../lanes/claude.ts";
import { recordLane, type LaneRequest, type LaneResult } from "../lanes/types.ts";
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
      const path = relative(root, abs);
      // relay.md is rendered from the summary; digesting it would feed the summary back into itself
      if (path === "relay.md") continue;
      const buf = readFileSync(abs);
      out.push({ path, sha256: sha256(buf), size: st.size, abs });
    }
  };
  walk(root);
  return out;
}

export interface ProjectHandle {
  db: Db;
  ledger?: Ledger;
}

export async function registerProject(h: ProjectHandle, p: { slug: string; path: string; repo?: string; stack?: string; checkCmd?: string }, log: Log = noopLog): Promise<{ files: number; removed: number }> {
  await repo.upsertProject(h.db, p);
  const files = scanFiles(p.path);
  await repo.upsertFileDigests(h.db, p.slug, files.map(({ path, sha256, size }) => ({ path, sha256, size })));
  const removed = await repo.removeMissingFileDigests(h.db, p.slug, files.map((f) => f.path));
  log(`project ${p.slug}: ${files.length} files hashed, ${removed} stale digests removed`);
  return { files: files.length, removed };
}

/** Token and cost totals of the model calls one operation made (fresh + cached input counted as "in"). */
export interface LaneUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costEquiv: number;
}

export const emptyUsage = (): LaneUsage => ({ calls: 0, tokensIn: 0, tokensOut: 0, costEquiv: 0 });

function addUsage(u: LaneUsage, r: LaneResult): void {
  u.calls++;
  u.tokensIn += r.tokensIn + r.cacheRead + r.cacheWrite;
  u.tokensOut += r.tokensOut;
  u.costEquiv += r.costEquiv;
}

export const formatUsage = (u: LaneUsage): string => `${u.calls} model call${u.calls === 1 ? "" : "s"}, ${u.tokensIn} tokens in, ${u.tokensOut} out, ≈$${u.costEquiv.toFixed(4)} equivalent`;

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

const DIGEST_SYSTEM = "You write terse technical file summaries for an index. For each file, output 1-3 sentences (10-60 words): what it is, its main exports or responsibilities, and anything a future editor must know. No preamble.";
const DIGEST_SCHEMA = { type: "object", properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, summary: { type: "string" } }, required: ["path", "summary"] } } }, required: ["files"] };
/** A digest shorter than this is a fragment ("Config file."), not a summary; such entries are dropped and re-requested once. */
export const DIGEST_MIN_WORDS = 10;

export interface DigestResult extends LaneUsage {
  digested: number;
  /** Files whose first digest was missing or too short and were re-requested. */
  retried: number;
  /** Files still without a digest after the retry. */
  failed: string[];
}

/**
 * Re-digest every file whose sha changed since its summary. Batches several files per Sonnet call, no tools.
 * Entries under DIGEST_MIN_WORDS words (and files the model skipped) are re-requested once in a stricter pass.
 */
export async function digestProject(h: ProjectHandle, slug: string, opts: { batchFiles?: number; maxFiles?: number; log?: Log } = {}): Promise<DigestResult> {
  const log = opts.log ?? noopLog;
  const project = await repo.getProject(h.db, slug);
  if (!project?.path) throw new Error(`unknown or path-less project ${slug}`);
  const root = project.path;
  const stale = (await repo.listFileDigests(h.db, slug, { staleOnly: true })).slice(0, opts.maxFiles ?? 400);
  const result: DigestResult = { ...emptyUsage(), digested: 0, retried: 0, failed: [] };
  if (!stale.length) return result;
  const batchN = opts.batchFiles ?? 8;

  const pass = async (files: FileDigestRow[], strict: boolean): Promise<FileDigestRow[]> => {
    const rejected: FileDigestRow[] = [];
    for (let i = 0; i < files.length; i += batchN) {
      const batch = files.slice(i, i + batchN);
      const parts: string[] = [];
      const readable: FileDigestRow[] = [];
      for (const f of batch) {
        let content: string;
        try {
          content = readFileSync(join(root, f.path), "utf8");
        } catch {
          continue;
        }
        // cap each file's contribution so a batch stays well under the digest lane budget
        const cap = 6000;
        parts.push(`=== FILE: ${f.path} ===\n${content.length > cap ? content.slice(0, cap) + "\n…[truncated]" : content}`);
        readable.push(f);
      }
      if (!readable.length) continue;
      const rule = strict
        ? `Every summary MUST be a complete description of at least ${DIGEST_MIN_WORDS} words and at most 60; a bare label such as "Config file." is rejected. Cover every file listed, using its path exactly as given.`
        : "";
      const prompt = `Summarize each file below. Respond as JSON: {"files":[{"path":"…","summary":"…"}]} with one entry per file, same paths. ${rule}\n\n${parts.join("\n\n")}`;
      const req: LaneRequest = { lane: "digest", prompt, system: DIGEST_SYSTEM, cwd: root, readOnly: true, project: slug, jsonSchema: DIGEST_SCHEMA };
      const r = await runClaude(req, { model: "sonnet", tools: [] });
      await recordLane(h.ledger, req, r, "anthropic");
      addUsage(result, r);
      if (!r.ok) {
        log(`digest batch failed: ${r.error}`);
        rejected.push(...readable);
        continue;
      }
      const out = (r.json as { files?: Array<{ path: string; summary: string }> } | undefined)?.files ?? [];
      const byPath = new Map(readable.map((f) => [f.path, f]));
      const items: Array<{ path: string; summary: string; tokens: number; sha256: string }> = [];
      for (const o of out) {
        const f = byPath.get(o.path);
        if (!f || typeof o.summary !== "string") continue;
        const summary = o.summary.trim();
        if (wordCount(summary) < DIGEST_MIN_WORDS) continue;
        items.push({ path: o.path, summary, tokens: approxTokens(summary), sha256: f.sha256 });
        byPath.delete(o.path);
      }
      await repo.setFileSummaries(h.db, slug, items);
      result.digested += items.length;
      rejected.push(...byPath.values());
      log(`digested ${items.length}/${readable.length} files (${r.tokensIn + r.cacheRead + r.cacheWrite} in, ${r.tokensOut} out)${byPath.size ? `, ${byPath.size} too short or missing` : ""}`);
    }
    return rejected;
  };

  const retry = await pass(stale, false);
  if (retry.length) {
    result.retried = retry.length;
    log(`re-requesting ${retry.length} digest${retry.length === 1 ? "" : "s"} with a stricter prompt`);
    result.failed = (await pass(retry, true)).map((f) => f.path);
    if (result.failed.length) log(`no usable digest for ${result.failed.length} file${result.failed.length === 1 ? "" : "s"}: ${result.failed.slice(0, 5).join(", ")}${result.failed.length > 5 ? ", …" : ""}`);
  }
  return result;
}

export const SUMMARY_MIN_WORDS = 150;
export const SUMMARY_MAX_WORDS = 700;
/** The headings the summary must carry, in order; matched case-insensitively at the start of a markdown heading line. */
export const SUMMARY_HEADINGS: Array<{ title: string; pattern: RegExp }> = [
  { title: "Purpose", pattern: /^#{1,3}\s*purpose\b/im },
  { title: "Stack and layout", pattern: /^#{1,3}\s*stack\s*(and|&)\s*layout\b/im },
  { title: "Commands", pattern: /^#{1,3}\s*commands\b/im },
  { title: "Conventions", pattern: /^#{1,3}\s*conventions\b/im },
  { title: "Gotchas", pattern: /^#{1,3}\s*gotchas\b/im },
];
const SUMMARY_SCHEMA = { type: "object", properties: { summary: { type: "string", description: "The project brief as markdown with the five required ## headings." } }, required: ["summary"] };

/** Why a candidate summary is unusable; empty when it passes. */
export function validateSummary(text: string): string[] {
  const problems: string[] = [];
  const words = wordCount(text);
  if (words < SUMMARY_MIN_WORDS) problems.push(`only ${words} words (need at least ${SUMMARY_MIN_WORDS})`);
  if (words > SUMMARY_MAX_WORDS) problems.push(`${words} words (at most ${SUMMARY_MAX_WORDS})`);
  const missing = SUMMARY_HEADINGS.filter((h) => !h.pattern.test(text)).map((h) => h.title);
  if (missing.length) problems.push(`missing heading${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  return problems;
}

export interface SummaryResult extends LaneUsage {
  text: string;
  tokens: number;
}

/**
 * Build the Project.summary (≤500 words, five fixed sections) from README/AGENTS/CLAUDE files plus the digest index,
 * through structured output. A result that fails validateSummary is re-requested once with a stricter prompt; a
 * second failure throws, so a fragment never becomes the summary every future call receives.
 */
export async function summarizeProject(h: ProjectHandle, slug: string, log: Log = noopLog): Promise<SummaryResult> {
  const project = await repo.getProject(h.db, slug);
  if (!project?.path) throw new Error(`unknown or path-less project ${slug}`);
  const root = project.path;
  const digests = await repo.listFileDigests(h.db, slug);
  const heads: string[] = [];
  for (const name of ["README.md", "AGENTS.md", "CLAUDE.md", "package.json"]) {
    try {
      heads.push(`=== ${name} ===\n${readFileSync(join(root, name), "utf8").slice(0, 4000)}`);
    } catch {
      /* absent */
    }
  }
  const index = digests.filter((d) => d.summary).map((d) => `- ${d.path}: ${d.summary}`).join("\n").slice(0, 24000);
  const headings = SUMMARY_HEADINGS.map((h) => `## ${h.title}`).join(", ");
  const base =
    `Write the project brief that every future model call will receive instead of reading the repo. ` +
    `Between ${SUMMARY_MIN_WORDS} and 500 words of markdown with exactly these five headings, in this order: ${headings}. ` +
    `Purpose: what the project is and for whom. Stack and layout: languages, frameworks, key directories and files. Commands: build/test/check commands if known, else say unknown. Conventions: the hard rules a contributor must follow. Gotchas: traps and non-obvious constraints. ` +
    `Be concrete and specific to this repository; no filler, no preamble. Everything you need is below; do not ask for or refer to other files.`;
  const material = `\n\n${heads.join("\n\n")}\n\n=== FILE INDEX ===\n${index}`;
  const usage = emptyUsage();
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const strict = attempt === 1 ? ` Your previous answer was rejected: ${problems.join("; ")}. Return the full brief again, fixing exactly that, with each of the five headings as its own "## " line.` : "";
    const req: LaneRequest = { lane: "digest", prompt: base + strict + material, cwd: root, readOnly: true, project: slug, jsonSchema: SUMMARY_SCHEMA };
    const r = await runClaude(req, { model: "sonnet", tools: [] });
    await recordLane(h.ledger, req, r, "anthropic");
    addUsage(usage, r);
    if (!r.ok) throw new Error(`summary failed: ${r.error}`);
    const text = ((r.json as { summary?: unknown } | undefined)?.summary ?? r.text);
    const candidate = typeof text === "string" ? text.trim() : "";
    problems = validateSummary(candidate);
    if (!problems.length) {
      const tokens = approxTokens(candidate);
      await repo.setProjectSummary(h.db, slug, candidate, tokens);
      log(`project summary: ${wordCount(candidate)} words, ${tokens} tokens${attempt ? " (after one retry)" : ""}`);
      return { ...usage, text: candidate, tokens };
    }
    log(`summary attempt ${attempt + 1} rejected: ${problems.join("; ")}`);
  }
  throw new Error(`project summary for ${slug} rejected twice (${problems.join("; ")}); the existing summary was kept. Check \`claude auth status\` and re-run relay link --refresh`);
}
