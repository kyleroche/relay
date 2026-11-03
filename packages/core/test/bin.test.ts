import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBin } from "../src/lanes/bin.ts";

describe("cliBin", () => {
  it("takes the override, else the native install under ~/.local/bin, else PATH, else the bare name", () => {
    expect(cliBin("claude", { RELAY_CLAUDE_BIN: "/opt/claude" })).toBe("/opt/claude");
    const dir = mkdtempSync(join(tmpdir(), "relay-bin-"));
    try {
      writeFileSync(join(dir, "zzfake"), "#!/bin/sh\n");
      chmodSync(join(dir, "zzfake"), 0o755);
      const prev = process.env.PATH;
      process.env.PATH = `${dir}:${prev ?? ""}`;
      try {
        expect(cliBin("zzfake", {})).toBe(join(dir, "zzfake"));
        expect(cliBin("zznowhere", {})).toBe("zznowhere");
      } finally {
        process.env.PATH = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
