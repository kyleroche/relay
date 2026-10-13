/**
 * Turn a file into an asset row: sniff the mime and kind, hash and measure it, read image dimensions from the
 * header, ask `ffprobe` (when on PATH) for video dimensions and duration, render a thumbnail (sharp for images,
 * ffmpeg poster frame for video, both optional and never fatal), write the bytes to the store, then the row.
 *
 * Storage keys: `<project>/<asset id>/<sanitised filename>` and `<project>/<asset id>/thumb.<ext>`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Db } from "../db/client.ts";
import { type AssetRow, type AssetKind, createAsset, newVersion } from "../db/assets.ts";
import { htmlBundleIndex, imageDimensions, kindForMime, sniffMime, zipEntryNames } from "./media.ts";
import type { AssetStore } from "./store.ts";
import { type Log, ulid } from "../util.ts";

export interface IngestInput {
  /** Read the bytes from this path (filename taken from it unless `filename` is given)... */
  path?: string;
  /** ...or use these bytes directly. */
  buffer?: Buffer;
  /** Name to store under and to sniff by extension; required with `buffer`. */
  filename?: string;
  project: string | null;
  issue?: number | null;
  pr?: number | null;
  /** Default: the parent's title when `replaces` is set, else the filename. */
  title?: string;
  description?: string | null;
  /** Id of the asset this one supersedes; the new row becomes the next version. */
  replaces?: string | null;
  createdBy: string;
  tags?: string[];
  /** Longest thumbnail edge in pixels. */
  thumbSize?: number;
  log?: Log;
}

export interface Probe {
  mime: string;
  kind: AssetKind;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** For kind=html stored as zip: the index entry inside the archive. */
  htmlIndex: string | null;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

const MAX_THUMB = 512;

export function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function run(bin: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) =>
      res({ code: err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr).toString("utf8") }),
    );
  });
}

/** A temp copy of the bytes for tools that want a path; the caller removes the directory. */
function tempFile(bytes: Buffer, filename: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-asset-"));
  const file = join(dir, basename(filename) || "asset");
  writeFileSync(file, bytes);
  return { dir, file };
}

/** `ffprobe` dimensions and duration for a video or audio file. undefined when ffprobe is absent or fails. */
export async function ffprobe(file: string): Promise<{ width: number | null; height: number | null; durationMs: number | null } | undefined> {
  const bin = onPath("ffprobe");
  if (!bin) return undefined;
  const r = await run(bin, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]);
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.toString("utf8")) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
    const v = j.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
    const dur = Number(j.format?.duration);
    return { width: v?.width ?? null, height: v?.height ?? null, durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : null };
  } catch {
    return undefined;
  }
}

