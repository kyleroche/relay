/**
 * Step checks (steps/check.ts) with scripted lanes over the cases relay ships (packages/cli/steps/checks): the
 * repository a step finds, the deterministic expectations, the judge. No model runs here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LaneRequest } from "../src/lanes/types.ts";
import { checkExpectations, loadCheckCases, matcher, parseCheckSpec, parseJudgeAnswer, runCheckCase, stripComments, type StepCheckCase } from "../src/steps/check.ts";
import { diskFiles, loadSteps, type Step } from "../src/steps/index.ts";
import type { LaneRunner } from "../src/work/job.ts";

const STEPS_DIR = resolve(import.meta.dirname, "..", "..", "cli", "steps");
const CHECKS = join(STEPS_DIR, "checks");
const steps = loadSteps([{ source: "relay", files: diskFiles(STEPS_DIR), dir: "" }]).steps;
const step = (name: string): Step => steps.get(name)!;
const one = (name: string, c: string): StepCheckCase => loadCheckCases(CHECKS, name).cases.find((x) => x.name === c)!;

let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "relay-step-check-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (lane: string, text: string, json?: unknown) => ({ tool: lane, ok: true, text, ...(json === undefined ? {} : { json }), model: `test/${lane}`, subscription: "max" as const, tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheWrite: 0, costEquiv: 0.01, durationMs: 10 });
const isJudge = (req: LaneRequest): boolean => req.prompt.startsWith("# relay step check: judge");
const edit = (req: LaneRequest, path: string, change: (text: string) => string): void => writeFileSync(join(req.cwd, path), change(readFileSync(join(req.cwd, path), "utf8")));
const dropLines = (...starts: string[]) => (text: string) => text.split("\n").filter((l) => !starts.some((s) => l.trim().startsWith(s))).join("\n");

/** A lane that plays the step with `work` and grades as `verdict` says; it remembers every request. */
function scripted(work: (req: LaneRequest) => string, verdict: (req: LaneRequest) => { text: string; json?: unknown } = () => ({ text: '{"pass": true, "reason": "it does what the rubric says"}' })) {
  const calls: Array<{ lane: string; judge: boolean; req: LaneRequest }> = [];
  const run: LaneRunner = async (req, lane) => {
    calls.push({ lane, judge: isJudge(req), req });
    if (isJudge(req)) {
      const v = verdict(req);
      return ok(lane, v.text, v.json);
    }
    return ok(lane, work(req));
  };
  return { calls, run };
}

const tidy = (req: LaneRequest): string => {
  edit(req, "src/retry.js", dropLines("// Added exponential backoff", "// wait before the next try"));
  return "Removed 2 comments in 1 file.";
};
const check = (c: StepCheckCase, s: Step, lane: ReturnType<typeof scripted>, repeat = 2) => runCheckCase(c, { step: s, lane: "claude", judge: "codex", laneRun: lane.run, workDir: tmp, repeat });

describe("the cases relay ships", () => {
  it("all read as checks, for steps that exist", () => {
    for (const name of ["remove-yap", "cleanup", "eval"]) {
      const { cases, problems } = loadCheckCases(CHECKS, name);
      expect(problems).toEqual([]);
      expect(cases.length).toBeGreaterThan(0);
      expect(step(name)).toBeDefined();
    }
    expect(loadCheckCases(CHECKS, "remove-yap").cases.map((c) => c.name)).toEqual(["narration", "nothing-to-do", "stale"]);
    expect(loadCheckCases(CHECKS, "no-such-step")).toEqual({ cases: [], problems: [] });
  });
});

