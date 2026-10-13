import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as projects from "../src/db/projects.ts";
import * as events from "../src/db/events.ts";
import * as memory from "../src/db/memory.ts";
import * as assets from "../src/db/assets.ts";
import { LocalStore, verifyLocalSignedUrl, PublishUnsupportedError } from "../src/assets/store.ts";
import { ingestFile, probeBytes, safeFilename } from "../src/assets/ingest.ts";
import { purgeExpiredAssets, previewExpiredAssets } from "../src/assets/index.ts";
import { imageDimensions, sniffMime, zipEntryNames, htmlBundleIndex } from "../src/assets/media.ts";
import { ulid } from "../src/util.ts";

// ---------- fixtures, generated here so the repo carries no binaries ----------

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

/** A valid RGB PNG of the given size (solid colour). */
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter none
    for (let x = 0; x < width; x++) raw.set([200, 30, 90], y * (1 + width * 3) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A stored (uncompressed) zip with the given entries. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameB = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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
const DAY = 86_400_000;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "relay-home-"));
  process.env.RELAY_HOME = home;
  delete process.env.RELAY_ASSET_SIGNING_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  store = new LocalStore(join(home, "assets"));
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await projects.upsertProject(db, { slug: "demo", path: "/tmp/demo" });
});
afterAll(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("media sniffing", () => {
  it("reads PNG dimensions and mime", () => {
    const b = png(7, 5);
    expect(sniffMime(b, "x.bin")).toBe("image/png");
    expect(imageDimensions(b)).toEqual({ width: 7, height: 5 });
  });
  it("reads GIF, JPEG and WebP headers", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([0x10, 0x00, 0x20, 0x00, 0, 0, 0])]);
    expect(imageDimensions(gif)).toEqual({ width: 16, height: 32 });
    // SOI, APP0 (length 16), SOF0 with height 300 width 400
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03]), Buffer.alloc(9),
    ]);
    expect(sniffMime(jpeg)).toBe("image/jpeg");
    expect(imageDimensions(jpeg)).toEqual({ width: 400, height: 300 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.set([0x9d, 0x01, 0x2a], 23);
    webp.writeUInt16LE(640, 26);
    webp.writeUInt16LE(360, 28);
    expect(imageDimensions(webp)).toEqual({ width: 640, height: 360 });
  });
  it("falls back to the extension, then octet-stream", () => {
    expect(sniffMime(Buffer.from("hello"), "a.mp4")).toBe("video/mp4");
    expect(sniffMime(Buffer.from("hello"), "a.unknown")).toBe("application/octet-stream");
  });
  it("lists zip entries and spots an HTML bundle", () => {
    const names = zipEntryNames(zip({ "site/index.html": "<h1>hi</h1>", "site/a.css": "b{}" }));
    expect(names).toEqual(["site/index.html", "site/a.css"]);
    expect(htmlBundleIndex(names)).toBe("site/index.html");
    expect(htmlBundleIndex(["index.html", "x/y"])).toBe("index.html");
    expect(htmlBundleIndex(["a/index.html", "b/index.html"])).toBeUndefined();
  });
  it("probes an html bundle vs a plain zip", async () => {
    const bundle = await probeBytes(zip({ "index.html": "<p>x</p>" }), "site.zip");
    expect(bundle.kind).toBe("html");
    expect(bundle.mime).toBe("application/zip");
    expect(bundle.htmlIndex).toBe("index.html");
    const plain = await probeBytes(zip({ "notes.txt": "x" }), "notes.zip");
    expect(plain.kind).toBe("file");
    expect(plain.htmlIndex).toBeNull();
  });
  it("sanitises filenames", () => {
    expect(safeFilename("../../etc/pass wd?.png")).toBe("pass_wd_.png");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("///")).toBe("asset");
  });
  it("makes sortable ulids", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("local store signed urls", () => {
  it("signs, verifies, rejects tampering and expiry", async () => {
    await store.put("demo/x/a.txt", Buffer.from("hello"), { contentType: "text/plain" });
    expect(await store.exists("demo/x/a.txt")).toBe(true);
    const url = await store.getSignedUrl("demo/x/a.txt", 60);
    expect(url.startsWith("file://")).toBe(true);
    expect(existsSync(join(home, "assets", ".signing-key"))).toBe(true); // created on first sign
    const ok = verifyLocalSignedUrl(url, store);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.key).toBe("demo/x/a.txt");
      expect(readFileSync(ok.path, "utf8")).toBe("hello");
    }
    expect(verifyLocalSignedUrl(url.replace(/sig=./, "sig=Z"), store).ok).toBe(false);
    expect(verifyLocalSignedUrl(url.replace("a.txt", "b.txt"), store).ok).toBe(false);
    expect(verifyLocalSignedUrl(url, store, Date.now() + 120_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyLocalSignedUrl("file:///etc/passwd?exp=1&sig=x", store).ok).toBe(false);
    await store.delete("demo/x/a.txt");
    expect(await store.exists("demo/x/a.txt")).toBe(false);
  });
  it("refuses unsafe keys", async () => {
    await expect(store.put("../escape", Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow(/unsafe/);
    await expect(store.put("/abs", Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow(/unsafe/);
  });
  it("cannot publish", async () => {
    await expect(store.publish("demo/x/a.txt", { contentType: "text/plain" })).rejects.toBeInstanceOf(PublishUnsupportedError);
  });
});

describe("ingest, versions, review, expiry", () => {
  let v1: assets.AssetRow;
  let v2: assets.AssetRow;

  it("ingests a PNG: sniff, hash, dimensions, bytes in the store, asset.uploaded event", async () => {
    const bytes = png(40, 24);
    v1 = await ingestFile(db, store, { buffer: bytes, filename: "mock up.png", project: "demo", issue: 7, title: "Mockup", createdBy: "bot:grok", tags: ["ux"] });
    expect(v1.kind).toBe("image");
    expect(v1.mime).toBe("image/png");
    expect(v1.width).toBe(40);
    expect(v1.height).toBe(24);
    expect(v1.size).toBe(bytes.length);
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.version).toBe(1);
    expect(v1.status).toBe("pending");
    expect(v1.storage_key).toBe(`demo/${v1.id}/mock_up.png`);
    expect(v1.tags).toEqual(["ux"]);
    expect(await store.exists(v1.storage_key)).toBe(true);
    if (v1.thumb_key) {
      expect(v1.thumb_key).toBe(`demo/${v1.id}/thumb.webp`);
      expect(await store.exists(v1.thumb_key)).toBe(true);
    }
    const ev = await events.listEvents(db, { kind: "asset.uploaded" });
    expect(ev[0]?.actor).toBe("bot:grok");
    expect(ev[0]?.issue).toBe(7);
    expect(ev[0]?.payload.asset_id).toBe(v1.id);
    expect((await assets.getAsset(db, v1.id))?.title).toBe("Mockup");
  });

  it("ingests from a path too", async () => {
    const p = join(home, "from-disk.png");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, png(3, 3));
    const a = await ingestFile(db, store, { path: p, project: "demo", title: "disk", createdBy: "human:test" });
    expect(a.width).toBe(3);
    expect(a.storage_key.endsWith("/from-disk.png")).toBe(true);
    await assets.reviewAsset(db, a.id, { decision: "approved", by: "human:test" });
  });

  it("stores a new version and supersedes the parent", async () => {
    v2 = await ingestFile(db, store, { buffer: png(80, 48), filename: "mockup-v2.png", project: "demo", title: "Mockup", replaces: v1.id, createdBy: "bot:grok" });
    expect(v2.version).toBe(2);
    expect(v2.parent_id).toBe(v1.id);
    expect(v2.issue).toBe(7); // inherited
    const parent = await assets.getAsset(db, v1.id);
    expect(parent?.status).toBe("superseded");
    expect(parent?.expires_at).not.toBeNull();
    const chain = await assets.listVersions(db, v2.id);
    expect(chain.map((c) => c.version)).toEqual([1, 2]);
    expect((await assets.listVersions(db, v1.id)).map((c) => c.id)).toEqual([v1.id, v2.id]);
    await expect(ingestFile(db, store, { buffer: png(1, 1), filename: "x.png", project: "demo", title: "x", replaces: "nope", createdBy: "h" })).rejects.toBeInstanceOf(assets.AssetNotFoundError);
  });

  it("lists with filters, pending first", async () => {
    const all = await assets.listAssets(db, { project: "demo" });
    expect(all[0]?.status).toBe("pending");
    expect((await assets.listAssets(db, { project: "demo", status: "superseded" })).map((a) => a.id)).toEqual([v1.id]);
    expect((await assets.listAssets(db, { kind: "video" })).length).toBe(0);
    expect((await assets.listAssets(db, { issue: 7 })).length).toBe(2);
  });

  it("rejecting writes asset.reviewed and a review decision", async () => {
    const r = await assets.reviewAsset(db, v2.id, { decision: "rejected", by: "human:kyle", note: "Logo is off-brand; use the blue mark." });
    expect(r.status).toBe("rejected");
    expect(r.reviewed_by).toBe("human:kyle");
    expect(r.expires_at).not.toBeNull();
    const ev = await events.listEvents(db, { kind: "asset.reviewed" });
    expect(ev[0]?.summary).toContain("rejected: Mockup");
    expect(ev[0]?.summary).toContain("blue mark");
    expect(ev[0]?.payload.decision).toBe("rejected");
    const d = (await memory.listDecisions(db, "demo", { current: true })).find((x) => x.source_ref === v2.id);
    expect(d?.source).toBe("review");
    expect(d?.text).toContain("blue mark");
  });

  it("approving clears expiry and writes an event without a decision", async () => {
    const before = (await memory.listDecisions(db, "demo")).length;
    const v3 = await ingestFile(db, store, { buffer: png(80, 48), filename: "mockup-v3.png", project: "demo", title: "Mockup", replaces: v2.id, createdBy: "bot:grok" });
    const r = await assets.reviewAsset(db, v3.id, { decision: "approved", by: "human:kyle" });
    expect(r.status).toBe("approved");
    expect(r.expires_at).toBeNull();
    expect((await memory.listDecisions(db, "demo")).length).toBe(before);
    await expect(assets.reviewAsset(db, "missing", { decision: "approved", by: "x" })).rejects.toBeInstanceOf(assets.AssetNotFoundError);
  });

  it("publishAsset records the url and event", async () => {
    const a = await ingestFile(db, store, { buffer: png(2, 2), filename: "pub.png", project: "demo", title: "pub", createdBy: "h" });
    const p = await assets.publishAsset(db, a.id, "https://example.test/pub.png", { by: "human:kyle" });
    expect(p.status).toBe("published");
    expect(p.public_url).toBe("https://example.test/pub.png");
    const ev = await events.listEvents(db, { kind: "asset.published" });
    expect(ev[0]?.url).toBe("https://example.test/pub.png");
    expect(ev[0]?.actor).toBe("human:kyle");
  });

  it("expires rejected and superseded rows past retention, deleting bytes", async () => {
    expect(await previewExpiredAssets(db)).toEqual([]);
    const later = new Date(Date.now() + 31 * DAY);
    const due = await previewExpiredAssets(db, later);
    expect(due.map((a) => a.id).sort()).toEqual([v1.id, v2.id].sort());
    const keys = [v1.storage_key, v2.storage_key];
    for (const k of keys) expect(await store.exists(k)).toBe(true);

    const r = await purgeExpiredAssets(db, store, later);
    expect(r.failedKeys).toEqual([]);
    expect(r.removed.map((x) => x.id).sort()).toEqual([v1.id, v2.id].sort());
    for (const k of keys) expect(await store.exists(k)).toBe(false);
    expect(await assets.getAsset(db, v1.id)).toBeUndefined();
    // the surviving v3 keeps its row; its parent link is nulled, not cascaded
    const v3 = (await assets.listAssets(db, { project: "demo", status: "approved" })).find((a) => a.title === "Mockup");
    expect(v3?.parent_id).toBeNull();
    expect(await previewExpiredAssets(db, later)).toEqual([]);
  });

  it("rolls back the bytes when the row cannot be written", async () => {
    await expect(ingestFile(db, store, { buffer: png(1, 1), filename: "orphan.png", project: "no-such-project", title: "x", createdBy: "h" })).rejects.toThrow();
    const dir = join(home, "assets", "no-such-project");
    const { readdirSync } = await import("node:fs"); // the project folder may remain, but it must hold no files
    expect(existsSync(dir) ? readdirSync(dir).flatMap((d) => readdirSync(join(dir, d))) : []).toEqual([]);
  });
});