/** Resize an image with `sharp` when it is installed; undefined otherwise. Output is webp. */
export async function imageThumbnail(bytes: Buffer, max = MAX_THUMB): Promise<{ bytes: Buffer; mime: string; ext: string } | undefined> {
  const name = "sharp"; // variable so tsc never needs the optional package's types
  let sharp: ((input: Buffer) => { resize(o: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): { webp(o: { quality: number }): { toBuffer(): Promise<Buffer> } } }) | undefined;
  try {
    const mod = (await import(name)) as { default?: unknown } & Record<string, unknown>;
    sharp = (mod.default ?? mod) as typeof sharp;
  } catch {
    return undefined;
  }
  if (typeof sharp !== "function") return undefined;
  try {
    const out = await sharp(bytes).resize({ width: max, height: max, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { bytes: out, mime: "image/webp", ext: "webp" };
  } catch {
    return undefined;
  }
}

/** First-second poster frame via `ffmpeg` when on PATH; undefined otherwise. Output is jpeg. */
export async function videoPoster(file: string, max = MAX_THUMB): Promise<{ bytes: Buffer; mime: string; ext: string } | undefined> {
  const bin = onPath("ffmpeg");
  if (!bin) return undefined;
  const r = await run(bin, ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", `scale='min(${max},iw)':-2`, "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], 60_000);
  if (r.code !== 0 || !r.stdout.length) {
    // short clips: retry from the first frame
    const r2 = await run(bin, ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale='min(${max},iw)':-2`, "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], 60_000);
    if (r2.code !== 0 || !r2.stdout.length) return undefined;
    return { bytes: r2.stdout, mime: "image/jpeg", ext: "jpg" };
  }
  return { bytes: r.stdout, mime: "image/jpeg", ext: "jpg" };
}

/** Everything ingest learns about the bytes before storing them. Pure except for the optional ffprobe call. */
export async function probeBytes(bytes: Buffer, filename: string, opts: { pathForTools?: string } = {}): Promise<Probe> {
  const mime = sniffMime(bytes, filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let htmlIndex: string | null = null;
  if (mime === "application/zip") {
    let names: string[];
    try {
      names = zipEntryNames(bytes);
    } catch (e) {
      throw new IngestError(`zip could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    htmlIndex = htmlBundleIndex(names) ?? null;
  }
  const kind = kindForMime(mime, { htmlBundle: htmlIndex !== null });
  const probe: Probe = { mime, kind, size: bytes.length, sha256, width: null, height: null, durationMs: null, htmlIndex };
  if (kind === "image") {
    const d = imageDimensions(bytes, mime);
    if (d) Object.assign(probe, d);
  } else if (kind === "video" || kind === "audio") {
    const tmp = opts.pathForTools ? undefined : tempFile(bytes, filename);
    try {
      const p = await ffprobe(opts.pathForTools ?? tmp!.file);
      if (p) Object.assign(probe, p);
    } finally {
      if (tmp) rmSync(tmp.dir, { recursive: true, force: true });
    }
  }
  return probe;
}

/** Keep the basename, replace anything outside [A-Za-z0-9._-], never empty, never a dotfile. */
export function safeFilename(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return base || "asset";
}

/**
 * Ingest one file. Reads bytes, probes them, writes original and thumbnail to the store, then the row (as a new
 * version when `replaces` is set). A missing thumbnail tool only costs the thumbnail. Returns the stored row.
 */
export async function ingestFile(db: Db, store: AssetStore, input: IngestInput): Promise<AssetRow> {
  const log = input.log ?? (() => {});
  if (!input.path && !input.buffer) throw new IngestError("ingestFile needs path or buffer");
  const bytes = input.buffer ?? (await readFile(input.path!));
  const filename = safeFilename(input.filename ?? (input.path ? basename(input.path) : "asset"));
  if (!bytes.length) throw new IngestError("file is empty");

  const probe = await probeBytes(bytes, filename, input.path ? { pathForTools: input.path } : {});
  if (probe.mime === "application/zip" && !probe.htmlIndex) log(`zip has no index.html; storing as kind=file`);

  const id = ulid();
  const prefix = `${input.project ?? "_"}/${id}`;
  const storageKey = `${prefix}/${filename}`;
  await store.put(storageKey, bytes, { contentType: probe.mime });
  log(`stored ${storageKey} (${probe.mime}, ${probe.size} bytes)`);

  let thumbKey: string | null = null;
  try {
    let thumb: { bytes: Buffer; mime: string; ext: string } | undefined;
    if (probe.kind === "image" && probe.mime !== "image/svg+xml") thumb = await imageThumbnail(bytes, input.thumbSize ?? MAX_THUMB);
    else if (probe.kind === "video") {
      const tmp = input.path ? undefined : tempFile(bytes, filename);
      try {
        thumb = await videoPoster(input.path ?? tmp!.file, input.thumbSize ?? MAX_THUMB);
      } finally {
        if (tmp) rmSync(tmp.dir, { recursive: true, force: true });
      }
    }
    if (thumb) {
      thumbKey = `${prefix}/thumb.${thumb.ext}`;
      await store.put(thumbKey, thumb.bytes, { contentType: thumb.mime });
    } else if (probe.kind === "image" || probe.kind === "video") log(`no thumbnail (${probe.kind === "image" ? "sharp not installed" : "ffmpeg not on PATH"} or unsupported input)`);
  } catch (e) {
    log(`thumbnail skipped: ${e instanceof Error ? e.message : String(e)}`);
    thumbKey = null;
  }

  // undefined (not null) for the optional fields so a new version inherits them from its parent
  const row = {
    id,
    project: input.project,
    issue: input.issue,
    pr: input.pr,
    description: input.description,
    kind: probe.kind,
    mime: probe.mime,
    size: probe.size,
    sha256: probe.sha256,
    storageKey,
    thumbKey,
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    createdBy: input.createdBy,
    tags: input.tags,
  };
  try {
    return input.replaces ? await newVersion(db, input.replaces, { ...row, title: input.title }) : await createAsset(db, { ...row, title: input.title ?? filename });
  } catch (e) {
    // the row failed: do not leave orphan bytes behind
    await store.delete(storageKey).catch(() => {});
    if (thumbKey) await store.delete(thumbKey).catch(() => {});
    throw e;
  }
}
