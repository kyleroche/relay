/**
 * The small helpers the web app's database adapter and asset routes lean on: tokens, event paging filters, daily
 * usage, project stats, presigned-upload finalisation, and zip entry extraction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as projects from "../src/db/projects.ts";
import * as events from "../src/db/events.ts";
import * as memory from "../src/db/memory.ts";
import * as tokens from "../src/db/tokens.ts";
import * as assets from "../src/db/assets.ts";
import { LocalStore, verifyLocalSignedUrl, verifyLocalUploadUrl } from "../src/assets/store.ts";
import { finalizeFromKey, IngestError, parseUploadKey, uploadKeyFor } from "../src/assets/ingest.ts";
import { mimeForEntry, readZipEntry } from "../src/assets/media.ts";
import { ulid } from "../src/util.ts";

// ---------- fixtures ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((1 + width * 3) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A zip whose entries are stored (method 0) or deflated (method 8). */
function zip(entries: Record<string, { text: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, e] of Object.entries(entries)) {
    const nameB = Buffer.from(name, "utf8");
    const raw = Buffer.from(e.text, "utf8");
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameB, data);
    centrals.push(central, nameB);
    offset += local.length + nameB.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- setup ----------

let db: Db;
let home: string;
let store: LocalStore;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "relay-web-helpers-"));
  delete process.env.RELAY_ASSET_SIGNING_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  store = new LocalStore(join(home, "assets"));
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await projects.upsertProject(db, { slug: "web", repo: "acme/web", path: "/tmp/web" });
  await projects.upsertProject(db, { slug: "quiet", path: "/tmp/quiet" });
});
afterAll(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("tokens", () => {
  it("mints once, finds by hash, lists, revokes, rejects bad scopes", async () => {
    const { token, row } = await tokens.createToken(db, { name: "ci", scopes: ["feed:read", "assets:write", "feed:read"], createdBy: "human:test" });
    expect(token.startsWith(tokens.TOKEN_PREFIX)).toBe(true);
    expect(row.scopes).toEqual(["feed:read", "assets:write"]);
    expect(row.revoked_at).toBeNull();
    const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM tokens WHERE id = $1", [row.id]);
    expect(stored[0]?.token_hash).toBe(tokens.hashToken(token));
    expect(stored[0]?.token_hash).not.toContain(token);

    const found = await tokens.findToken(db, token);
    expect(found?.id).toBe(row.id);
    expect((await tokens.findToken(db, token))?.last_used_at).not.toBeNull();
    expect(await tokens.findToken(db, "rly_nope")).toBeUndefined();
    expect(await tokens.findToken(db, "")).toBeUndefined();

    expect((await tokens.listTokens(db)).map((t) => t.name)).toContain("ci");
    expect((await tokens.revokeToken(db, "ci"))?.id).toBe(row.id);
    expect(await tokens.findToken(db, token)).toBeUndefined();
    expect((await tokens.listTokens(db)).length).toBe(0);
    expect((await tokens.listTokens(db, { includeRevoked: true })).length).toBe(1);
    expect(await tokens.revokeToken(db, "ci")).toBeUndefined();

    await expect(tokens.createToken(db, { name: "x", scopes: ["root"], createdBy: "h" })).rejects.toThrow(/unknown scope/);
    await expect(tokens.createToken(db, { name: "x", scopes: [], createdBy: "h" })).rejects.toThrow(/at least one scope/);
    await expect(tokens.createToken(db, { name: " ", scopes: ["feed:read"], createdBy: "h" })).rejects.toThrow(/name/);
  });
});

describe("event paging, daily usage, project stats", () => {
  it("filters by lane, before and after", async () => {
    await events.writeEvent(db, { kind: "issue.opened", actor: "human:a", project: "web", issue: 1, summary: "one", ts: "2026-03-01T10:00:00Z" });
    await events.writeEvent(db, { kind: "issue.labeled", actor: "human:a", project: "web", issue: 1, lane: "claude", summary: "agent:claude", ts: "2026-03-01T11:00:00Z" });
    await events.writeEvent(db, { kind: "run.started", actor: "runner:mini", project: "web", issue: 1, lane: "claude", summary: "run", ts: "2026-03-01T12:00:00Z" });
    await events.writeEvent(db, { kind: "step.usage", actor: "agent:claude", project: "web", issue: 1, lane: "claude", model: "anthropic/claude-fable-5-1", subscription: "max", tokens_in: 100, tokens_out: 10, cache_read: 900, cost_equiv: 0.2, duration_ms: 5, summary: "call", ts: "2026-03-01T12:30:00Z" });
    await events.writeEvent(db, { kind: "step.usage", actor: "agent:codex", project: "web", issue: 1, lane: "codex", model: "openai/gpt-5.5", subscription: "codex", tokens_in: 50, tokens_out: 5, cost_equiv: 0.05, duration_ms: 5, summary: "call", ts: "2026-03-02T09:00:00Z" });
    await events.writeEvent(db, { kind: "issue.opened", actor: "human:a", project: "web", issue: 2, summary: "two", ts: "2026-03-02T10:00:00Z" });
    await events.writeEvent(db, { kind: "issue.closed", actor: "human:a", project: "web", issue: 1, summary: "closed one", ts: "2026-03-02T11:00:00Z" });
    await memory.addDecision(db, { project: "web", text: "We page the feed by timestamp because ids are not monotonic across drivers", source: "human" });

    expect((await events.listEvents(db, { project: "web", lane: "codex" })).map((e) => e.kind)).toEqual(["step.usage"]);
    const older = await events.listEvents(db, { project: "web", before: "2026-03-01T12:00:00Z" });
    expect(older.map((e) => e.ts)).toEqual(["2026-03-01T11:00:00.000Z", "2026-03-01T10:00:00.000Z"]);
    const newer = await events.listEvents(db, { project: "web", after: "2026-03-02T10:00:00Z" });
    expect(newer.map((e) => e.kind)).toEqual(["issue.closed"]);
  });

  it("rolls usage up per UTC day and subscription", async () => {
    const days = await events.usageDaily(db, "2026-02-01T00:00:00Z");
    expect(days).toEqual([
      { day: "2026-03-01", subscription: "max", calls: 1, tokens_in: 100, tokens_out: 10, cache_read: 900, cost_equiv: 0.2 },
      { day: "2026-03-02", subscription: "codex", calls: 1, tokens_in: 50, tokens_out: 5, cache_read: 0, cost_equiv: 0.05 },
    ]);
  });

  it("computes per-project stats in one query", async () => {
    await projects.upsertFileDigests(db, "web", [
      { path: "a.ts", sha256: "a1", size: 1 },
      { path: "b.ts", sha256: "b1", size: 1 },
    ]);
    await projects.setFileSummaries(db, "web", [{ path: "a.ts", summary: "a", tokens: 1, sha256: "a1" }]);
    const stats = await projects.projectStats(db);
    const web = stats.find((s) => s.slug === "web");
    expect(web).toEqual({ slug: "web", last_activity: "2026-03-02T11:00:00.000Z", open_issues: 1, decisions: 1, digested: 1, total: 2, lanes: ["claude", "codex"] });
    expect(stats.find((s) => s.slug === "quiet")).toEqual({ slug: "quiet", last_activity: null, open_issues: 0, decisions: 0, digested: 0, total: 0, lanes: [] });
  });
});

describe("presigned uploads", () => {
  it("upload tokens are distinct from view tokens and verify only as uploads", async () => {
    const key = "web/x/a.txt";
    const up = await store.getUploadUrl(key, 60, { contentType: "text/plain" });
    expect(up).toContain("op=put");
    const ok = verifyLocalUploadUrl(up, store);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.key).toBe(key);
    expect(verifyLocalSignedUrl(up, store).ok).toBe(false); // an upload token does not grant reads
    const view = await store.getSignedUrl(key, 60);
    expect(verifyLocalUploadUrl(view, store)).toEqual({ ok: false, reason: "not an upload url" });
    expect(verifyLocalUploadUrl(up.replace(/sig=./, "sig=Z"), store).ok).toBe(false);
    expect(verifyLocalUploadUrl(up, store, Date.now() + 120_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("builds and parses upload keys", () => {
    const id = ulid();
    const key = uploadKeyFor("web", id, "my mock.png");
    expect(key).toBe(`web/${id}/my_mock.png`);
    expect(parseUploadKey(key)).toEqual({ project: "web", id, filename: "my_mock.png" });
    expect(parseUploadKey(uploadKeyFor(null, id, "x.pdf"))).toEqual({ project: null, id, filename: "x.pdf" });
    expect(parseUploadKey("web/not-a-ulid/x.png")).toBeUndefined();
    expect(parseUploadKey(`web/${id}`)).toBeUndefined();
    expect(parseUploadKey(`web/${id}/a/b`)).toBeUndefined();
  });

  it("finalizeFromKey probes the uploaded bytes and records the row under the key's id", async () => {
    const id = ulid();
    const key = uploadKeyFor("web", id, "render.png");
    await store.put(key, png(12, 9), { contentType: "application/octet-stream" });
    const row = await finalizeFromKey(db, store, { key, project: "web", issue: 3, title: "Render", createdBy: "bot:codex", tags: ["ui"] });
    expect(row.id).toBe(id);
    expect(row.storage_key).toBe(key);
    expect(row.kind).toBe("image");
    expect(row.width).toBe(12);
    expect(row.height).toBe(9);
    expect(row.issue).toBe(3);
    expect(row.title).toBe("Render");
    expect(row.status).toBe("pending");
    expect(await store.read(key)).toEqual(png(12, 9));
    const ev = await events.listEvents(db, { kind: "asset.uploaded", project: "web" });
    expect(ev[0]?.payload.asset_id).toBe(id);
  });

  it("finalizeFromKey refuses missing uploads, wrong projects and bad keys", async () => {
    const id = ulid();
    await expect(finalizeFromKey(db, store, { key: uploadKeyFor("web", id, "x.png"), project: "web", createdBy: "h" })).rejects.toThrow(/nothing was uploaded/);
    await expect(finalizeFromKey(db, store, { key: uploadKeyFor("web", id, "x.png"), project: "other", createdBy: "h" })).rejects.toThrow(/belongs to project/);
    await expect(finalizeFromKey(db, store, { key: "web/junk", project: "web", createdBy: "h" })).rejects.toBeInstanceOf(IngestError);
    const empty = uploadKeyFor("web", ulid(), "empty.png");
    await store.put(empty, Buffer.alloc(0), { contentType: "image/png" });
    await expect(finalizeFromKey(db, store, { key: empty, project: "web", createdBy: "h" })).rejects.toThrow(/empty/);
    expect(await store.exists(empty)).toBe(false);
  });

  it("finalizeFromKey as a new version inherits from the parent", async () => {
    const first = (await assets.listAssets(db, { project: "web", kind: "image" }))[0]!;
    const id = ulid();
    const key = uploadKeyFor("web", id, "render-v2.png");
    await store.put(key, png(24, 18), { contentType: "image/png" });
    const v2 = await finalizeFromKey(db, store, { key, project: "web", replaces: first.id, createdBy: "bot:codex" });
    expect(v2.version).toBe(first.version + 1);
    expect(v2.title).toBe(first.title);
    expect(v2.issue).toBe(first.issue);
    expect((await assets.getAsset(db, first.id))?.status).toBe("superseded");
  });
});

describe("zip entries", () => {
  it("reads stored and deflated entries, misses cleanly, maps entry mimes", () => {
    const b = zip({ "site/index.html": { text: "<h1>hi</h1>" }, "site/app.js": { text: "console.log('x'.repeat(50))", deflate: true } });
    expect(readZipEntry(b, "site/index.html")?.toString()).toBe("<h1>hi</h1>");
    expect(readZipEntry(b, "site/app.js")?.toString()).toBe("console.log('x'.repeat(50))");
    expect(readZipEntry(b, "site/missing.css")).toBeUndefined();
    expect(() => readZipEntry(Buffer.from("nope"), "x")).toThrow(/not a zip/);
    expect(mimeForEntry("a/b.css")).toBe("text/css");
    expect(mimeForEntry("x.js")).toBe("text/javascript");
    expect(mimeForEntry("x.png")).toBe("image/png");
    expect(mimeForEntry("x.weird")).toBe("application/octet-stream");
  });
});
