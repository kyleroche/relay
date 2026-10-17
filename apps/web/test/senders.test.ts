import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { senderMayOpenTasks, senderTrusted } from "../lib/webhooks/usage.ts";

const saved: Record<string, string | undefined> = {};
const KEYS = ["RELAY_ALLOWED_SENDERS", "GITHUB_TOKEN", "GITHUB_APP_TOKEN"];

describe("sender allowlists", () => {
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });

  it("with no allowlist anywhere, usage comments are trusted but labels open no task", async () => {
    expect(await senderTrusted("acme/demo", "anyone")).toBe(true);
    expect(await senderMayOpenTasks("acme/demo", "anyone")).toBe(false);
    expect(await senderMayOpenTasks(null, "anyone")).toBe(false);
  });

  it("with RELAY_ALLOWED_SENDERS, both follow the list, case-insensitively", async () => {
    process.env.RELAY_ALLOWED_SENDERS = " Kyle , concierge[bot]";
    expect(await senderTrusted("acme/demo", "kyle")).toBe(true);
    expect(await senderMayOpenTasks("acme/demo", "KYLE")).toBe(true);
    expect(await senderMayOpenTasks("acme/demo", "concierge[bot]")).toBe(true);
    expect(await senderTrusted("acme/demo", "stranger")).toBe(false);
    expect(await senderMayOpenTasks("acme/demo", "stranger")).toBe(false);
  });
});