describe("a before-pr step's check", () => {
  it("passes a lane that does what the step says, every run, with the change uncommitted over origin/main and the judge on the other lane", async () => {
    let diffSeen = "";
    const lane = scripted((req) => {
      diffSeen = execFileSync("git", ["diff", "origin/main", "--stat"], { cwd: req.cwd, encoding: "utf8" });
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: req.cwd, encoding: "utf8" }).trim()).toBe("M src/retry.js");
      return tidy(req);
    });
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), lane);
    expect(r).toMatchObject({ step: "remove-yap", case: "narration", pass: true, notRun: 0 });
    expect(r.runs.map((x) => [x.n, x.pass, x.failures])).toEqual([[1, true, []], [2, true, []]]);
    expect(r.runs[0]!.judge).toEqual({ pass: true, reason: "it does what the rubric says" });
    expect(diffSeen).toContain("src/retry.js");
    expect(lane.calls.map((c) => [c.lane, c.judge])).toEqual([["claude", false], ["codex", true], ["claude", false], ["codex", true]]);
    const [work, judge] = [lane.calls[0]!.req, lane.calls[1]!.req];
    expect(work.prompt.startsWith("# relay step: remove-yap (relay/step-check")).toBe(true);
    expect(work.prompt).toContain("The task was: Add exponential backoff to retry.");
    expect(work.prompt).toContain("`git diff origin/main`");
    expect(work).toMatchObject({ lane: "code", readOnly: false });
    expect(work.env?.GITHUB_TOKEN).toBeUndefined();
    expect(judge).toMatchObject({ lane: "review", readOnly: true });
    expect(judge.jsonSchema).toBeDefined();
    expect(judge.prompt).toContain("-// Added exponential backoff as requested in the task.");
    expect(judge.prompt).toContain("+// Added exponential backoff as requested in the task.");
    expect(judge.prompt).toContain("Removed 2 comments in 1 file.");
    expect(judge.prompt).toContain("which this change did not touch");
    expect(existsSync(join(tmp, "remove-yap-narration"))).toBe(false);
  });

  it("fails a lane that leaves the narration, at must_remove, and does not ask the judge or run again", async () => {
    const lane = scripted((req) => (edit(req, "src/retry.js", dropLines("// wait before the next try")), "Removed 1 comment in 1 file."));
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), lane, 3);
    expect(r.pass).toBe(false);
    expect(r.notRun).toBe(2);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.failures).toEqual(["must_remove: // Added exponential backoff as requested in the task. is still in src/retry.js"]);
    expect(lane.calls.some((c) => c.judge)).toBe(false);
  });

  it("fails a lane that changes code, at no_code_change", async () => {
    const lane = scripted((req) => {
      tidy(req);
      edit(req, "src/retry.js", (t) => t.replace("baseMs * 2 ** i", "baseMs * 3 ** i"));
      return "Removed 2 comments in 1 file.";
    });
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), lane);
    expect(r.pass).toBe(false);
    expect(r.runs[0]!.failures).toEqual(["no_code_change: code changed in src/retry.js"]);
  });

  it("fails a lane that deletes the comment that says why, or tidies a file the change did not touch", async () => {
    const eager = scripted((req) => (edit(req, "src/retry.js", dropLines("//")), edit(req, "src/port.js", dropLines("//")), "Removed 4 comments in 2 files."));
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), eager);
    expect(r.runs[0]!.failures).toEqual(["must_keep: /\\/\\/.*last attempt/i is gone", "unchanged: src/port.js was changed"]);
  });

  it("fails the case when the judge fails the rubric, or does not answer in JSON", async () => {
    const strict = scripted(tidy, () => ({ text: "", json: { pass: false, reason: "a comment was added" } }));
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), strict, 3);
    expect(r.pass).toBe(false);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.failures).toEqual(["judge (codex): a comment was added"]);
    expect(r.runs[0]!.judge).toEqual({ pass: false, reason: "a comment was added" });

    const chatty = scripted(tidy, () => ({ text: "Looks good to me! I would pass this." }));
    expect((await check(one("remove-yap", "narration"), step("remove-yap"), chatty)).runs[0]!.failures).toEqual(["the judge (codex) did not answer with the JSON it was asked for: Looks good to me! I would pass this."]);
  });

  it("fails a second run that goes wrong after a first that went right: a case passes when every run does", async () => {
    let n = 0;
    const flaky = scripted((req) => (++n === 1 ? tidy(req) : "Nothing to remove."));
    const r = await check(one("remove-yap", "narration"), step("remove-yap"), flaky, 3);
    expect(r.runs.map((x) => x.pass)).toEqual([true, false]);
    expect(r).toMatchObject({ pass: false, notRun: 1 });
  });

  it("holds the stale comment to being repaired or removed, and a clean change to being left alone", async () => {
    const repair = scripted((req) => (edit(req, "src/cache.js", (t) => t.replace("after 60 seconds", "after five minutes")), "Shortened 0, repaired 1 comment in 1 file."));
    expect((await check(one("remove-yap", "stale"), step("remove-yap"), repair, 1)).pass).toBe(true);
    const remove = scripted((req) => (edit(req, "src/cache.js", dropLines("// Entries expire")), "Removed 1 comment in 1 file."));
    expect((await check(one("remove-yap", "stale"), step("remove-yap"), remove, 1)).pass).toBe(true);
    const blind = scripted(() => "Nothing to remove.");
    expect((await check(one("remove-yap", "stale"), step("remove-yap"), blind, 1)).runs[0]!.failures).toEqual(["must_remove: // Entries expire after 60 seconds. is still in src/cache.js"]);
    const fixesCode = scripted((req) => (edit(req, "src/cache.js", (t) => t.replace("5 * 60_000", "60_000")), "Made the code match the comment."));
    expect((await check(one("remove-yap", "stale"), step("remove-yap"), fixesCode, 1)).runs[0]!.failures).toContain("no_code_change: code changed in src/cache.js");

    expect((await check(one("remove-yap", "nothing-to-do"), step("remove-yap"), scripted(() => "Removed 0 comments in 0 files."), 1)).pass).toBe(true);
    const overdoes = scripted((req) => (edit(req, "src/money.js", dropLines("//")), "Removed 1 comment in 1 file."));
    expect((await check(one("remove-yap", "nothing-to-do"), step("remove-yap"), overdoes, 1)).runs[0]!.failures).toEqual(["unchanged: src/money.js was changed"]);
  });
});

