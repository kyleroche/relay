import { describe, expect, it } from "vitest";
import { branchFor, parseRef, projectOfChannel, relayState, splitTaskText, taskRef, taskText, workChannel, workerProfile } from "../src/board/mapping.ts";

describe("channels", () => {
  it("keeps every project's queue under one root", () => {
    expect(workChannel("valor-store")).toBe("work/valor-store");
    expect(projectOfChannel("work/valor-store")).toBe("valor-store");
    expect(projectOfChannel("decisions/mission-learn")).toBeUndefined();
    expect(projectOfChannel("relay/workers")).toBeUndefined();
    expect(projectOfChannel("work/a/b")).toBeUndefined();
  });
  it("refuses a slug that would not be one channel segment", () => {
    expect(() => workChannel("Valor Store")).toThrow(/not a project slug/);
    expect(() => workChannel("a/b")).toThrow(/not a project slug/);
  });
});

describe("relayState", () => {
  it("folds the board's state and a hold's kind into one word", () => {
    const none = { blocked: null };
    expect(relayState({ state: "waiting", ...none })).toBe("waiting");
    expect(relayState({ state: "ready", ...none })).toBe("queued");
    expect(relayState({ state: "claimed", ...none })).toBe("running");
    expect(relayState({ state: "blocked", blocked: { kind: "awaiting_review", reason: "PR" } })).toBe("review");
    expect(relayState({ state: "blocked", blocked: { kind: "gate", reason: "pre-check" } })).toBe("held");
    expect(relayState({ state: "blocked", blocked: { kind: "needs_input", reason: "which one?" } })).toBe("blocked");
    expect(relayState({ state: "blocked", blocked: { kind: "edited", reason: "" } })).toBe("blocked");
    expect(relayState({ state: "completed", ...none })).toBe("done");
    expect(relayState({ state: "failed", ...none })).toBe("failed");
    expect(relayState({ state: "canceled", ...none })).toBe("closed");
  });
});

describe("names made from a task", () => {
  it("gives a branch a short stable ref of the task's ID", () => {
    const id = "msg_5b1e0c9a-3f1d-4a7e-9d0b-2a6f6f0c1d2e_3";
    expect(taskRef(id)).toMatch(/^[0-9a-f]{8}$/);
    expect(taskRef(id)).toBe(taskRef(id));
    expect(taskRef(id)).not.toBe(taskRef(`${id}1`));
    expect(branchFor("codex", id)).toBe(`relay/codex-${taskRef(id)}`);
  });
  it("fits a worker's profile in the board's 32 characters, a letter first", () => {
    expect(workerProfile("Kyles-Mac-mini", "claude")).toBe("relay-kyles-mac-mini-claude");
    const long = workerProfile("a-very-long-hostname.local.example-container", "codex");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^relay-[a-z0-9-]+-codex$/);
    expect(long).not.toBe(workerProfile("a-very-long-hostname.local.example-other", "codex"));
  });
});

describe("task text", () => {
  it("round-trips a title and a body", () => {
    expect(taskText("  Add   dark mode ", "\nUse the tokens.\n")).toBe("# Add dark mode\n\nUse the tokens.");
    expect(splitTaskText("# Add dark mode\n\nUse the tokens.")).toEqual({ title: "Add dark mode", body: "Use the tokens." });
    expect(taskText("Only a title", "")).toBe("# Only a title");
  });
  it("reads a thread nobody formatted: the first line is the title", () => {
    expect(splitTaskText("\nfix the flaky deploy test\nit times out on CI")).toEqual({ title: "fix the flaky deploy test", body: "it times out on CI" });
    expect(splitTaskText("   ")).toEqual({ title: "", body: "" });
  });
  it("parses owner/name#n and nothing else", () => {
    expect(parseRef("kyleroche/valor-store#26")).toEqual({ repo: "kyleroche/valor-store", number: 26 });
    expect(parseRef("valor-store#26")).toBeUndefined();
    expect(parseRef(undefined)).toBeUndefined();
  });
});
