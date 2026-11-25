/**
 * A project's profile as the site reads it (lib/profile.ts): `.relay/project.json` from GitHub's contents API,
 * parsed by core. The GitHub here answers from memory.
 */
import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubClient } from "@relay/core";
import { fetchProfile, parseProfile } from "../lib/profile.ts";

const file = (json: unknown) => ({ encoding: "base64", content: Buffer.from(typeof json === "string" ? json : JSON.stringify(json)).toString("base64").replace(/(.{60})/g, "$1\n") });

/** A GitHub whose one answer is `answer`, remembering what it was asked. */
function github(answer: Record<string, unknown> | Error): GitHubClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    request: async (method: string, path: string) => {
      asked.push(`${method} ${path}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as GitHubClient & { asked: string[] };
}

describe("fetchProfile", () => {
  it("reads the file from the repository's default branch and says what its sets hold: names only", async () => {
    const gh = github(file({ sets: { deploy: { env: ["VERCEL_ORG", "DEPLOY_HOOK"], hosts: ["api.example.com", "*.example.org"] } }, cloud: "never", verify: ["pnpm test"] }));
    const r = await fetchProfile(gh, "acme/demo");
    expect(gh.asked).toEqual(["GET /repos/acme/demo/contents/.relay/project.json"]);
    expect(r.profile).toMatchObject({ sets: { deploy: { env: ["VERCEL_ORG", "DEPLOY_HOOK"], hosts: ["api.example.com", "*.example.org"] } }, cloud: "never", verify: ["pnpm test"] });
    expect(r.why).toBeUndefined();
  });

  it("is the empty profile, with why in one line, when the repository has no such file", async () => {
    const r = await fetchProfile(github(new GitHubError("Not Found", 404)), "acme/demo");
    expect(r.profile).toMatchObject({ sets: {}, cloud: "ask" });
    expect(r.why).toBe("acme/demo has no .relay/project.json on its default branch, so it defines no capability sets.");
  });

  it("is no profile at all when GitHub cannot be asked: nobody knows what the file says", async () => {
    const r = await fetchProfile(github(new GitHubError("Resource not accessible by integration", 403)), "acme/demo");
    expect(r.profile).toBeUndefined();
    expect(r.why).toMatch(/GitHub could not read \.relay\/project\.json of acme\/demo: Resource not accessible/);
    expect((await fetchProfile(github({ type: "dir" }), "acme/demo")).profile).toBeUndefined();
  });

  it("leaves out what the file gets wrong and names it", async () => {
    const r = await fetchProfile(github(file({ sets: { ok: { env: ["A_NAME"], hosts: [] }, bad: { env: ["a value, not a name"], hosts: [] } }, cloud: "sometimes" })), "acme/demo");
    expect(Object.keys(r.profile!.sets)).toEqual(["ok"]);
    expect(r.profile!.cloud).toBe("ask");
    expect(r.why).toMatch(/acme\/demo:\.relay\/project\.json: set 'bad'.*cloud must be ask or never/);
  });

  it("reads a file that is not JSON as a profile with nothing in it, and says so", () => {
    const r = parseProfile("acme/demo", "{ not json");
    expect(r.profile).toMatchObject({ sets: {}, cloud: "ask" });
    expect(r.why).toMatch(/is not usable/);
  });
});
