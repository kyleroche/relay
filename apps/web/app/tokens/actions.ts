"use server";

import { isTokenScope, repo, TOKEN_SCOPES } from "@relay/core";
import { revalidatePath } from "next/cache";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { viewerActor } from "@/lib/session";

export interface TokenActionResult {
  ok: boolean;
  message?: string;
  /** The plaintext, present once after a successful create. */
  token?: string;
  name?: string;
}

/** Mint a token for the signed-in viewer. The plaintext goes back to the browser once and is never stored. */
export async function createTokenAction(name: string, scopes: string[]): Promise<TokenActionResult> {
  if (dataMode() !== "db") return { ok: false, message: "Tokens need a database; this deployment runs on demo data." };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the token a name, e.g. grok-bot." };
  const chosen = [...new Set(scopes.map((s) => s.trim()).filter(isTokenScope))];
  if (!chosen.length) return { ok: false, message: `Pick at least one scope (${TOKEN_SCOPES.join(", ")}).` };
  let by: string;
  try {
    by = await viewerActor();
  } catch {
    return { ok: false, message: "Your session has ended. Sign in again." };
  }
  const { token, row } = await repo.createToken(await getDb(), { name: trimmed, scopes: chosen, createdBy: by });
  revalidatePath("/tokens");
  return { ok: true, token, name: row.name };
}

export async function revokeTokenAction(id: string): Promise<TokenActionResult> {
  if (dataMode() !== "db") return { ok: false, message: "Tokens need a database; this deployment runs on demo data." };
  try {
    await viewerActor();
  } catch {
    return { ok: false, message: "Your session has ended. Sign in again." };
  }
  const row = await repo.revokeToken(await getDb(), id);
  if (!row) return { ok: false, message: "That token is already revoked." };
  revalidatePath("/tokens");
  return { ok: true, name: row.name };
}
