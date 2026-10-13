import { Command } from "commander";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import {
  openHarness, loadConfig, ensureHome, openDb, migrate, currentVersion, seedRegistry, onboardModel, retrieveGuidance, assertOnboarded, NotOnboardedError, repo,
  runFx, runClaude, recordLane, registerProject, digestProject, summarizeProject,
} from "@relay/core";
import type { FxProvider, ClaudeModel, FileConfig } from "@relay/core";
import { registerAssetCommands } from "./commands/assets.ts";
import { registerSetup } from "./commands/setup.ts";
import { registerLink } from "./commands/link.ts";
import { registerBrief } from "./commands/brief.ts";
import { registerRecall } from "./commands/recall.ts";
import { registerDecide } from "./commands/decide.ts";
import { registerPrefer } from "./commands/prefer.ts";
import { registerCapture } from "./commands/capture.ts";
import { registerMemory } from "./commands/memory.ts";
import { registerToken } from "./commands/token.ts";

const log = (m: string) => console.error(`[relay] ${m}`);
const program = new Command().name("relay").description("relay: your coding-agent subscriptions as one system").version("0.0.1");
registerAssetCommands(program);
registerToken(program);

// ---------- memory layer: setup, link, brief, recall, decide, prefer, capture, memory (packages/cli/src/commands) ----------
for (const register of [registerSetup, registerLink, registerBrief, registerRecall, registerDecide, registerPrefer, registerCapture, registerMemory]) register(program);

program
  .command("init")
  .description("Create ~/.harness/config.json if missing, run schema migrations, seed providers and models")
  .action(async () => {
    const cfg = loadConfig();
    ensureHome(cfg);
    if (!existsSync(cfg.configPath)) {
      const template: FileConfig = { staleDays: cfg.staleDays, gateway: { embeddingModel: cfg.gateway.embeddingModel, embeddingDim: cfg.gateway.embeddingDim } };
      writeFileSync(cfg.configPath, JSON.stringify(template, null, 2) + "\n");
      log(`wrote ${cfg.configPath} (set DATABASE_URL for Postgres, AI_GATEWAY_API_KEY for embeddings; neither is stored in a file)`);
    }
    const h = await openHarness(cfg);
    try {
      log(`database: ${h.db.driver}${h.db.driver === "pglite" ? ` at ${cfg.dbFile}` : " via DATABASE_URL"}`);
      const v = await migrate(h.db, { log });
      log(`schema at v${v}`);
      await seedRegistry(h, log);
    } finally {
      await h.close();
    }
  });

// ---------- doctor ----------

type Status = "ok" | "warn" | "fail";
interface Check {
  status: Status;
  name: string;
  detail: string;
}

