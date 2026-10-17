import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { demoSession, isAllowedUser, mintSession, parseAllowedUsers, SESSION_TTL_SECONDS, sessionActor, sessionSecretOk, verifySession } from "../lib/session-token.ts";

const SECRET = "test-session-secret-at-least-16-chars";
const USER = { login: "Octocat", name: "The Octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231" };

describe("session tokens", () => {
  it("mints a 30-day HS256 JWT carrying login, name, avatar_url, iat and exp", async () => {
    const now = Date.UTC(2026, 0, 1);
    const token = await mintSession(USER, SECRET, now);
    const claims = decodeJwt(token);
    expect(token.split(".")[0]).toBe(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"));
    expect(claims).toMatchObject({ login: "Octocat", name: "The Octocat", avatar_url: USER.avatar_url, iss: "relay" });
    expect(claims.iat).toBe(now / 1000);
    expect(claims.exp).toBe(now / 1000 + SESSION_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("verifies what it minted and rejects everything else", async () => {
    const now = Date.UTC(2026, 0, 1);
    const token = await mintSession(USER, SECRET, now);
    const session = await verifySession(token, SECRET, now + 1000);
    expect(session).toEqual({ login: "Octocat", name: "The Octocat", avatar_url: USER.avatar_url, iat: now / 1000, exp: now / 1000 + SESSION_TTL_SECONDS });
    expect(session && sessionActor(session)).toBe("human:Octocat");

    await expect(verifySession(token, "another-secret-of-enough-length-for-hs256", now)).resolves.toBeNull();
    await expect(verifySession(token, SECRET, now + (SESSION_TTL_SECONDS + 120) * 1000)).resolves.toBeNull();
    await expect(verifySession(`${token}x`, SECRET, now)).resolves.toBeNull();
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...decodeJwt(token), login: "mallory" })).toString("base64url")}.${s}`;
    await expect(verifySession(forged, SECRET, now)).resolves.toBeNull();
    await expect(verifySession(undefined, SECRET, now)).resolves.toBeNull();
    await expect(verifySession(token, undefined, now)).resolves.toBeNull();
    await expect(verifySession(token, "short", now)).resolves.toBeNull();
  });

  it("rotates on every sign-in", async () => {
    const a = await mintSession(USER, SECRET, Date.UTC(2026, 0, 1));
    const b = await mintSession(USER, SECRET, Date.UTC(2026, 0, 1, 0, 0, 1));
    expect(a).not.toBe(b);
  });

  it("refuses a short secret when minting", async () => {
    await expect(mintSession(USER, "short")).rejects.toThrow(/RELAY_SESSION_SECRET/);
    // 32 characters is the floor, and the error says how to make one
    await expect(mintSession(USER, "x".repeat(31))).rejects.toThrow(/at least 32 characters.*openssl rand -hex 32/);
    expect(sessionSecretOk("x".repeat(31))).toBe(false);
    expect(sessionSecretOk("x".repeat(32))).toBe(true);
    const now = Date.UTC(2026, 0, 1);
    const minted = await mintSession(USER, "x".repeat(32), now);
    await expect(verifySession(minted, "x".repeat(32), now)).resolves.not.toBeNull();
    await expect(verifySession(minted, "x".repeat(31), now)).resolves.toBeNull();
  });

  it("nulls optional fields", async () => {
    const token = await mintSession({ login: "x", name: null, avatar_url: null }, SECRET);
    expect(await verifySession(token, SECRET)).toMatchObject({ login: "x", name: null, avatar_url: null });
  });
});

describe("allowlist", () => {
  it("is comma-separated and case-insensitive", () => {
    expect(parseAllowedUsers(" Kyle, octocat ,,")).toEqual(["kyle", "octocat"]);
    expect(isAllowedUser("KYLE", "kyle,octocat")).toBe(true);
    expect(isAllowedUser("Octocat", "kyle, OCTOCAT")).toBe(true);
    expect(isAllowedUser("mallory", "kyle,octocat")).toBe(false);
  });

  it("denies everyone when empty", () => {
    expect(parseAllowedUsers(undefined)).toEqual([]);
    expect(isAllowedUser("kyle", undefined)).toBe(false);
    expect(isAllowedUser("kyle", " , ")).toBe(false);
  });
});

describe("demo session", () => {
  it("is human:demo and flagged", () => {
    const s = demoSession();
    expect(sessionActor(s)).toBe("human:demo");
    expect(s.demo).toBe(true);
  });
});
