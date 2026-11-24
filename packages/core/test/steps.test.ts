import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "../src/runtime.ts";
import { diskFiles, loadSteps, otherLane, parseStep, projectSteps, readStepsProfile, respondStep, stepBody, StepError, type StepFiles } from "../src/steps/index.ts";

const at = (name: string) => ({ name, source: "project" as const, path: `.relay/steps/${name}.md` });
const file = (front: string, body = "Do the thing.") => `---\n${front}\n---\n\n${body}\n`;

/** Step files held in memory, as a layer reads them. */
const mem = (files: Record<string, string>): StepFiles => ({
  list: (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  read: (path) => files[path],
  label: (path) => path,
});

describe("parseStep", () => {
  it("reads the frontmatter and the instruction, with defaults by when", () => {
    const s = parseStep(file("name: tidy\ndescription: Tidy up\nwhen: before-pr\nmodel: sonnet"), at("tidy"));
    expect(s).toMatchObject({ name: "tidy", description: "Tidy up", when: "before-pr", lane: "same", model: "sonnet", mode: "edit", body: "Do the thing.", source: "project" });
    expect(parseStep(file("when: after-pr\nmode: read-only"), at("judge"))).toMatchObject({ name: "judge", lane: "other", mode: "read-only" });
    expect(parseStep(file("when: task"), at("sweep")).lane).toBe("any");
  });
  it("refuses what would otherwise be a silent default", () => {
    const bad = (front: string, name = "x", body?: string) => () => parseStep(file(front, body), at(name));
    expect(bad("when: before-pr\nlanes: codex")).toThrow(/unknown frontmatter lanes/);
    expect(bad("when: sometimes")).toThrow(/when must be one of before-pr, after-pr, respond, task/);
    expect(bad("name: other\nwhen: task")).toThrow(/the file is x\.md but its name is 'other'/);
    expect(bad("when: task\nlane: same")).toThrow(/no other lane to refer to/);
    expect(bad("when: before-pr\nmode: write")).toThrow(/mode must be edit or read-only/);
    expect(bad("when: before-pr", "x", "   ")).toThrow(/no instruction/);
    expect(() => parseStep("no frontmatter here", at("x"))).toThrow(StepError);
  });
  it("fills {{base}} in the instruction", () => {
    const s = parseStep(file("when: after-pr", "Read `git diff origin/{{base}}...HEAD`."), at("judge"));
    expect(stepBody(s, { base: "main" })).toBe("Read `git diff origin/main...HEAD`.");
  });
});

describe("the steps relay ships", () => {
  const lib = loadSteps([{ source: "relay", files: diskFiles(runtimePaths().stepsDir), dir: "" }]);
  it("all parse, and run where they say", () => {
    expect(lib.problems).toEqual([]);
    expect([...lib.steps.values()].map((s) => [s.name, s.when, s.lane, s.mode]).sort()).toEqual([
      ["cleanup", "task", "any", "edit"],
      ["eval", "after-pr", "other", "read-only"],
      ["eval-respond", "respond", "same", "edit"],
      ["plan", "task", "any", "read-only"],
      ["remove-yap", "before-pr", "same", "edit"],
      ["retro", "task", "any", "read-only"],
    ]);
    for (const s of lib.steps.values()) expect(s.description.length).toBeGreaterThan(20);
  });
  it("eval asks its four questions and remove-yap is told to touch comments only", () => {
    const text = lib.steps.get("eval")!.body;
    for (const q of ["built it from scratch", "papering over", "healthier", "proud"]) expect(text).toContain(q);
    expect(lib.steps.get("remove-yap")!.body).toMatch(/Touch comments and nothing else/);
  });
});

describe("layers", () => {
  it("the nearest layer wins by name, and a broken file is reported instead of hiding the one it would replace", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-steps-"));
    try {
      mkdirSync(join(dir, "relay"));
      mkdirSync(join(dir, "user"));
      writeFileSync(join(dir, "relay", "eval.md"), file("when: after-pr\ndescription: shipped", "SHIPPED"));
      writeFileSync(join(dir, "relay", "eval-respond.md"), file("when: respond", "ANSWER"));
      writeFileSync(join(dir, "relay", "remove-yap.md"), file("when: before-pr", "SHIPPED YAP"));
      writeFileSync(join(dir, "user", "eval.md"), file("when: after-pr\nlane: grok", "MINE"));
      writeFileSync(join(dir, "user", "remove-yap.md"), "not a step");
      const project = mem({ ".relay/project.json": JSON.stringify({ steps: ["remove-yap", "eval", "nope", "eval-respond"] }), ".relay/steps/house.md": file("when: before-pr", "HOUSE RULES") });
      const p = projectSteps({ relayDir: join(dir, "relay"), userDir: join(dir, "user"), project });
      expect(p.library.get("eval")).toMatchObject({ body: "MINE", source: "user", lane: "grok" });
      expect(p.library.get("remove-yap")).toMatchObject({ body: "SHIPPED YAP", source: "relay" });
      expect(p.library.get("house")).toMatchObject({ source: "project" });
      expect(p.enabled.map((s) => s.name)).toEqual(["remove-yap", "eval"]);
      expect(p.problems).toEqual([
        expect.stringMatching(/remove-yap\.md: a step starts with a frontmatter block/),
        expect.stringMatching(/lists the step 'nope', and no step by that name exists/),
        expect.stringMatching(/lists 'eval-respond', which answers another step's findings/),
      ]);
      expect(respondStep(p.library, "eval")?.body).toBe("ANSWER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a project with no profile runs no steps, and a profile that is not a list says so", () => {
    expect(readStepsProfile(mem({}))).toEqual({ steps: [], problems: [] });
    expect(readStepsProfile(mem({ ".relay/project.json": '{"steps":"eval"}' })).problems[0]).toMatch(/steps must be a list of step names/);
    expect(readStepsProfile(mem({ ".relay/project.json": "{nope" })).problems[0]).toMatch(/is not JSON/);
    expect(readStepsProfile(mem({ ".relay/project.json": '{"steps":["eval","eval"]}' })).steps).toEqual(["eval"]);
  });
});

describe("otherLane", () => {
  it("picks a served code lane that did not do the work, and the same lane only when there is no other", () => {
    expect(otherLane("claude", ["claude", "codex", "grok"])).toBe("codex");
    expect(otherLane("codex", ["claude", "codex"])).toBe("claude");
    expect(otherLane("grok", ["grok", "nodes"])).toBe("grok");
    expect(otherLane("claude", [])).toBe("claude");
  });
});
