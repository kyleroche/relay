import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { captureDecisions, commandGate, parseTranscript, ruleGate, segmentTurns } from "../src/memory/capture.ts";

let db: Db;
let tmp: string;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", path: "/tmp/demo" });
  tmp = mkdtempSync(join(tmpdir(), "relay-capture-"));
});
afterAll(async () => {
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const claudeLine = (role: "user" | "assistant", content: unknown) => JSON.stringify({ type: role, message: { role, content } });

describe("parseTranscript", () => {
  it("reads Claude Code JSONL, drops tool blocks and system noise", () => {
    const raw = [
      claudeLine("user", "Let's use recursive descent instead of PEG because the grammar is tiny."),
      claudeLine("assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Agreed." }, { type: "tool_use", name: "Edit", input: {} }]),
      claudeLine("user", [{ type: "tool_result", content: "ok" }]),
      claudeLine("user", "<system-reminder>ignore me</system-reminder>"),
      '{"type":"summary","summary":"x"}',
      "not json at all",
    ].join("\n");
    const turns = parseTranscript(raw);
    expect(turns).toEqual([
      { role: "user", text: "Let's use recursive descent instead of PEG because the grammar is tiny." },
      { role: "assistant", text: "Agreed." },
    ]);
  });

  it("reads Codex rollout shapes and falls back to plain text", () => {
    const raw = [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "We will always run vitest before pushing." }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Understood." }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    ].join("\n");
    expect(parseTranscript(raw).map((t) => t.text)).toEqual(["We will always run vitest before pushing.", "Understood."]);
    expect(parseTranscript("just a plain transcript")).toEqual([{ role: "assistant", text: "just a plain transcript" }]);
    expect(parseTranscript("")).toEqual([]);
  });
});

describe("segments and gates", () => {
  it("segments by token budget without splitting a turn", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: "word ".repeat(400).trim() })); // ≈500 tokens each
    const segs = segmentTurns(turns, 1200);
    expect(segs.length).toBeGreaterThan(3);
    for (const s of segs) expect(s.split("\n\n").length).toBeLessThanOrEqual(2);
    expect(segs.join("\n\n").split("\n\n")).toHaveLength(10);
  });

  it("rule gate passes decision language and rejects chatter", () => {
    expect(ruleGate("USER: let's go with pnpm instead of npm because it is faster")).toBe(true);
    expect(ruleGate("ASSISTANT: We decided to keep migrations plain SQL.")).toBe(true);
    expect(ruleGate("USER: show me the file\n\nASSISTANT: here it is")).toBe(false);
  });

  it("command gate honours exit code and output, falls back to the rule when the command is missing", () => {
    expect(commandGate("cat >/dev/null; echo yes", "anything")).toBe(true);
    expect(commandGate("cat >/dev/null; echo no", "we decided")).toBe(false);
    expect(commandGate("cat >/dev/null; exit 3", "we decided")).toBe(false);
    expect(commandGate("/nonexistent/jev-gate-binary", "we decided because")).toBe(true);
  });
});

describe("captureDecisions", () => {
  it("dry-run gates segments, honours the byte offset, and never calls the model", async () => {
    const path = join(tmp, "t.jsonl");
    const first = claudeLine("user", "We decided to use vitest because it runs PGlite in-process.") + "\n";
    writeFileSync(path, first);
    const r1 = await captureDecisions({ db }, path, { project: "demo", source: "claude", dryRun: true });
    expect(r1).toMatchObject({ turns: 1, segments: 1, gated: 1, calls: 0, added: [], bytes: Buffer.byteLength(first) });

    writeFileSync(path, first + claudeLine("assistant", "Here is the file listing.") + "\n");
    const r2 = await captureDecisions({ db }, path, { project: "demo", source: "claude", dryRun: true, offset: r1.bytes });
    expect(r2).toMatchObject({ turns: 1, gated: 0, calls: 0 });
    expect(r2.bytes).toBeGreaterThan(r1.bytes);

    const r3 = await captureDecisions({ db }, path, { project: "demo", source: "claude", dryRun: true, gateCommand: "cat >/dev/null; echo no" });
    expect(r3.gated).toBe(0);
    expect(await repo.listDecisions(db, "demo")).toEqual([]);
  });
});
