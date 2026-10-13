import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEGIN, END, checkOwnedSection, findOwnedSection, installOwnedSection, isIncludeOnly, readRulesState, removeOwnedSection, renderOwnedSection } from "../src/rules/owned-section.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-owned-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (f: string) => readFileSync(join(root, f), "utf8");
const inner = (f: string) => findOwnedSection(read(f))!.inner;

describe("owned section", () => {
  it("creates AGENTS.md, leaves a missing CLAUDE.md alone, records hashes", () => {
    const r = installOwnedSection(root, { project: "demo", repo: "acme/demo" });
    expect(r).toEqual([
      { file: "AGENTS.md", action: "created" },
      { file: "CLAUDE.md", action: "absent", detail: expect.any(String) },
    ]);
    expect(read("AGENTS.md")).toContain(BEGIN);
    expect(read("AGENTS.md")).toContain(END);
    expect(inner("AGENTS.md")).toBe(renderOwnedSection({ project: "demo" }));
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    const st = readRulesState(root);
    expect(st.project).toBe("demo");
    expect(st.repo).toBe("acme/demo");
    expect(st.sections["AGENTS.md"]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appends to an existing file without touching the rest, then is idempotent", () => {
    writeFileSync(join(root, "AGENTS.md"), "# My agents file\n\nKeep this.\n");
    writeFileSync(join(root, "CLAUDE.md"), "# Claude notes\n");
    const r1 = installOwnedSection(root, { project: "demo" });
    expect(r1.map((x) => x.action)).toEqual(["appended", "appended"]);
    expect(read("AGENTS.md").startsWith("# My agents file\n\nKeep this.\n")).toBe(true);
    const r2 = installOwnedSection(root, { project: "demo" });
    expect(r2.map((x) => x.action)).toEqual(["unchanged", "unchanged"]);
    expect(read("AGENTS.md").split(BEGIN).length).toBe(2);
  });

  it("updates the section when the body changes and keeps text around it", () => {
    writeFileSync(join(root, "AGENTS.md"), "before\n");
    installOwnedSection(root, { body: "v1" });
    const after = read("AGENTS.md") + "\nafter the section\n";
    writeFileSync(join(root, "AGENTS.md"), after);
    const r = installOwnedSection(root, { body: "v2" });
    expect(r[0]!.action).toBe("updated");
    expect(inner("AGENTS.md")).toBe("v2");
    expect(read("AGENTS.md").startsWith("before\n")).toBe(true);
    expect(read("AGENTS.md").endsWith("after the section\n")).toBe(true);
  });

  it("refuses to clobber a locally edited section unless forced", () => {
    installOwnedSection(root, { body: "v1" });
    const edited = read("AGENTS.md").replace("v1", "v1 plus my own note");
    writeFileSync(join(root, "AGENTS.md"), edited);
    expect(checkOwnedSection(root)[0]).toMatchObject({ file: "AGENTS.md", localEdit: true });
    const r = installOwnedSection(root, { body: "v2" });
    expect(r[0]!.action).toBe("refused-local-edit");
    expect(inner("AGENTS.md")).toBe("v1 plus my own note");
    const f = installOwnedSection(root, { body: "v2", force: true });
    expect(f[0]!.action).toBe("updated");
    expect(inner("AGENTS.md")).toBe("v2");
  });

  it("refuses to take over markers relay never wrote, unless forced", () => {
    writeFileSync(join(root, "AGENTS.md"), `intro\n${BEGIN}\nsomeone else's block\n${END}\n`);
    const r = installOwnedSection(root, { body: "ours" });
    expect(r[0]!.action).toBe("refused-local-edit");
    expect(installOwnedSection(root, { body: "ours", force: true })[0]!.action).toBe("updated");
    expect(inner("AGENTS.md")).toBe("ours");
  });

  it("leaves a CLAUDE.md that only includes AGENTS.md", () => {
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    expect(isIncludeOnly("@AGENTS.md\n")).toBe(true);
    expect(isIncludeOnly("@AGENTS.md\nmore\n")).toBe(false);
    const r = installOwnedSection(root, { project: "demo" });
    expect(r.find((x) => x.file === "CLAUDE.md")?.action).toBe("skipped-include");
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n");
  });

  it("removes the section and forgets the hash, keeping the rest of the file", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Mine\n\nkeep\n");
    installOwnedSection(root, { body: "v1" });
    const r = removeOwnedSection(root);
    expect(r[0]!.action).toBe("removed");
    expect(read("AGENTS.md")).toBe("# Mine\n\nkeep\n");
    expect(readRulesState(root).sections["AGENTS.md"]).toBeUndefined();
  });

  it("reports missing markers as a place relay will not write", () => {
    installOwnedSection(root, { body: "v1" });
    writeFileSync(join(root, "AGENTS.md"), "# markers deleted\n");
    const c = checkOwnedSection(root)[0]!;
    expect(c.action).toBe("absent");
    expect(c.detail).toMatch(/markers missing/);
  });
});
