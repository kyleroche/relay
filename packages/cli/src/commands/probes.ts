/**
 * Login probes shared by `relay doctor` and `relay work`: which vendor CLIs are on PATH and logged in. Probes print
 * only a derived status, never command output, so no token or account id can leak into a log.
 */
import { execFile } from "node:child_process";
import { onPath } from "./_common.ts";

export type Status = "ok" | "warn" | "fail";
export interface Check {
  status: Status;
  name: string;
  detail: string;
}

export type ProbeTool = "claude" | "codex" | "fx" | "grok" | "gh";
export const PROBE_TOOLS: readonly ProbeTool[] = ["claude", "codex", "fx", "grok", "gh"];

export function run(bin: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout, stderr) =>
      res({ code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** Providers an fx login covers (`connected_providers` in `fx status`), empty when fx is absent or has none. */
export function fxProviders(detail: string): string[] {
  const m = /connected: (.+)$/.exec(detail);
  return m ? m[1]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}

export async function loginCheck(tool: ProbeTool, bin: string): Promise<Check> {
  const name = `login:${tool}`;
  if (tool === "claude") {
    const r = await run(bin, ["auth", "status", "--json"]);
    try {
      const j = JSON.parse(r.stdout.trim()) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
      if (j.loggedIn) return { status: "ok", name, detail: `logged in${j.subscriptionType ? ` (${j.subscriptionType})` : ""}` };
      return { status: "fail", name, detail: "not logged in; run: claude  then /login" };
    } catch {
      return r.code === 0 && /logged in/i.test(r.stdout) && !/not logged in/i.test(r.stdout)
        ? { status: "ok", name, detail: "logged in" }
        : { status: "warn", name, detail: "could not read `claude auth status`; run it yourself" };
    }
  }
  if (tool === "fx") {
    // `fx status` prints `[status] key=value` lines; the ones that matter: connected_providers, auth_expired, auth_refreshable.
    const r = await run(bin, ["status"]);
    const kv = new Map<string, string>();
    for (const m of (r.stdout + "\n" + r.stderr).matchAll(/^\[status\]\s+([a-z_]+)=(.*)$/gim)) kv.set(m[1]!.toLowerCase(), m[2]!.trim());
    if (!kv.size) return { status: "warn", name, detail: "could not read `fx status`; run it yourself" };
    const providers = (kv.get("connected_providers") ?? "").split(",").map((s) => s.trim()).filter((s) => s && !/^none$/i.test(s));
    if (!providers.length) return { status: "fail", name, detail: "no provider login; run: fx login codex | fx login grok" };
    const expired = kv.get("auth_expired") === "true" && kv.get("auth_refreshable") !== "true";
    return expired
      ? { status: "warn", name, detail: `connected: ${providers.join(", ")}; token expired and not refreshable, run: fx login` }
      : { status: "ok", name, detail: `connected: ${providers.join(", ")}` };
  }
  if (tool === "gh") {
    const r = await run(bin, ["auth", "status"]);
    return r.code === 0 ? { status: "ok", name, detail: "logged in" } : { status: "fail", name, detail: "not logged in; run: gh auth login" };
  }
  if (tool === "codex") {
    const r = await run(bin, ["login", "status"]);
    return r.code === 0 && !/not logged in/i.test(r.stdout + r.stderr)
      ? { status: "ok", name, detail: "logged in" }
      : { status: "fail", name, detail: "not logged in; run: codex login" };
  }
  // grok: the CLI has `login` but no status command, so only presence can be verified here.
  return { status: "warn", name, detail: "grok CLI reports no login state; `relay probe grok:<model>` is the real test (run: grok login)" };
}

/** Presence and login checks for every vendor CLI, in doctor's order. */
export async function probeTools(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const tool of PROBE_TOOLS) {
    const bin = onPath(tool);
    if (!bin) {
      checks.push({ status: tool === "gh" || tool === "claude" ? "fail" : "warn", name: `cli:${tool}`, detail: "not on PATH" });
      continue;
    }
    checks.push({ status: "ok", name: `cli:${tool}`, detail: bin });
    checks.push(await loginCheck(tool, bin));
  }
  return checks;
}

/**
 * The lanes this machine can serve, from its logins: `claude` when Claude Code is logged in, `codex` when the codex
 * CLI is logged in or fx has a Codex login, `grok` when the grok CLI is present or fx has a Grok login. `gh` must be
 * logged in for any lane (clones, pushes and PRs run as it).
 */
export function lanesFromChecks(checks: Check[]): { lanes: string[]; reasons: string[] } {
  const by = new Map(checks.map((c) => [c.name, c]));
  const reasons: string[] = [];
  const lanes: string[] = [];
  if (by.get("login:gh")?.status !== "ok") {
    reasons.push("gh is not logged in (run: gh auth login); no lane can push without it");
    return { lanes, reasons };
  }
  const fx = fxProviders(by.get("login:fx")?.detail ?? "");
  if (by.get("login:claude")?.status === "ok") lanes.push("claude");
  else reasons.push("claude: not logged in");
  if (by.get("login:codex")?.status === "ok" || fx.includes("codex")) lanes.push("codex");
  else reasons.push("codex: no codex or fx login");
  if (by.get("cli:grok")?.status === "ok" || fx.includes("grok")) lanes.push("grok");
  else reasons.push("grok: no grok CLI or fx login");
  return { lanes, reasons };
}

export const detectLanes = async (): Promise<{ lanes: string[]; reasons: string[] }> => lanesFromChecks(await probeTools());
