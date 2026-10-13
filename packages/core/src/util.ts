import { createHash } from "node:crypto";

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
/** Rough token estimate (≈4 chars/token). Good enough for caps and budgets; the ledger records real counts. */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);
export const nowIso = (): string => new Date().toISOString();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export type Log = (msg: string) => void;
export const noopLog: Log = () => {};
