"use server";

import { createInvite, decideDeviceRequest, isTokenScope, OAuthError, parseDuration, removeClient, repo, revokeInvite, TOKEN_SCOPES } from "@relay/core";
import { revalidatePath } from "next/cache";
import { dataMode } from "@/lib/data";
import { getDb } from "@/lib/db";
import { oauthOptions } from "@/lib/oauth";
import { viewerActor } from "@/lib/session";

/** Every action on the Access page answers with this; `token` and `code` are the show-once secrets. */
export interface TokenActionResult {
  ok: boolean;
  message?: string;
  /** The plaintext, present once after a successful create. */
  token?: string;
  /** The invite code, present once after a successful invite. */
  code?: string;
  name?: string;
}

const NO_DB: TokenActionResult = { ok: false, message: "This needs a database; the deployment runs on demo data." };
const SIGNED_OUT: TokenActionResult = { ok: false, message: "Your session has ended. Sign in again." };

/** The signed-in viewer as an actor, or undefined when the session is gone. */
async function actor(): Promise<string | undefined> {
  try {
    return await viewerActor();
  } catch {
    return undefined;
  }
}

const describe = (e: unknown): string => (e instanceof OAuthError ? e.description : e instanceof Error ? e.message : String(e));

/** Mint a token for the signed-in viewer. The plaintext goes back to the browser once and is never stored. */
export async function createTokenAction(name: string, scopes: string[]): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the token a name, e.g. ci-runner." };
  const chosen = [...new Set(scopes.map((s) => s.trim()).filter(isTokenScope))];
  if (!chosen.length) return { ok: false, message: `Pick at least one scope (${TOKEN_SCOPES.join(", ")}).` };
  const by = await actor();
  if (!by) return SIGNED_OUT;
  const { token, row } = await repo.createToken(await getDb(), { name: trimmed, scopes: chosen, createdBy: by });
  revalidatePath("/tokens");
  return { ok: true, token, name: row.name };
}

export async function revokeTokenAction(id: string): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  if (!(await actor())) return SIGNED_OUT;
  const row = await repo.revokeToken(await getDb(), id);
  if (!row) return { ok: false, message: "That token is already revoked." };
  revalidatePath("/tokens");
  return { ok: true, name: row.name };
}

/** Approve or deny a device request inline; the same core call /activate makes, so the feed row is the same. */
export async function decideAccessAction(code: string, decision: "approve" | "deny"): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  const by = await actor();
  if (!by) return SIGNED_OUT;
  try {
    const row = await decideDeviceRequest(await getDb(), code, decision, by, oauthOptions());
    revalidatePath("/tokens");
    revalidatePath("/activate");
    return { ok: true, name: row.client_name };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}

export interface InviteInput {
  name: string;
  scopes: string[];
  /** A duration like "24h" or "7d"; empty for the default (24 h). */
  expiresIn: string;
  uses: number;
}

/** Mint an invite; the code is in the result and nowhere else. */
export async function createInviteAction(input: InviteInput): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Say who the invite is for, e.g. woodhouse; its token will be named oauth:<name>." };
  const scopes = [...new Set(input.scopes.map((s) => s.trim()).filter(isTokenScope))];
  if (!scopes.length) return { ok: false, message: "Pick at least one scope." };
  const expires = input.expiresIn.trim() ? parseDuration(input.expiresIn) : undefined;
  if (input.expiresIn.trim() && !expires) return { ok: false, message: "Expires in must be a duration like 24h or 7d." };
  const by = await actor();
  if (!by) return SIGNED_OUT;
  try {
    const r = await createInvite(await getDb(), { name, scopes, ...(expires ? { expiresInSeconds: expires } : {}), uses: Number.isInteger(input.uses) && input.uses > 0 ? input.uses : 1, createdBy: by }, oauthOptions());
    revalidatePath("/tokens");
    return { ok: true, code: r.code, name: r.invite.name };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}

export async function revokeInviteAction(id: string): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  const by = await actor();
  if (!by) return SIGNED_OUT;
  const row = await revokeInvite(await getDb(), id, by, oauthOptions());
  if (!row) return { ok: false, message: "That invite is already revoked." };
  revalidatePath("/tokens");
  return { ok: true, name: row.name };
}

/** Remove an OAuth client nothing live depends on; the core guard refuses otherwise. */
export async function removeClientAction(clientId: string): Promise<TokenActionResult> {
  if (dataMode() !== "db") return NO_DB;
  const by = await actor();
  if (!by) return SIGNED_OUT;
  try {
    const row = await removeClient(await getDb(), clientId, by, oauthOptions());
    revalidatePath("/tokens");
    return { ok: true, name: row.name };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}
