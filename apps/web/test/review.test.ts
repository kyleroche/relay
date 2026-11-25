/**
 * What a task in review asks for (lib/tasks.ts `reviewKind`, lib/review.ts): a merge, a plan to open, a report to
 * read, or outputs to accept; and the tasks an approved plan opened, read from the line core leaves in the thread.
 */
import { describe, expect, it } from "vitest";
import { board } from "@relay/core";
import { approveCopy } from "../lib/review.ts";
import { planOpened, reviewKind } from "../lib/tasks.ts";

const pr = { repo: "acme/demo", number: 9, url: "https://github.com/acme/demo/pull/9" };

describe("reviewKind", () => {
  it("follows the hold, as core's approval does", () => {
    expect(reviewKind({ pr, hold: { kind: board.HOLD.review, reason: pr.url } })).toBe("pr");
    expect(reviewKind({ pr: null, hold: { kind: board.HOLD.plan, reason: board.planHoldReason({ message: "790.1", sha256: "a".repeat(64), tasks: 2 }) } })).toBe("plan");
    expect(reviewKind({ pr: null, hold: { kind: board.HOLD.review, reason: board.REPORT_REASON } })).toBe("report");
    expect(reviewKind({ pr: null, hold: { kind: board.HOLD.review, reason: "2 outputs attached" } })).toBe("outputs");
  });

  it("does not take a hold of another kind that happens to say report for one", () => {
    expect(reviewKind({ pr: null, hold: { kind: "question", reason: board.REPORT_REASON } })).toBe("outputs");
  });
});

describe("the words of an approval", () => {
  it("say what the click does", () => {
    expect(approveCopy("plan", null)).toMatchObject({ label: "Approve plan", armed: "Open its tasks now" });
    expect(approveCopy("plan", null).hint).toMatch(/each waiting for what it needs\. Nothing was opened yet\./);
    expect(approveCopy("plan", null).sendBack).toMatch(/planned again/);
    expect(approveCopy("report", null)).toMatchObject({ label: "Mark as read", done: "Marked as read." });
    expect(approveCopy("pr", 9)).toMatchObject({ label: "Approve and merge", armed: "Merge #9 now" });
    expect(approveCopy("outputs", null).label).toBe("Approve outputs");
  });
});

describe("planOpened", () => {
  const line = "Plan approved by human:kyle.roche. Opened 2 tasks: loader (790.812), pages (790.813).";

  it("reads the tasks from the line an approval leaves", () => {
    expect(planOpened([{ text: "Proposed plan: 2 tasks.", by: "runner:studio-claude", log: false }, { text: line, by: "human:kyle.roche", log: true }])).toEqual([{ key: "loader", id: "790.812" }, { key: "pages", id: "790.813" }]);
    expect(planOpened([{ text: "Plan approved. Opened 1 task: only-one (12).", by: "bot:chief", log: true }])).toEqual([{ key: "only-one", id: "12" }]);
  });

  it("takes the line only from a person or a bot, and only from relay's own log line", () => {
    expect(planOpened([{ text: line, by: "agent:someone/human-kyle", log: true }])).toEqual([]);
    expect(planOpened([{ text: line, by: "runner:studio-claude", log: true }])).toEqual([]);
    expect(planOpened([{ text: line, by: "human:kyle.roche", log: false }])).toEqual([]);
    expect(planOpened([{ text: `I think: ${line}`, by: "human:kyle.roche", log: true }])).toEqual([]);
    expect(planOpened([])).toEqual([]);
  });
});