function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function run(bin: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout, stderr) =>
      res({ code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** Login probes print only a derived status, never command output, so no token or account id can leak. */
async function loginCheck(tool: "claude" | "codex" | "fx" | "grok" | "gh", bin: string): Promise<Check> {
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

program
  .command("doctor")
  .description("Report Node version, which CLIs are installed and logged in, and whether the database is reachable")
  .action(async () => {
    const checks: Check[] = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ status: major >= 24 ? "ok" : "fail", name: "node", detail: `v${process.versions.node}${major >= 24 ? "" : " (need 24+)"}` });

    for (const tool of ["claude", "codex", "fx", "grok", "gh"] as const) {
      const bin = onPath(tool);
      if (!bin) {
        checks.push({ status: tool === "gh" || tool === "claude" ? "fail" : "warn", name: `cli:${tool}`, detail: "not on PATH" });
        continue;
      }
      checks.push({ status: "ok", name: `cli:${tool}`, detail: bin });
      checks.push(await loginCheck(tool, bin));
    }

    const cfg = loadConfig();
    const t0 = Date.now();
    try {
      const db = await openDb(cfg.databaseUrl ? { url: cfg.databaseUrl } : { file: cfg.dbFile });
      try {
        await db.query("SELECT 1");
        const v = await currentVersion(db);
        const where = db.driver === "pg" ? "postgres via DATABASE_URL" : `pglite at ${cfg.dbFile}`;
        checks.push({ status: v > 0 ? "ok" : "warn", name: "database", detail: `${where}, schema v${v}${v > 0 ? "" : " (run: relay init)"}, ${Date.now() - t0} ms` });
      } finally {
        await db.close();
      }
    } catch (e) {
      checks.push({ status: "fail", name: "database", detail: `unreachable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
    }
    checks.push({ status: cfg.gateway.apiKey ? "ok" : "warn", name: "gateway", detail: cfg.gateway.apiKey ? "AI_GATEWAY_API_KEY set (embeddings on)" : "AI_GATEWAY_API_KEY unset; retrieval uses full-text only" });

    for (const c of checks) console.log(`${c.status.padEnd(5)} ${c.name.padEnd(13)} ${c.detail}`);
    if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
  });

// ---------- onboarding ----------

program
  .command("onboard")
  .argument("<model>", "model id, e.g. bytedance/seedance-2.5")
  .option("--force", "re-ingest even when sources are unchanged")
  .description("Ingest official docs + provider skills for a model (the gate every lane requires)")
  .action(async (model: string, o: { force?: boolean }) => {
    const h = await openHarness();
    try {
      const r = await onboardModel(h, model, { force: !!o.force, log });
      console.log(JSON.stringify(r, null, 2));
    } finally {
      await h.close();
    }
  });

program
  .command("models")
  .description("List models and onboarding status")
  .action(async () => {
    const h = await openHarness();
    try {
      const rows = await repo.listModels(h.db);
      for (const m of rows) {
        let gate = "ok";
        try {
          await assertOnboarded(h, m.id);
        } catch (e) {
          gate = e instanceof NotOnboardedError ? e.reason : "error";
        }
        console.log(`${m.id.padEnd(30)} ${gate.padEnd(8)} guidance=${m.guidance_count ?? 0} skills=${m.skill_count ?? 0} onboarded=${m.onboarded_at ?? "-"}`);
      }
    } finally {
      await h.close();
    }
  });

program
  .command("search")
  .argument("<model>")
  .argument("<query...>")
  .option("-k <n>", "hits", "6")
  .description("Retrieve guidance for a model the way the context builder will")
  .action(async (model: string, q: string[], o: { k: string }) => {
    const h = await openHarness();
    try {
      const hits = await retrieveGuidance(h, model, q.join(" "), { k: Number(o.k) });
      for (const x of hits) console.log(`\n[${x.kind}] ${x.title} (${x.tokens} tok, score ${Number(x.score).toFixed(3)})\n${x.source_url}\n${x.text.slice(0, 500)}${x.text.length > 500 ? "…" : ""}`);
      console.log(`\n${hits.length} hits, ${hits.reduce((a, b) => a + b.tokens, 0)} tokens`);
    } finally {
      await h.close();
    }
  });

program
  .command("skills")
  .description("List installed provider skills")
  .action(async () => {
    const h = await openHarness();
    try {
      for (const k of await repo.listSkills(h.db)) console.log(`${k.model.padEnd(28)} ${k.name}@${k.version}  ${k.install_path}`);
    } finally {
      await h.close();
    }
  });

program
  .command("sql")
  .argument("<query>")
  .option("--rw", "allow writes (default: read-only transaction)")
  .description("Run a SQL query against the relay database")
  .action(async (sql: string, o: { rw?: boolean }) => {
    const h = await openHarness();
    try {
      const rows = o.rw
        ? await h.db.query(sql)
        : await h.db.transaction(async (tx) => {
            await tx.exec("SET TRANSACTION READ ONLY");
            return tx.query(sql);
          });
      console.log(JSON.stringify(rows, null, 2));
      log(`${rows.length} rows`);
    } finally {
      await h.close();
    }
  });

program
  .command("probe")
  .argument("<target>", "codex:<model> | grok:<model> | gateway:<model> | claude:<fable|opus|sonnet>")
  .argument("[prompt...]")
  .description("Run one lane call with a tiny prompt and record it in the ledger (smoke test for logins and usage parsing)")
  .action(async (target: string, promptWords: string[]) => {
    const [kind, model] = target.split(":") as [string, string | undefined];
    if (!model) throw new Error("target must be provider:model");
    const h = await openHarness();
    try {
      const prompt = promptWords.length ? promptWords.join(" ") : "Reply with exactly the single word: pong";
      const req = { lane: "probe" as const, prompt, cwd: process.cwd(), readOnly: true, timeoutMs: 180_000 };
      const r = kind === "claude" ? await runClaude(req, { model: model as ClaudeModel }) : await runFx(req, { provider: kind as FxProvider, model });
      await recordLane(h.ledger, req, r, kind === "claude" ? "anthropic" : kind);
      console.log(JSON.stringify({ ok: r.ok, model: r.model, subscription: r.subscription, text: r.text.slice(0, 200), tokensIn: r.tokensIn, tokensOut: r.tokensOut, cacheRead: r.cacheRead, costEquiv: r.costEquiv, durationMs: r.durationMs, error: r.error }, null, 2));
      if (!r.ok) process.exitCode = 1;
    } finally {
      await h.close();
    }
  });

// ---------- projects ----------

const project = program.command("project").description("Register projects and maintain their file digests");
project
  .command("add")
  .argument("<slug>")
  .argument("<path>")
  .option("--stack <text>", "one-line stack note")
  .option("--check <cmd>", "check command (build/test/lint) the task loop runs after each step")
  .description("Register (or refresh) a project and hash its files")
  .action(async (slug: string, path: string, o: { stack?: string; check?: string }) => {
    const h = await openHarness();
    try {
      const args: { slug: string; path: string; stack?: string; checkCmd?: string } = { slug, path: resolve(path) };
      if (o.stack) args.stack = o.stack;
      if (o.check) args.checkCmd = o.check;
      console.log(JSON.stringify(await registerProject(h, args, log)));
    } finally {
      await h.close();
    }
  });
project
  .command("digest")
  .argument("<slug>")
  .option("--max <n>", "max files this run", "400")
  .option("--batch <n>", "files per Sonnet call", "8")
  .description("Summarize files whose content hash changed since their last digest (Sonnet, no tools)")
  .action(async (slug: string, o: { max: string; batch: string }) => {
    const h = await openHarness();
    try {
      console.log(JSON.stringify(await digestProject(h, slug, { maxFiles: Number(o.max), batchFiles: Number(o.batch), log })));
    } finally {
      await h.close();
    }
  });
project
  .command("summarize")
  .argument("<slug>")
  .description("Write the ≤500-word project summary from README/AGENTS files and the digest index (relay link does this for you)")
  .action(async (slug: string) => {
    const h = await openHarness();
    try {
      console.log((await summarizeProject(h, slug, log)).text);
    } finally {
      await h.close();
    }
  });
project
  .command("show")
  .argument("<slug>")
  .description("Project row, digest coverage, and summary")
  .action(async (slug: string) => {
    const h = await openHarness();
    try {
      const p = await repo.getProject(h.db, slug);
      if (!p) throw new Error(`unknown project ${slug}`);
      const files = await repo.listFileDigests(h.db, slug);
      const stale = files.filter((f) => !f.summary || f.summary_sha !== f.sha256).length;
      console.log(`${p.slug}  ${p.path ?? "-"}\nstack: ${p.stack ?? "-"}  check: ${p.check_cmd ?? "-"}\nfiles: ${files.length} (${stale} need digest)  summary: ${p.summary_tokens ?? 0} tokens`);
      for (const f of files.slice(0, 15)) console.log(`  ${f.path.padEnd(48)} ${f.summary ? f.summary.slice(0, 90) : "(no digest)"}`);
      if (p.summary) console.log("\n" + p.summary);
    } finally {
      await h.close();
    }
  });
project
  .command("list")
  .action(async () => {
    const h = await openHarness();
    try {
      for (const p of await repo.listProjects(h.db)) console.log(`${p.slug.padEnd(20)} ${p.path ?? "-"}  summary=${p.summary_tokens ?? 0}tok`);
    } finally {
      await h.close();
    }
  });

// ---------- feed & usage ----------

program
  .command("feed")
  .option("--project <slug>")
  .option("--kind <kind>", "exact kind, or a prefix ending in '.' such as 'step.'")
  .option("--actor <actor>")
  .option("--days <n>", "window", "7")
  .option("-n <n>", "rows", "50")
  .description("Recent events, newest first")
  .action(async (o: { project?: string; kind?: string; actor?: string; days: string; n: string }) => {
    const h = await openHarness();
    try {
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      const opts: Parameters<typeof repo.listEvents>[1] = { since, limit: Number(o.n) };
      if (o.project) opts.project = o.project;
      if (o.kind) opts.kind = o.kind;
      if (o.actor) opts.actor = o.actor;
      for (const e of await repo.listEvents(h.db, opts)) {
        const usage = e.kind === "step.usage" ? `  ${e.tokens_in + e.cache_read} in / ${e.tokens_out} out  $${e.cost_equiv.toFixed(4)}` : "";
        console.log(`${e.ts}  ${e.kind.padEnd(18)} ${e.actor.padEnd(18)} ${(e.project ?? "-").padEnd(14)} ${e.summary.slice(0, 80)}${usage}`);
      }
    } finally {
      await h.close();
    }
  });

program
  .command("usage")
  .option("--days <n>", "window", "7")
  .description("Ledger summary per subscription (step.usage events)")
  .action(async (o: { days: string }) => {
    const h = await openHarness();
    try {
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      console.table(await h.ledger.summary(since));
    } finally {
      await h.close();
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