describe("an after-pr step's check", () => {
  it("runs read-only on the change as a commit over origin/main, and holds the verdict to what the change deserves", async () => {
    let log = "";
    const judging = scripted((req) => {
      log = execFileSync("git", ["log", "--format=%s", "origin/main..HEAD"], { cwd: req.cwd, encoding: "utf8" }).trim();
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: req.cwd, encoding: "utf8" }).trim()).toBe("");
      return "Verdict: fix first\n\n1. src/slugify.js:2 runs of whitespace are still one dash each\n   Why it matters: the task asked for one dash\n   Do instead: replace /\\s+/g";
    });
    const r = await check(one("eval", "misses-the-task"), step("eval"), judging, 1);
    expect(r.pass).toBe(true);
    expect(log).toBe("slugify: collapse runs of whitespace and drop punctuation");
    const work = judging.calls[0]!.req;
    expect(work).toMatchObject({ lane: "review", readOnly: true });
    expect(work.prompt).toContain("## Step: eval\n");
    expect(work.prompt).toContain("collapse any run of whitespace into a single dash");
    expect(judging.calls[1]!.req.prompt).toContain("(nothing: the working tree is as it was)");

    const lenient = scripted(() => "Verdict: ship\n\nNothing worth knowing.");
    expect((await check(one("eval", "misses-the-task"), step("eval"), lenient, 1)).runs[0]!.failures).toEqual(["text_must_match: the lane's last words do not match /^\\s*Verdict:\\s*(fix first|rethink)\\b/i"]);
    const meddling = scripted((req) => (edit(req, "src/slugify.js", (t) => t.replace("/\\s/g", "/\\s+/g")), "Verdict: fix first\n\n1. fixed it myself"));
    expect((await check(one("eval", "misses-the-task"), step("eval"), meddling, 1)).runs[0]!.failures).toEqual(["a read-only step changed src/slugify.js"]);
  });
});

