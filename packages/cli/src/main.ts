import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { openHarness, loadConfig, ensureHome, migrate, seedRegistry, onboardModel, retrieveGuidance, assertOnboarded, NotOnboardedError, repo, discoverFleetMcp, runFx, runClaude, recordLane, registerProject, digestProject, summarizeProject } from "@relay/core";
import { resolve } from "node:path";
import type { FxProvider, ClaudeModel } from "@relay/core";

const log = (m: string) => console.error(`[relay] ${m}`);
const program = new Command().name("relay").description("kyro-harness orchestrator CLI").version("0.0.1");

program
  .command("init")
  .description("Create ~/.harness/config.json if missing, run schema migrations, seed providers and models")
  .action(async () => {
    const cfg = loadConfig();
    ensureHome(cfg);
    if (!existsSync(cfg.configPath)) {
      const d = discoverFleetMcp();
      const template = {
        graph: { name: "harness", transport: "mcp", mcpUrl: d?.url ?? "http://kyles-mac-mini:8765/mcp" },
        gateway: { embeddingModel: cfg.gateway.embeddingModel, embeddingDim: cfg.gateway.embeddingDim },
        staleDays: cfg.staleDays,
      };
      writeFileSync(cfg.configPath, JSON.stringify(template, null, 2) + "\n");
      log(`wrote ${cfg.configPath} (mcp token is read from ~/.claude.json fleet-memory; set AI_GATEWAY_API_KEY for embeddings)`);
    }
    const h = openHarness();
    try {
      const v = await migrate(h.graph, { dim: h.cfg.gateway.embeddingDim, log });
      log(`schema at v${v}`);
      await seedRegistry(h, log);
    } finally {
      await h.close();
    }
  });

program
  .command("onboard")
  .argument("<model>", "model id, e.g. bytedance/seedance-2.5")
  .option("--force", "re-ingest even when sources are unchanged")
  .description("Ingest official docs + provider skills for a model into the graph (the gate every lane requires)")
  .action(async (model: string, o: { force?: boolean }) => {
    const h = openHarness();
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
    const h = openHarness();
    try {
      const rows = await repo.listModels(h.graph);
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
    const h = openHarness();
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
    const h = openHarness();
    try {
      for (const k of await repo.listSkills(h.graph)) console.log(`${k.model.padEnd(28)} ${k.name}@${k.version}  ${k.install_path}`);
    } finally {
      await h.close();
    }
  });

program
  .command("graph")
  .argument("<cypher>")
  .option("--rw", "allow writes (default read-only)")
  .description("Run a Cypher query against the harness graph")
  .action(async (cypher: string, o: { rw?: boolean }) => {
    const h = openHarness();
    try {
      const r = await h.graph.query(cypher, {}, { readOnly: !o.rw });
      console.log(JSON.stringify(r.rows, null, 2));
      for (const s of r.stats) log(s);
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
    const h = openHarness();
    try {
      const prompt = promptWords.length ? promptWords.join(" ") : "Reply with exactly the single word: pong";
      const req = { lane: "probe" as const, prompt, cwd: process.cwd(), readOnly: true, timeoutMs: 180_000 };
      const r = kind === "claude" ? await runClaude(req, { model: model as ClaudeModel }) : await runFx(req, { provider: kind as FxProvider, model });
      recordLane(h.ledger, req, r, kind === "claude" ? "anthropic" : kind);
      console.log(JSON.stringify({ ok: r.ok, model: r.model, subscription: r.subscription, text: r.text.slice(0, 200), tokensIn: r.tokensIn, tokensOut: r.tokensOut, cacheRead: r.cacheRead, costEquiv: r.costEquiv, durationMs: r.durationMs, error: r.error }, null, 2));
      if (!r.ok) process.exitCode = 1;
    } finally {
      await h.close();
    }
  });

const project = program.command("project").description("Register projects and maintain their file digests");
project
  .command("add")
  .argument("<slug>")
  .argument("<path>")
  .option("--stack <text>", "one-line stack note")
  .option("--check <cmd>", "check command (build/test/lint) the task loop runs after each step")
  .description("Register (or refresh) a project and hash its files")
  .action(async (slug: string, path: string, o: { stack?: string; check?: string }) => {
    const h = openHarness();
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
    const h = openHarness();
    try {
      console.log(JSON.stringify(await digestProject(h, slug, { maxFiles: Number(o.max), batchFiles: Number(o.batch), log })));
    } finally {
      await h.close();
    }
  });
project
  .command("summarize")
  .argument("<slug>")
  .description("Write the ≤2K-token Project.summary from README/AGENTS files and the digest index")
  .action(async (slug: string) => {
    const h = openHarness();
    try {
      console.log(await summarizeProject(h, slug, log));
    } finally {
      await h.close();
    }
  });
project
  .command("show")
  .argument("<slug>")
  .description("Project row, digest coverage, and summary")
  .action(async (slug: string) => {
    const h = openHarness();
    try {
      const p = await repo.getProject(h.graph, slug);
      if (!p) throw new Error(`unknown project ${slug}`);
      const files = await repo.listFileDigests(h.graph, slug);
      const stale = files.filter((f) => !f.summary || f.summary_sha !== f.sha256).length;
      console.log(`${p.slug}  ${p.path}\nstack: ${p.stack ?? "-"}  check: ${p.check_cmd ?? "-"}\nfiles: ${files.length} (${stale} need digest)  summary: ${p.summary_tokens ?? 0} tokens`);
      for (const f of files.slice(0, 15)) console.log(`  ${f.path.padEnd(48)} ${f.summary ? f.summary.slice(0, 90) : "(no digest)"}`);
      if (p.summary) console.log("\n" + p.summary);
    } finally {
      await h.close();
    }
  });
project
  .command("list")
  .action(async () => {
    const h = openHarness();
    try {
      for (const p of await repo.listProjects(h.graph)) console.log(`${p.slug.padEnd(20)} ${p.path}  summary=${p.summary_tokens ?? 0}tok`);
    } finally {
      await h.close();
    }
  });

program
  .command("usage")
  .option("--days <n>", "window", "7")
  .description("Ledger summary per subscription")
  .action(async (o: { days: string }) => {
    const h = openHarness();
    try {
      const since = new Date(Date.now() - Number(o.days) * 86_400_000).toISOString();
      console.table(h.ledger.summary(since));
    } finally {
      await h.close();
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
