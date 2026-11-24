/**
 * What `relay adopt` reads through: a handful of file operations, injected, so the plan is a pure function of what
 * they answer and tests need neither a home directory nor a gigabyte of transcripts. Paths are absolute.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";

export interface AdoptFs {
  /** The names in a directory, sorted; empty when it is not one. */
  list(dir: string): string[];
  /** A file's text; undefined when it is not there. */
  read(path: string): string | undefined;
  /** A file's size in bytes; undefined when it is not there. */
  size(path: string): number | undefined;
  isDir(path: string): boolean;
  /** A file's bytes in order, a piece at a time: a transcript can be larger than memory. */
  chunks(path: string): AsyncIterable<Uint8Array>;
}

export function diskAdoptFs(): AdoptFs {
  const stat = (path: string) => {
    try {
      return statSync(path);
    } catch {
      return undefined;
    }
  };
  return {
    list: (dir) => (stat(dir)?.isDirectory() ? readdirSync(dir).sort() : []),
    read: (path) => (existsSync(path) && stat(path)?.isFile() ? readFileSync(path, "utf8") : undefined),
    size: (path) => (stat(path)?.isFile() ? stat(path)!.size : undefined),
    isDir: (path) => !!stat(path)?.isDirectory(),
    chunks: (path) => createReadStream(path),
  };
}

/** A line longer than this is not a tool call (an attachment, a pasted image, a tool's output) and is dropped unread. */
export const MAX_TRANSCRIPT_LINE = 4 * 1024 * 1024;

/**
 * The lines of a stream, one at a time and still as bytes (the caller decodes the few it wants), holding at most one
 * line and never more than `maxLine` bytes of it: a line that grows past the limit is skipped up to its newline.
 * Returns how many lines were seen and how many were skipped.
 */
export async function eachLine(chunks: AsyncIterable<Uint8Array>, onLine: (line: Buffer) => void, maxLine: number = MAX_TRANSCRIPT_LINE): Promise<{ lines: number; skipped: number }> {
  let parts: Uint8Array[] = [];
  let held = 0;
  let skipping = false;
  let lines = 0;
  let skipped = 0;
  const end = (): void => {
    lines++;
    if (skipping) skipped++;
    else if (held) onLine(parts.length === 1 ? Buffer.from(parts[0]!.buffer, parts[0]!.byteOffset, parts[0]!.byteLength) : Buffer.concat(parts));
    parts = [];
    held = 0;
    skipping = false;
  };
  for await (const chunk of chunks) {
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      const piece = chunk.subarray(from, nl === -1 ? chunk.length : nl);
      if (!skipping) {
        if (held + piece.length > maxLine) {
          skipping = true;
          parts = [];
          held = 0;
        } else if (piece.length) {
          parts.push(piece);
          held += piece.length;
        }
      }
      if (nl === -1) break;
      end();
      from = nl + 1;
    }
  }
  if (held || skipping) end();
  return { lines, skipped };
}
