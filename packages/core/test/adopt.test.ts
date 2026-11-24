/**
 * Adoption over an in-memory file system: no home directory, no git, no model. Every name and note here is invented.
 */
import { describe, expect, it } from "vitest";
import {
  applyAdoption, bashCallsOf, checkoutOf, claudeProjectDirName, commandKey, commandKeys, contextFile, decisionText, draftProfile, eachLine, findClaudeProjects, findSecrets, lineDiff, mineCommands,
  parseMemoryFile, planAdoption, reachOf, renderAdoptPlan, scriptAbout, shellSegments, workflowCommands, type AdoptFs, type AdoptState,
} from "../src/adopt/index.ts";
import { readProfile } from "../src/steps/profile.ts";

const ROOT = "/Users/sam/dev/shop";
const PROJECTS = "/Users/sam/.claude/projects";
const DIR = `${PROJECTS}/-Users-sam-dev-shop`;
const WT = `${PROJECTS}/-Users-sam-dev-shop--claude-worktrees-fix-rates`;

/** A file system that is a map of paths to text. `reads` counts whole-file reads, so a test can show a transcript was only streamed. */
function memFs(files: Record<string, string>, chunk = 37): AdoptFs & { reads: string[]; files: Record<string, string> } {
  const reads: string[] = [];
  const under = (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`));
  return {
    files,
    reads,
    list: (dir) => [...new Set(under(dir).map((p) => p.slice(dir.length + 1).split("/")[0]!))].sort(),
    read: (path) => (reads.push(path), files[path]),
    size: (path) => (files[path] === undefined ? undefined : Buffer.byteLength(files[path]!)),
    isDir: (path) => under(path).length > 0,
    async *chunks(path) {
      const b = Buffer.from(files[path] ?? "");
      for (let i = 0; i < b.length; i += chunk) yield b.subarray(i, i + chunk);
    },
  };
}

const note = (type: string, description: string, body: string, extra = ""): string => `---\nname: x\ndescription: ${description}\nmetadata:\n  node_type: memory\n  type: ${type}\n${extra}---\n\n${body}\n`;
const bash = (cwd: string, command: string): string => JSON.stringify({ type: "assistant", cwd, message: { role: "assistant", content: [{ type: "text", text: "running" }, { type: "tool_use", name: "Bash", input: { command, description: "d" } }] } });
const other = (text: string): string => JSON.stringify({ type: "user", cwd: ROOT, message: { role: "user", content: text } });

function shop(): Record<string, string> {
  const transcript = [
    other("please sync the rates"),
    ...Array.from({ length: 5 }, () => bash(ROOT, "node scripts/sync-rates.mjs --store main --order 4411")),
    ...Array.from({ length: 3 }, () => bash(ROOT, "cd scripts && node audit.mjs | tail -5")),
    ...Array.from({ length: 4 }, () => bash(ROOT, "npm run lint && npm test 2>&1 | tail -20")),
    bash(ROOT, "node -e \"console.log(1)\""),
    bash("/Users/sam/dev/elsewhere", "node scripts/sync-rates.mjs"),
    bash(ROOT, "cd /Users/sam/dev/elsewhere && npm run deploy"),
    bash(ROOT, "node scripts/gone.mjs"),
    bash(ROOT, "node scripts/gone.mjs"),
    // a tool result that quotes a Bash call is text, not a call
    other('the log said {\\"name\\":\\"Bash\\"} and "name":"Bash" once'),
    "x".repeat(5000),
  ].join("\n");
  return {
    [`${DIR}/a1.jsonl`]: transcript,
    [`${DIR}/a1/subagents/agent-1.jsonl`]: [bash(ROOT, "node scripts/sync-rates.mjs"), bash(`${ROOT}/.claude/worktrees/fix-rates`, "npx tsc --noEmit -p tsconfig.json")].join("\n"),
    [`${WT}/b2.jsonl`]: [bash(`${ROOT}/.claude/worktrees/fix-rates`, "npx tsc --noEmit"), bash(`${ROOT}/.claude/worktrees/fix-rates`, "npm run lint")].join("\n"),
    [`${DIR}/memory/MEMORY.md`]: "# Memory Index\n\n- [Shipping rates come from the carrier table](shipping-rates.md) — where rates live\n- [Carrier API reference](carrier-api.md) — endpoints\n",
    [`${DIR}/memory/shipping-rates.md`]: note("project", '"Rates are read from the carrier table, never hard-coded: the \\"zone\\" column decides"', "The carrier table is the source.\n\n**Why:** a hard-coded rate went stale in March."),
    [`${DIR}/memory/carrier-api.md`]: note("reference", "Endpoints of the carrier API the sync script calls", "POST /v2/rates returns one row per zone."),
    [`${DIR}/memory/no-force-push.md`]: note("feedback", "Never force-push the release branch", "Do not force-push `release`.\n\n**Why:** the deploy hook reads its history and a rewrite re-ran a migration.\n\n**How to apply:** open a revert instead."),
    [`${DIR}/memory/who.md`]: note("user", "Sam reviews every pull request on a phone, so keep diffs small", "Sam reads diffs on a phone."),
    [`${DIR}/memory/leaky.md`]: note("project", "How the carrier login works", "Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the mirror."),
    [`${DIR}/memory/untyped.md`]: "---\nname: untyped\ndescription: no type here\n---\n\nSomething.\n",
    [`${ROOT}/package.json`]: JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }),
    [`${ROOT}/package-lock.json`]: "{}",
    [`${ROOT}/scripts/sync-rates.mjs`]: '#!/usr/bin/env node\n/**\n * Pull the carrier\'s rate table into the shop.\n *\n * Run nightly.\n */\nimport { client } from "./lib/carrier.mjs";\nconst { SHOP_DOMAIN, DRY_RUN } = process.env;\nawait client(process.env.NODE_ENV);\n',
    [`${ROOT}/scripts/lib/carrier.mjs`]: 'export const client = () => fetch("https://api.carrier.example/v2/rates", { headers: { authorization: process.env.CARRIER_API_KEY, x: process.env["CARRIER_ACCOUNT"], y: process.env.GITHUB_TOKEN } });\n// docs: https://docs.carrier.example/rates\n',
    [`${ROOT}/scripts/audit.mjs`]: "// Count the orders whose rate differs from the table.\nconsole.log(1);\n",
  };
}

describe("where Claude Code keeps a project", () => {
  it("names a directory after the path with everything but letters and digits turned into dashes", () => {
    expect(claudeProjectDirName("/Users/sam/dev/shop")).toBe("-Users-sam-dev-shop");
    expect(claudeProjectDirName("/Users/sam/.harness/work/53b65c9c")).toBe("-Users-sam--harness-work-53b65c9c");
    expect(claudeProjectDirName("/Users/sam/Claude Projects/Rate Tool")).toBe("-Users-sam-Claude-Projects-Rate-Tool");
  });

  it("finds the repository's directory and its worktrees, and not a neighbour whose name only starts the same", () => {
    const fs = memFs({ ...shop(), [`${PROJECTS}/-Users-sam-dev-shop-admin/c.jsonl`]: "{}", [`${PROJECTS}/-Users-sam-dev-shop-admin/memory/x.md`]: "x" });
    const dirs = findClaudeProjects(fs, PROJECTS, [ROOT]);
    expect(dirs.map((d) => [d.name, d.kind])).toEqual([["-Users-sam-dev-shop", "repo"], ["-Users-sam-dev-shop--claude-worktrees-fix-rates", "worktree"]]);
    expect(dirs[0]!.transcripts.map((t) => [t.path.slice(DIR.length + 1), t.subagent])).toEqual([["a1.jsonl", false], ["a1/subagents/agent-1.jsonl", true]]);
    expect(dirs[0]!.memory.map((p) => p.split("/").pop())).not.toContain("MEMORY.md");
    expect(dirs[0]!.memory).toHaveLength(6);
  });
});

describe("a memory note", () => {
  it("is read with its type from the nested metadata, or from the top level of an older file", () => {
    const n = parseMemoryFile("shipping-rates.md", shop()[`${DIR}/memory/shipping-rates.md`]!);
    expect(n).toMatchObject({ slug: "shipping-rates", type: "project", description: 'Rates are read from the carrier table, never hard-coded: the "zone" column decides' });
    expect(parseMemoryFile("old.md", "---\nname: old\ndescription: d\ntype: reference\n---\nbody")).toMatchObject({ type: "reference", body: "body" });
    expect(parseMemoryFile("x.md", "no frontmatter")).toEqual({ problem: "no frontmatter" });
    expect(parseMemoryFile("x.md", "---\nname: x\n---\nbody")).toEqual({ problem: "no type in its frontmatter" });
  });

  it("of type feedback becomes a decision of a sentence or two: the rule and why", () => {
    const n = parseMemoryFile("no-force-push.md", shop()[`${DIR}/memory/no-force-push.md`]!);
    if ("problem" in n) throw new Error(n.problem);
    expect(decisionText(n)).toBe("Never force-push the release branch. Why: the deploy hook reads its history and a rewrite re-ran a migration.");
  });
});

describe("the secret check", () => {
  it("names the kind of secret and never the secret", () => {
    expect(findSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual(["GitHub token"]);
    expect(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toEqual(["private key"]);
    expect(findSecrets("postgres://app:hunter2secret@db.internal.example:5432/shop")).toEqual(["credentials in a URL"]);
    expect(findSecrets('API_KEY = "k3yv4lu3k3yv4lu3k3yv4lu3"')).toEqual(["assigned secret"]);
  });

  it("lets through the names of variables, placeholders and plain prose about tokens", () => {
    expect(findSecrets("Set CARRIER_API_KEY in the environment; the token is read from process.env.CARRIER_API_KEY.")).toEqual([]);
    expect(findSecrets("api_key=YOUR_API_KEY_GOES_HERE_PLEASE and password: <ask the owner>")).toEqual([]);
    expect(findSecrets("See https://docs.carrier.example/auth for how tokens rotate.")).toEqual([]);
  });
});

describe("reading a transcript", () => {
  it("goes line by line and drops a line that is too long without holding it", async () => {
    const seen: string[] = [];
    const text = `one\n${"y".repeat(500)}\ntwo\n\nthree`;
    const r = await eachLine(memFs({ "/t": text }, 7).chunks("/t"), (l) => seen.push(l.toString()), 100);
    expect(seen).toEqual(["one", "two", "three"]);
    expect(r).toEqual({ lines: 5, skipped: 1 });
  });

  it("takes a Bash call from an assistant line and nothing from any other line", () => {
    expect(bashCallsOf(Buffer.from(bash(ROOT, "npm test")))).toEqual({ cwd: ROOT, commands: ["npm test"] });
    expect(bashCallsOf(Buffer.from(other('"name":"Bash"')))).toBeUndefined();
    expect(bashCallsOf(Buffer.from('{"type":"assistant","name":"Bash" broken'))).toBeUndefined();
  });

  it("cuts a command into its segments and reduces each to what names it, arguments dropped", () => {
    expect(shellSegments('cd a && npm run build 2>&1 | tail -5; echo "x && y" || true')).toEqual(["cd a", "npm run build 2>&1", "tail -5", 'echo "x && y"', "true"]);
    expect(commandKey("node scripts/sync-rates.mjs --store main --order 4411")).toBe("node scripts/sync-rates.mjs");
    expect(commandKey("FOO=1 node ./scripts/a.mjs")).toBe("node scripts/a.mjs");
    expect(commandKey("node --env-file .env.local scripts/a.mjs")).toBe("node scripts/a.mjs");
    expect(commandKey("node -e 'x'")).toBeUndefined();
    expect(commandKey("node /abs/path.mjs")).toBeUndefined();
    expect(commandKey("node ../outside.mjs")).toBeUndefined();
    expect(commandKey("npm run lint -- --fix src/secret-customer.ts")).toBe("npm run lint");
    expect(commandKey("corepack pnpm -r typecheck")).toBe("pnpm -r typecheck");
    expect(commandKey("pnpm --filter @shop/web test -- -t 'order 4411'")).toBe("pnpm --filter @shop/web test");
    expect(commandKey("pnpm dlx something")).toBeUndefined();
    expect(commandKey("npx -y vitest run --reporter dot")).toBe("npx vitest run --reporter");
    expect(commandKey("npx tsc --noEmit -p tsconfig.json")).toBe("npx tsc --noEmit");
    expect(commandKey("npx tsx scripts/seed.ts --email sam@example.com")).toBe("npx tsx scripts/seed.ts");
    expect(commandKey("git status")).toBeUndefined();
  });

  it("counts a command as it would be typed from the checkout's root, and stops at a cd that leaves it", () => {
    expect(checkoutOf(`${ROOT}/.claude/worktrees/fix-rates/src`, [ROOT])).toBe(`${ROOT}/.claude/worktrees/fix-rates`);
    expect(checkoutOf("/Users/sam/dev/shop-admin", [ROOT])).toBeUndefined();
    expect(commandKeys("cd scripts && node audit.mjs", ROOT, [ROOT])).toEqual(["node scripts/audit.mjs"]);
    expect(commandKeys("cd packages/web && npm run build", ROOT, [ROOT])).toEqual([]);
    expect(commandKeys("npm run lint; cd /tmp && npm run deploy", ROOT, [ROOT])).toEqual(["npm run lint"]);
    expect(commandKeys("(cd scripts && node audit.mjs)", `${ROOT}/.claude/worktrees/w`, [ROOT])).toEqual(["node scripts/audit.mjs"]);
    expect(commandKeys("npm test", "/Users/sam/dev/elsewhere", [ROOT])).toEqual([]);
  });

  it("counts what was run from the repository and its worktrees, per transcript", async () => {
    const fs = memFs(shop());
    const dirs = findClaudeProjects(fs, PROJECTS, [ROOT]);
    fs.reads.length = 0;
    const mine = await mineCommands(fs, dirs.flatMap((d) => d.transcripts.map((t) => t.path)), [ROOT]);
    expect(fs.reads).toEqual([]); // streamed, never read whole
    expect(Object.fromEntries(mine.counts.map((c) => [c.command, [c.count, c.sessions]]))).toEqual({
      "node scripts/sync-rates.mjs": [6, 2],
      "npm run lint": [5, 2],
      "npm test": [4, 1],
      "node scripts/audit.mjs": [3, 1],
      "node scripts/gone.mjs": [2, 1],
      "npx tsc --noEmit": [2, 2],
    });
    expect(mine.transcripts).toBe(3);
  });
});

describe("the profile draft", () => {
  it("reads a workflow's run keys, single lines and blocks", () => {
    const yaml = "on: [push]\njobs:\n  ci:\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - name: checks\n        run: |\n          npm run lint\n          # a comment\n          npm test -- \\\n            --coverage\n      - run: 'npx tsc --noEmit'\n";
    expect(workflowCommands(yaml)).toEqual(["npm ci", "npm run lint", "npm test -- --coverage", "npx tsc --noEmit"]);
  });

  it("takes a script's first words about itself, and the names it reads and hosts it calls", () => {
    const files = shop();
    expect(scriptAbout(files[`${ROOT}/scripts/sync-rates.mjs`]!)).toBe("Pull the carrier's rate table into the shop.");
    expect(scriptAbout(files[`${ROOT}/scripts/audit.mjs`]!)).toBe("Count the orders whose rate differs from the table.");
    expect(reachOf(files[`${ROOT}/scripts/lib/carrier.mjs`]!)).toEqual({ env: ["CARRIER_ACCOUNT", "CARRIER_API_KEY", "GITHUB_TOKEN"], hosts: ["api.carrier.example"] });
  });

  it("proposes setup, verify, tools and sets in the format readProfile reads, with names and never a value", async () => {
    const fs = memFs(shop());
    const mine = await mineCommands(fs, [`${DIR}/a1.jsonl`, `${DIR}/a1/subagents/agent-1.jsonl`, `${WT}/b2.jsonl`], [ROOT]);
    const d = draftProfile({ fs, root: ROOT, counts: mine.counts });
    expect(d.problems).toEqual([]);
    expect(JSON.parse(d.json)).toEqual({
      setup: ["npm ci"],
      verify: ["npm run lint", "npm test", "npx tsc --noEmit"],
      tools: [
        { name: "sync-rates", run: "node scripts/sync-rates.mjs", about: "Pull the carrier's rate table into the shop.", needs: "sync-rates" },
        { name: "audit", run: "node scripts/audit.mjs", about: "Count the orders whose rate differs from the table." },
      ],
      sets: { "sync-rates": { env: ["CARRIER_ACCOUNT", "CARRIER_API_KEY", "SHOP_DOMAIN"], hosts: ["api.carrier.example"] } },
    });
    expect(d.notes).toEqual(["scripts/sync-rates.mjs reads GITHUB_TOKEN, which no job may carry; it is in no set"]);
    const read = readProfile({ list: () => [], read: () => d.json, label: (p) => p });
    expect(read.problems).toEqual([]);
    expect(read.tools.map((t) => t.needs)).toEqual(["sync-rates", undefined]);
  });

  it("prefers the checks the repository's own CI runs", () => {
    const fs = memFs({ ...shop(), [`${ROOT}/.github/workflows/ci.yml`]: "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: npm ci\n      - run: npm run lint\n      - run: npm test\n      - run: npm run deploy -- --token ${{ secrets.T }}\n", [`${ROOT}/.github/workflows/nightly.yml`]: "on:\n  schedule:\n    - cron: x\njobs:\n  a:\n    steps:\n      - run: npm run build\n" });
    const d = draftProfile({ fs, root: ROOT, counts: [{ command: "npx tsc --noEmit", count: 9, sessions: 3 }] });
    expect(d.draft.setup).toEqual(["npm ci"]);
    expect(d.draft.verify).toEqual(["npm run lint", "npm test"]);
  });

  it("shows two texts line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toBe("  a\n- b\n+ x\n  c");
    expect(lineDiff("same", "same")).toBe("");
  });
});

describe("the plan", () => {
  const plan = (files: Record<string, string>, state?: AdoptState) => planAdoption({ root: ROOT, project: "shop", fs: memFs(files), projectsRoot: PROJECTS, ...(state ? { state } : {}) });

  it("says what would happen and holds the files' contents, and nothing is written by looking", async () => {
    const files = shop();
    const before = JSON.stringify(files);
    const p = await plan(files);
    expect(JSON.stringify(files)).toBe(before);
    expect(p.found).toMatchObject({ transcripts: 3, memoryFiles: 6 });
    expect(p.files.map((f) => [f.action, f.kind, f.path])).toEqual([
      ["write", "profile", ".relay/project.json"],
      ["write", "index", "docs/context/README.md"],
      ["write", "context", "docs/context/carrier-api.md"],
      ["write", "context", "docs/context/shipping-rates.md"],
    ]);
    const rates = p.files.find((f) => f.path.endsWith("shipping-rates.md"))!.content;
    expect(rates.startsWith('# Shipping rates come from the carrier table\n\n> Rates are read from the carrier table, never hard-coded: the "zone" column decides\n\nThe carrier table is the source.')).toBe(true);
    expect(rates).toMatch(/<!-- relay adopt: from Claude Code memory `shipping-rates\.md`, sha256 [0-9a-f]{16}\./);
    const index = p.files.find((f) => f.kind === "index")!.content;
    expect(index).toContain("- [Carrier API reference](carrier-api.md): Endpoints of the carrier API the sync script calls");
    expect(index).not.toContain("leaky");
    expect(p.decisions.map((d) => [d.action, d.file, d.sourceRef])).toEqual([["record", "no-force-push.md", "claude-memory:no-force-push.md"], ["record", "who.md", "claude-memory:who.md"]]);
    expect(p.skipped).toEqual([
      { file: "leaky.md", why: "looks like it holds a secret (GitHub token); take it out of the note and run this again" },
      { file: "untyped.md", why: "no type in its frontmatter" },
    ]);
    // the secret is in no file, no decision and no line of the report
    const everything = JSON.stringify(p) + renderAdoptPlan(p);
    expect(everything).not.toContain("ghp_");
    expect(everything).not.toContain("4411");
    expect(renderAdoptPlan(p)).toContain("Repository files (3 to write)");
    expect(renderAdoptPlan(p)).toContain("Decisions (2 to record)");
  });

  it("writes nothing new the second time, and rewrites a file only when its note changed", async () => {
    const files = shop();
    const first = await plan(files);
    for (const f of first.files) files[`${ROOT}/${f.path}`] = f.content;
    // a person improved an adopted file in the repository: the note is the same, so the file is left as they made it
    files[`${ROOT}/docs/context/carrier-api.md`] = files[`${ROOT}/docs/context/carrier-api.md`]!.replace("POST /v2/rates", "POST /v2/rates (rate limited)");
    const second = await plan(files);
    expect(second.files).toEqual([]);
    expect(second.unchanged).toEqual(["docs/context/README.md", "docs/context/carrier-api.md", "docs/context/shipping-rates.md"]);
    expect(second.profile).toMatchObject({ exists: true, diff: "" });

    files[`${DIR}/memory/shipping-rates.md`] = note("project", "Rates are read from the carrier table", "The carrier table is the source, per zone and weight.");
    const third = await plan(files);
    expect(third.files.map((f) => [f.action, f.path])).toEqual([["update", "docs/context/README.md"], ["update", "docs/context/shipping-rates.md"]]);
  });

  it("leaves alone a file and a profile it did not write, and shows what the draft would add to the profile", async () => {
    const files = { ...shop(), [`${ROOT}/docs/context/shipping-rates.md`]: "# Ours\n\n> Written by hand\n", [`${ROOT}/.relay/project.json`]: '{\n  "steps": ["eval"]\n}\n' };
    const p = await plan(files);
    expect(p.files.map((f) => f.path)).toEqual(["docs/context/README.md", "docs/context/carrier-api.md"]);
    expect(p.files[0]!.content).toContain("- [Ours](shipping-rates.md): Written by hand");
    expect(p.skipped.map((s) => s.file)).toContain("shipping-rates.md");
    expect(p.profile.exists).toBe(true);
    expect(p.profile.diff).toContain('    "eval"');
    expect(p.profile.diff).toContain('+   "setup": [');
    expect(p.profile.diff).not.toMatch(/^- /m);
    expect(renderAdoptPlan(p)).toContain("the repository has a profile; it is left alone");
  });
});

describe("applying a plan", () => {
  function rig(known = true) {
    const decided: Array<{ project: string | null; text: string; source: string; sourceRef?: string; supersedesId?: number }> = [];
    let state: AdoptState = { decisions: {} };
    const client = {
      getProject: async (slug: string) => (known ? ({ slug } as never) : undefined),
      decide: async (d: (typeof decided)[number]) => (decided.push(d), { id: decided.length + 100 }),
    };
    const store = { read: () => JSON.parse(JSON.stringify(state)) as AdoptState, write: (s: AdoptState) => void (state = s) };
    return { decided, client, store, state: () => state };
  }
  const look = (files: Record<string, string>, state: AdoptState) => planAdoption({ root: ROOT, project: "shop", fs: memFs(files), projectsRoot: PROJECTS, state, transcripts: false });

  it("records each decision once, hands the files back, and supersedes a decision whose note changed", async () => {
    const files = shop();
    const r = rig();
    const first = await applyAdoption(await look(files, r.state()), { client: r.client, state: r.store });
    expect(first.files.map((f) => f.path)).toEqual([".relay/project.json", "docs/context/README.md", "docs/context/carrier-api.md", "docs/context/shipping-rates.md"]);
    expect(first.files.every((f) => Object.keys(f).join() === "path,content")).toBe(true);
    expect(first.recorded).toEqual([{ file: "no-force-push.md", id: 101, action: "record" }, { file: "who.md", id: 102, action: "record" }]);
    expect(r.decided[0]).toEqual({ project: "shop", text: "Never force-push the release branch. Why: the deploy hook reads its history and a rewrite re-ran a migration.", source: "adopt", sourceRef: "claude-memory:no-force-push.md" });

    const again = await look(files, r.state());
    expect(again.decisions.map((d) => d.action)).toEqual(["same", "same"]);
    expect((await applyAdoption(again, { client: r.client, state: r.store })).recorded).toEqual([]);
    expect(r.decided).toHaveLength(2);

    files[`${DIR}/memory/who.md`] = note("user", "Sam reviews on a laptop now", "Sam reads diffs on a laptop.");
    const changed = await look(files, r.state());
    expect(changed.decisions.map((d) => [d.file, d.action, d.supersedes])).toEqual([["no-force-push.md", "same", undefined], ["who.md", "update", 102]]);
    expect((await applyAdoption(changed, { client: r.client, state: r.store })).recorded).toEqual([{ file: "who.md", id: 103, action: "update" }]);
    expect(r.decided[2]).toMatchObject({ supersedesId: 102, text: "Sam reviews on a laptop now" });
  });

  it("does not record twice when two runs made the same plan, and records nothing for a project relay does not know", async () => {
    const r = rig();
    const stale = await look(shop(), r.state());
    await applyAdoption(stale, { client: r.client, state: r.store });
    await applyAdoption(stale, { client: r.client, state: r.store });
    expect(r.decided).toHaveLength(2);

    const unknown = rig(false);
    const out = await applyAdoption(await look(shop(), unknown.state()), { client: unknown.client, state: unknown.store });
    expect(unknown.decided).toEqual([]);
    expect(out.notRecorded.map((n) => n.file)).toEqual(["no-force-push.md", "who.md"]);
    expect(out.notRecorded[0]!.why).toContain("relay link registers it");
  });

  it("keeps a context file's text as the note had it", () => {
    const n = parseMemoryFile("carrier-api.md", shop()[`${DIR}/memory/carrier-api.md`]!);
    if ("problem" in n) throw new Error(n.problem);
    expect(contextFile(n, "Carrier API reference")).toContain("\n\nPOST /v2/rates returns one row per zone.\n\n<!-- relay adopt:");
  });
});
