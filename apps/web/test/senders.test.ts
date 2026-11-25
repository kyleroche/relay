import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { senderMayOpenTasks } from "../lib/webhooks/senders.ts";

const saved: Record<string, string | undefined> = {};
const KEYS = ["RELAY_ALLOWED_SENDERS", "GITHUB_TOKEN", "GITHUB_APP_TOKEN"];

describe("who may open a task from GitHub", () => {
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("with no allowlist anywhere, a label opens no task", async () => {
    expect(await senderMayOpenTasks("acme/demo", "anyone")).toBe(false);
    expect(await senderMayOpenTasks(null, "anyone")).toBe(false);
  });

  it("with RELAY_ALLOWED_SENDERS, only a listed login may, case-insensitively", async () => {
    process.env.RELAY_ALLOWED_SENDERS = " Kyle , concierge[bot]";
    expect(await senderMayOpenTasks("acme/demo", "KYLE")).toBe(true);
    expect(await senderMayOpenTasks("acme/demo", "concierge[bot]")).toBe(true);
    expect(await senderMayOpenTasks("acme/demo", "stranger")).toBe(false);
  });
});
