/**
 * Which token may do what to a task over REST (app/api/v1/tasks/[...id]/route.ts): the scope each action needs, checked
 * before the handler runs. Opening work (`tasks:write`) and settling it (`tasks:decide`) are different scopes, so a bot
 * that opens tasks can hold a token that approves and closes none.
 *
 * The site here is in mock mode, where every write that passes the scope check answers 501 ("needs a database"): a
 * 501 is the route saying the token was let through, and a 403 names the scope it lacks. What an admitted approval
 * then does on a board is test/task-ops.test.ts.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../app/api/v1/tasks/[...id]/route.ts";
import { callerGrant, requireScope } from "../lib/api.ts";
import { mintSession, SESSION_COOKIE } from "../lib/session-token.ts";

const WRITER = "writer-token-for-the-test";
const DECIDER = "decider-token-for-the-test";
const RELEASER = "releaser-token-for-the-test";
const SESSION_SECRET = "a-session-secret-of-at-least-32-characters";
const ENV = ["RELAY_DATA", "DATABASE_URL", "RELAY_API_TOKENS", "RELAY_MEMORY_TOKEN", "RELAY_PUBLIC_READ", "RELAY_SESSION_SECRET"] as const;
const before: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of ENV) before[name] = process.env[name];
  process.env.RELAY_DATA = "mock";
  delete process.env.DATABASE_URL;
  delete process.env.RELAY_MEMORY_TOKEN;
  // the lead's scopes for the writer; a bot trusted to decide; a bot trusted to release
  process.env.RELAY_API_TOKENS = `${WRITER}:tasks:read,tasks:write,memory:read,feed:read,events:write;${DECIDER}:tasks:read,tasks:decide;${RELEASER}:tokens:write`;
});
afterAll(() => {
  for (const name of ENV) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
});

let caller = 0;
/** One action on a task as a token; each call from its own address, so the route's rate limit is not what answers. */
async function act(action: string, token: string | null, body: Record<string, unknown> = {}) {
  const req = new NextRequest(`https://relay.example.test/api/v1/tasks/msg_1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++caller}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ id: ["msg_1", action] }) });
  return { status: res.status, challenge: res.headers.get("www-authenticate") ?? "", body: (await res.json()) as { required_scope?: string; detail?: string } };
}

describe("the scope each task action needs", () => {
  it("refuses approve and close to a token with tasks:write and no tasks:decide, naming the scope", async () => {
    for (const action of ["approve", "close"]) {
      const r = await act(action, WRITER);
      expect(r.status).toBe(403);
      expect(r.body.required_scope).toBe("tasks:decide");
      expect(r.body.detail).toMatch(/lacks the tasks:decide scope/);
      expect(r.challenge).toContain('scope="tasks:decide"');
    }
  });

  it("still lets that token send a task back and requeue it", async () => {
    expect((await act("request-changes", WRITER, { note: "Use the header." })).status).toBe(501);
    expect((await act("requeue", WRITER, { lane: "codex" })).status).toBe(501);
  });

  it("lets a token with tasks:decide approve and close, and nothing that takes another scope", async () => {
    expect((await act("approve", DECIDER)).status).toBe(501);
    expect((await act("close", DECIDER, { reason: "duplicate" })).status).toBe(501);
    for (const action of ["request-changes", "requeue"]) expect(await act(action, DECIDER, { note: "x" })).toMatchObject({ status: 403, body: { required_scope: "tasks:write" } });
  });

  it("keeps release under tokens:write, which neither task scope carries", async () => {
    for (const token of [WRITER, DECIDER]) expect(await act("release", token)).toMatchObject({ status: 403, body: { required_scope: "tokens:write" } });
    expect((await act("release", RELEASER)).status).toBe(501);
  });

  it("asks a caller with no token for the scope of the action it named", async () => {
    expect(await act("approve", null)).toMatchObject({ status: 401, body: { required_scope: "tasks:decide" } });
    expect(await act("requeue", null)).toMatchObject({ status: 401, body: { required_scope: "tasks:write" } });
    expect((await act("approve", "no-such-token")).status).toBe(401);
  });
});

describe("a signed-in person", () => {
  it("holds every scope, tasks:decide included, so the split takes nothing from the task page or the API in a browser", async () => {
    // a session counts only on a site with a database; nothing here opens one
    process.env.RELAY_DATA = "db";
    process.env.RELAY_SESSION_SECRET = SESSION_SECRET;
    try {
      const cookie = `${SESSION_COOKIE}=${await mintSession({ login: "kyle", name: "Kyle", avatar_url: null }, SESSION_SECRET)}`;
      const req = new Request("https://relay.example.test/api/v1/tasks/msg_1/approve", { method: "POST", headers: { cookie } });
      for (const scope of ["tasks:decide", "tasks:write", "tokens:write"] as const) expect(await requireScope(req, scope, "/api/v1/tasks/msg_1/approve")).toBeNull();
      const grant = await callerGrant(req);
      expect(grant).toMatchObject({ actor: "human:kyle", source: "session" });
      expect(grant?.scopes).toEqual(expect.arrayContaining(["tasks:write", "tasks:decide"]));
      // and without the cookie the same request is asked for a token
      expect((await requireScope(new Request(req.url, { method: "POST" }), "tasks:decide", "/x"))?.status).toBe(401);
    } finally {
      process.env.RELAY_DATA = "mock";
    }
  });
});
