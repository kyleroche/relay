import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
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
import { registerInvite } from "./commands/invite.ts";
import { registerTask } from "./commands/task.ts";
import { registerWebhook } from "./commands/webhook.ts";
import { registerWork } from "./commands/work.ts";
import { registerLane } from "./commands/lane.ts";
import { openReady } from "./commands/_common.ts";
import { containerCheck, containerReport, inContainer, lanesFromChecks, probeTools, sandboxCheck, type Check } from "./commands/probes.ts";
import { projectsEventsReport } from "./commands/events-check.ts";

const log = (m: string) => console.error(`[relay] ${m}`);
// ../package.json is packages/cli/package.json from src/ and the package root from the bundled dist/relay.js.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
// positional options: an option after a subcommand belongs to that subcommand (`relay work container rm --yes` is rm's
// --yes, not work's); the root has only --version and --help, which nobody puts after a command
const program = new Command().name("relay").description("relay: your coding-agent subscriptions as one system").version(version).enablePositionalOptions();
registerAssetCommands(program);
registerToken(program);
registerInvite(program);
registerTask(program);
registerWebhook(program);
registerWork(program, version);
registerLane(program);

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
    const h = await openHarness(cfg, { local: true });
    try {
      log(`database: ${h.db.driver}${h.db.driver === "pglite" ? ` at ${cfg.dbFile}` : " via DATABASE_URL"}`);
      if (cfg.site) log(`site mode: commands talk to ${cfg.site}; this local database serves relay link's digest cache and the stdio MCP server`);
      const v = await migrate(h.db, { log });
      log(`schema at v${v}`);
      await seedRegistry(h, log);
    } finally {
      await h.close();
    }
  });

// ---------- doctor (login probes live in commands/probes.ts, shared with `relay work`) ----------

program
  .command("doctor")
  .description("Report Node version, which CLIs are installed and logged in, the lanes this machine can serve, whether Claude's OS sandbox is available, the container worker tier (macOS), whether the database or site is reachable, how this machine authenticates, and (site mode) which linked repos still lack the GitHub App")
  .action(async () => {
    const checks: Check[] = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ status: major >= 24 ? "ok" : "fail", name: "node", detail: `v${process.versions.node}${major >= 24 ? "" : " (need 24+)"}` });

    const tools = await probeTools();
    checks.push(...tools);
    const lanes = lanesFromChecks(tools);
    checks.push({ status: lanes.lanes.length ? "ok" : "warn", name: "lanes", detail: lanes.lanes.length ? `${lanes.lanes.join(", ")} (relay work would serve these)${lanes.reasons.length ? `; not: ${lanes.reasons.join("; ")}` : ""}` : `none: ${lanes.reasons.join("; ")}` });
    checks.push(await sandboxCheck());
    // the container tier (docs/WORKERS.md, "Isolation"): on a Mac, is Apple's container CLI here and is relay-work up
    if (process.platform === "darwin" && !inContainer()) checks.push(containerCheck(await containerReport()));

    const cfg = loadConfig();
    const siteMode = !!cfg.site && !!cfg.siteToken;
    if (cfg.site && !cfg.siteToken) checks.push({ status: "fail", name: "mode", detail: `site ${cfg.site} is configured without a token; run: relay setup --site ${cfg.site}` });
    else checks.push({ status: "ok", name: "mode", detail: siteMode ? `site: ${cfg.site} (memory, feed, token, invite, task and webhook commands and the hooks use it)` : "local: the database on this machine" });
    if (siteMode) {
      const t0 = Date.now();
      // Where the credential came from, never the credential: device flow, invite, pasted token, or RELAY_TOKEN.
      const sourceLabel = { device: "approved on /activate (device flow)", invite: "redeemed an invite", manual: "pasted with --token", env: "RELAY_TOKEN in the environment" }[cfg.siteTokenSource ?? "manual"];
      const renews = cfg.siteRefreshToken ? "; renews itself with a refresh token" : cfg.siteTokenExpiresAt ? "; no refresh token, re-run relay setup when it expires" : "";
      checks.push({ status: "ok", name: "auth", detail: `${sourceLabel}${cfg.siteTokenName ? ` as ${cfg.siteTokenName}` : ""}${cfg.siteTokenExpiresAt ? `, expires ${cfg.siteTokenExpiresAt}` : ", no expiry"}${renews}` });
      try {
        const h = await openReady();
        try {
          const health = await h.client.health();
          checks.push({ status: health.ok ? "ok" : "fail", name: "site", detail: `${health.detail}, ${Date.now() - t0} ms` });
          if (health.ok) {
            const who = await h.client.whoami().catch(() => undefined);
            if (who) checks.push({ status: "ok", name: "whoami", detail: `${who.name} (${who.source}): ${who.scopes.join(", ")}${who.expires_at ? `; expires ${who.expires_at}` : ""}` });
            // linked repos the site's GitHub App is not installed on get no issues, labels, PRs or previews
            try {
              const report = await projectsEventsReport(h.client, cfg.site!);
              checks.push(...report.checks);
            } catch (e) {
              checks.push({ status: "warn", name: "events", detail: `could not check the GitHub App per project: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` });
            }
          }
        } finally {
          await h.close();
        }
      } catch (e) {
        checks.push({ status: "fail", name: "site", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
    }
    const t0 = Date.now();
    try {
      const db = await openDb(cfg.databaseUrl ? { url: cfg.databaseUrl } : { file: cfg.dbFile });
      try {
        await db.query("SELECT 1");
        const v = await currentVersion(db);
        const where = db.driver === "pg" ? "postgres via DATABASE_URL" : `pglite at ${cfg.dbFile}`;
        checks.push({ status: v > 0 ? "ok" : siteMode ? "ok" : "warn", name: "database", detail: `${where}, schema v${v}${v > 0 || siteMode ? "" : " (run: relay init)"}, ${Date.now() - t0} ms${siteMode ? " (digest cache and stdio MCP only)" : ""}` });
      } finally {
        await db.close();
      }
    } catch (e) {
      checks.push({ status: siteMode ? "warn" : "fail", name: "database", detail: `unreachable: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
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
  .description("Recent events, newest first (from the site in site mode)")
  .action(async (o: { project?: string; kind?: string; actor?: string; days: string; n: string }) => {
    const h = await openReady();
    try {
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      const opts: Parameters<typeof repo.listEvents>[1] = { since, limit: Number(o.n) };
      if (o.project) opts.project = o.project;
      if (o.kind) opts.kind = o.kind;
      if (o.actor) opts.actor = o.actor;
      for (const e of await h.client.listEvents(opts)) {
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
  .description("Ledger summary per subscription (step.usage events; from the site in site mode)")
  .action(async (o: { days: string }) => {
    const h = await openReady();
    try {
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      console.table(await h.client.usageSummary(since));
    } finally {
      await h.close();
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