describe("a task step's check", () => {
  it("starts from the repository as it is, with the step as the task", async () => {
    const cleaner = scripted((req) => (edit(req, "src/price.js", (t) => t.replace(/function legacyRound[\s\S]*?\n}\n\n/, "")), "Dead code: removed legacyRound (no caller, searched the repository). Tests pass before and after."));
    const r = await check(one("cleanup", "dead-code"), step("cleanup"), cleaner, 1);
    expect(r.runs[0]!.failures).toEqual([]);
    const work = cleaner.calls[0]!.req;
    expect(work.prompt).toContain("Title: cleanup");
    expect(work.prompt).toContain("Do a cleanup pass on this repository.");
    expect(work.readOnly).toBeUndefined();

    const lazy = scripted(() => "Nothing to clean.");
    expect((await check(one("cleanup", "dead-code"), step("cleanup"), lazy, 1)).runs[0]!.failures).toEqual(["must_remove: /function\\s+legacyRound\\b/ is still in src/price.js"]);
    const breaks = scripted((req) => (edit(req, "src/price.js", (t) => t.replace(/function legacyRound[\s\S]*?\n}\n\n/, "").replace("const TAX_RATE = 0.2;", "const TAX_RATE = 0.25;")), edit(req, "test/price.test.js", (t) => t.replace("12)", "12.5)")), "Cleaned up."));
    expect((await check(one("cleanup", "dead-code"), step("cleanup"), breaks, 1)).runs[0]!.failures).toEqual(["must_keep: /const TAX_RATE = 0\\.2;/ is gone", "unchanged: test/price.test.js was changed"]);
  });

  it("has no check for a step that answers a thread", async () => {
    await expect(check(one("remove-yap", "narration"), step("eval-respond"), scripted(() => ""), 1)).rejects.toThrow(/a check has no thread to give it/);
  });
});

describe("the parts", () => {
  it("a matcher is a whole line, or a regular expression between slashes", () => {
    expect(matcher("// gone").test("a\n  // gone  \nb")).toBe(true);
    expect(matcher("// gone").test("a // gone")).toBe(false);
    expect(matcher("/^verdict: ship$/i").test("x\nVerdict: ship\ny")).toBe(true);
    expect(() => matcher("/(/")).toThrow();
  });

  it("check.json refuses a key it does not know, a missing rubric and a path outside the repository", () => {
    expect(() => parseCheckSpec('{"rubric": "r", "must_removed": []}', "c")).toThrow(/unknown key must_removed/);
    expect(() => parseCheckSpec('{"must_remove": ["x"]}', "c")).toThrow(/rubric is required/);
    expect(() => parseCheckSpec('{"rubric": "r", "unchanged": ["../x"]}', "c")).toThrow(/inside the repository/);
    expect(() => parseCheckSpec('{"rubric": "r", "must_keep": ["/(/"]}', "c")).toThrow(/not a regular expression/);
    expect(parseCheckSpec('{"rubric": " r "}', "c")).toMatchObject({ rubric: "r", no_code_change: false, task: { title: "A change", body: "" } });
  });

  it("comments are taken out by the file's syntax, and a string that looks like one is kept", () => {
    expect(stripComments("a.ts", 'const u = "http://x"; // why\n/* block\n more */\nf(); /* inline */ g();\n')).toBe('const u = "http://x";\nf();  g();');
    expect(stripComments("a.ts", "const t = `// not a comment\n${x}`;\n")).toBe("const t = `// not a comment\n${x}`;");
    expect(stripComments("a.py", '#!/usr/bin/env python\nx = "# no"  # yes\n\n# gone\n')).toBe('#!/usr/bin/env python\nx = "# no"');
    expect(stripComments("a.md", "# heading")).toBeUndefined();
  });

  it("no_code_change counts any difference in a file whose comments it cannot tell from code", () => {
    const spec = parseCheckSpec('{"rubric": "r", "no_code_change": true}', "c");
    const tree = (text: string) => new Map([["notes.md", Buffer.from(text)]]);
    expect(checkExpectations(spec, { before: tree("a"), after: tree("b"), text: "", readOnly: false })).toEqual(["no_code_change: code changed in notes.md"]);
    expect(checkExpectations(spec, { before: tree("a"), after: new Map([...tree("a"), ["new.ts", Buffer.from("// c")]]), text: "", readOnly: false })).toEqual(["no_code_change: new.ts was added"]);
  });

  it("the judge's answer is JSON with pass and reason, or it is no answer", () => {
    expect(parseJudgeAnswer({ text: "", json: { pass: true, reason: "ok" } })).toEqual({ pass: true, reason: "ok" });
    expect(parseJudgeAnswer({ text: '```json\n{"pass": false, "reason": "no"}\n```' })).toEqual({ pass: false, reason: "no" });
    expect(parseJudgeAnswer({ text: 'Sure! {"pass": true, "reason": "ok"}' })).toBeUndefined();
    expect(parseJudgeAnswer({ text: '{"pass": "yes", "reason": "ok"}' })).toBeUndefined();
  });
});
