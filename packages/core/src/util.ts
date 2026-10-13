import { createHash, randomBytes } from "node:crypto";

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
/** Rough token estimate (≈4 chars/token). Good enough for caps and budgets; the ledger records real counts. */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);
export const nowIso = (): string => new Date().toISOString();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export type Log = (msg: string) => void;
export const noopLog: Log = () => {};

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID (26 chars, Crockford base32): 48-bit ms timestamp + 80 random bits. Lexically sortable by creation time. */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ULID_ALPHABET[bytes[i]! % 32];
  return time + rand;
}
