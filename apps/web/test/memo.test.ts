import { describe, expect, it } from "vitest";
import { memoFor } from "../lib/memo.ts";

describe("memoFor (the /api/flow snapshot memo)", () => {
  it("shares one computation among callers within the ttl, including ones that arrive while it runs", async () => {
    let now = 1_000_000;
    let computed = 0;
    let release!: (v: { ts: number }) => void;
    const memo = memoFor(
      4_000,
      () => {
        computed++;
        return new Promise<{ ts: number }>((resolve) => {
          release = resolve;
        });
      },
      () => now,
    );
    const first = memo();
    now += 1_500;
    const second = memo(); // still in flight: the same promise
    expect(computed).toBe(1);
    release({ ts: 1 });
    expect(await first).toEqual({ ts: 1 });
    expect(await second).toBe(await first);

    now += 2_000; // 3.5 s after the first computation started: still served
    expect(await memo()).toEqual({ ts: 1 });
    expect(computed).toBe(1);

    now += 600; // 4.1 s: recompute
    const third = memo();
    expect(computed).toBe(2);
    release({ ts: 2 });
    expect(await third).toEqual({ ts: 2 });
  });

  it("drops a failed computation so the next caller retries, and reset() forgets the value", async () => {
    let now = 0;
    let calls = 0;
    const memo = memoFor(
      4_000,
      async () => {
        calls++;
        if (calls === 1) throw new Error("db down");
        return calls;
      },
      () => now,
    );
    await expect(memo()).rejects.toThrow("db down");
    expect(await memo()).toBe(2);
    expect(await memo()).toBe(2);
    memo.reset();
    expect(await memo()).toBe(3);
  });
});
