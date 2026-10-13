/**
 * Pure-JS media sniffing for ingest: mime by magic bytes then extension, kind from mime, image dimensions from
 * PNG/JPEG/GIF/WebP headers, and zip central-directory listing (to validate HTML bundles). No native deps.
 */
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { AssetKind } from "../db/assets.ts";

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

const ascii = (b: Buffer, start: number, len: number) => b.subarray(start, start + len).toString("latin1");

/** Mime from the first bytes; undefined when no known signature matches. */
export function sniffMagic(b: Buffer): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)) return "application/zip";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm"; // EBML; Matroska shares it, treated as webm
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A ") return "audio/mp4";
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "video/mp4"; // isom, iso2, mp41, mp42, M4V , avc1, ...
  }
  return undefined;
}

/** Mime by magic bytes, falling back to the extension, then application/octet-stream. */
export function sniffMime(bytes: Buffer, filename?: string): string {
  const magic = sniffMagic(bytes);
  if (magic) return magic;
  if (filename) {
    const m = EXT_MIME[extname(filename).toLowerCase()];
    if (m) return m;
  }
  return "application/octet-stream";
}

export function kindForMime(mime: string, opts: { htmlBundle?: boolean } = {}): AssetKind {
  if (opts.htmlBundle) return "html";
  if (mime === "text/html") return "html";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Width/height from PNG, JPEG, GIF or WebP headers; undefined for anything else or a truncated header. */
export function imageDimensions(b: Buffer, mime: string = sniffMagic(b) ?? ""): Dimensions | undefined {
  try {
    switch (mime) {
      case "image/png":
        return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : undefined;
      case "image/gif":
        return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : undefined;
      case "image/jpeg":
        return jpegDimensions(b);
      case "image/webp":
        return webpDimensions(b);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function jpegDimensions(b: Buffer): Dimensions | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xda || marker === 0xd9) return undefined; // start of scan / end: no SOF seen
    i += 2 + len;
  }
  return undefined;
}

function webpDimensions(b: Buffer): Dimensions | undefined {
  if (b.length < 30) return undefined;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // lossy: frame tag (3 bytes) + start code 9d 01 2a + 14-bit width/height
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // canvas size: 24-bit little-endian minus one, at offsets 24 and 27
    return { width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
  }
  return undefined;
}

/** Entry names from a zip's central directory (needs the whole file). Throws when the directory cannot be found. */
export function zipEntryNames(b: Buffer): string[] {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const minEocd = 22;
  if (b.length < minEocd) throw new Error("not a zip: too small");
  let eocd = -1;
  for (let i = b.length - minEocd; i >= Math.max(0, b.length - minEocd - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip64 archives are not supported");
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== CEN) throw new Error("corrupt zip central directory");
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    names.push(b.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * An HTML bundle is a zip with `index.html` at the root or inside a single top-level folder. Returns the entry path
 * of that index, or undefined when the zip is not a bundle.
 */
export function htmlBundleIndex(names: string[]): string | undefined {
  if (names.includes("index.html")) return "index.html";
  const tops = new Set(names.map((n) => n.split("/")[0]).filter(Boolean));
  if (tops.size === 1) {
    const [top] = [...tops];
    const idx = `${top}/index.html`;
    if (names.includes(idx)) return idx;
  }
  return undefined;
}

const ENTRY_MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
};

/** Content type for an HTML bundle entry by extension; octet-stream when unknown. */
export function mimeForEntry(name: string): string {
  const ext = extname(name).toLowerCase();
  return ENTRY_MIME[ext] ?? EXT_MIME[ext] ?? "application/octet-stream";
}

/**
 * The bytes of one entry in a zip (stored or deflate), located through the central directory so a local header's
 * data descriptor never matters. Undefined when the entry is missing. Throws on zip64 or an unknown method.
 */
export function readZipEntry(b: Buffer, name: string): Buffer | undefined {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const LOC = 0x04034b50;
  const minEocd = 22;
  if (b.length < minEocd) throw new Error("not a zip: too small");
  let eocd = -1;
  for (let i = b.length - minEocd; i >= Math.max(0, b.length - minEocd - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error("zip64 archives are not supported");
  for (let n = 0; n < count; n++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== CEN) throw new Error("corrupt zip central directory");
    const method = b.readUInt16LE(off + 10);
    const csize = b.readUInt32LE(off + 20);
    const usize = b.readUInt32LE(off + 24);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const entryName = b.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== LOC) throw new Error("corrupt zip local header");
    const start = localOff + 30 + b.readUInt16LE(localOff + 26) + b.readUInt16LE(localOff + 28);
    const data = b.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) {
      const out = inflateRawSync(data);
      if (out.length !== usize) throw new Error("zip entry size mismatch");
      return out;
    }
    throw new Error(`unsupported zip compression method ${method}`);
  }
  return undefined;
}
