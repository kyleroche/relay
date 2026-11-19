import { describe, expect, it } from "vitest";
import { board } from "@relay/core";
import { board as open } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { boardCheck } from "../src/commands/probes.ts";

const memory = async () => board.connectBoard(open({ backend: local({ memory: true }) }));

describe("doctor's board line", () => {
  it("warns until relay's schemas are registered, then says who and how many workers", async () => {
    const session = await memory();
    const before = await boardCheck({ from: [] }, async () => session);
    expect(before.status).toBe("warn");
    expect(before.detail).toMatch(/relay's schemas are not registered there yet\. Run: relay setup --board$/);
    await board.ensureSchemas(session.board);
    const after = await boardCheck({ from: [] }, async () => session);
    expect(after).toMatchObject({ status: "ok", name: "board" });
    expect(after.detail).toMatch(/as client; takes tasks from 1 owner; 0 workers$/);
  });

  it("names the fix for a board that does not exist, and for a login that is missing", async () => {
    const missing = await boardCheck({ from: [], name: "scratch" }, async () => Promise.reject(new board.BoardError("no_board", "no board named scratch on this team", 404)));
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("relay setup --board --board-name scratch --create");
    const out = await boardCheck({ from: [] }, async () => Promise.reject(new Error("You're not logged in to Vercel.")));
    expect(out.detail).toMatch(/You're not logged in to Vercel\.\. The board takes this machine's own Vercel login: run vercel login/);
  });

  it("gives up on a board that does not answer", async () => {
    const hung = await boardCheck({ from: [] }, () => new Promise(() => {}), 20);
    expect(hung).toMatchObject({ status: "fail" });
    expect(hung.detail).toContain("no answer in 0.02s");
  });
});
