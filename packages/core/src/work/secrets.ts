/**
 * Where a worker finds the values of a granted capability set (docs/PROFILE.md): its own environment first, then the
 * development environment of the Vercel project the profile names, read with this machine's own `vercel login`.
 * Nothing is copied between machines and nothing is kept: the pull goes to a private scratch directory outside the
 * clone, only the granted names are taken from it, and it is deleted before the lane starts.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "../github/client.ts";
import { envSecrets, type SecretSource } from "./job.ts";

/** `KEY=value` lines as `vercel env pull` writes them: values plain or double-quoted, with `\n` and `\"` escapes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2]!.trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
    const single = /^'([^']*)'/.exec(raw);
    out[m[1]!] = quoted ? quoted[1]!.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\(["\\$])/g, "$1") : single ? single[1]! : raw.replace(/\s+#.*$/, "");
  }
  return out;
}

const vercel = (bin: string, args: string[], cwd: string): Promise<{ code: number; err: string }> =>
  new Promise((res) => {
    const child = execFile(bin, args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, _out, stderr) => res({ code: e ? 1 : 0, err: String(stderr).trim().split("\n").pop() ?? "" }));
    child.stdin?.end();
  });

/**
 * The source `relay work` uses. A name already in the worker's environment wins; the rest come from the Vercel
 * project, when the profile names one and the Vercel CLI is here. A name found nowhere is left out, and the job says
 * which. Throws only with why the project could not be read, so the job can say that too.
 */
export const vercelSecrets = (o: { bin?: string; log?: (line: string) => void } = {}): SecretSource => async (req) => {
  const found = await envSecrets(req);
  const missing = req.names.filter((n) => !(n in found));
  if (!missing.length || !req.vercel) return found;
  // what the worker's own environment already gave stays, whatever happens to the pull
  const gaveUp = (why: string): Record<string, string> => {
    o.log?.(`${missing.join(", ")} not read from the Vercel project ${req.vercel!.project}: ${why}`);
    return found;
  };
  const bin = o.bin ?? findOnPath("vercel");
  if (!bin) return gaveUp("the Vercel CLI is not on this worker");
  const dir = mkdtempSync(join(tmpdir(), "relay-env-"));
  try {
    const scope = req.vercel.team ? ["--scope", req.vercel.team] : [];
    const linked = await vercel(bin, ["link", "--yes", "--project", req.vercel.project, ...scope], dir);
    if (linked.code !== 0) return gaveUp(`vercel link failed: ${linked.err || "no reason given"}`);
    const pulled = await vercel(bin, ["env", "pull", ".env", "--yes", "--environment=development", ...scope], dir);
    const file = join(dir, ".env");
    if (pulled.code !== 0 || !existsSync(file)) return gaveUp(`vercel env pull failed: ${pulled.err || "no reason given"}`);
    const all = parseDotenv(readFileSync(file, "utf8"));
    for (const n of missing) if (typeof all[n] === "string" && all[n] !== "") found[n] = all[n]!;
    return found;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
