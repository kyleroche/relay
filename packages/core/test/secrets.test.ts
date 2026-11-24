/**
 * Where a granted capability set's values come from (work/secrets.ts), with a stand-in for the Vercel CLI: the
 * worker's own environment first, then the project's development environment, and nothing left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv, vercelSecrets } from "../src/work/secrets.ts";

let tmp: string;
let fake: string;
let calls: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-secrets-"));
  calls = join(tmp, "calls.log");
  fake = join(tmp, "vercel");
  // records how it was called and where, and on `env pull` writes what a project's development environment holds
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$PWD|$*" >> "${calls}"
if [ "$1" = "link" ] && [ "$4" = "no-such-project" ]; then echo "Error: Project not found" >&2; exit 1; fi
if [ "$1" = "env" ]; then printf 'BLOB_TOKEN="blob-from-vercel"\\nSHOP_TOKEN="line one\\\\nline two"\\nVERCEL_OIDC_TOKEN="never-handed-on"\\nUNRELATED=x\\n' > .env; fi
`,
  );
  chmodSync(fake, 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseDotenv", () => {
  it("reads plain, quoted and escaped values, and skips what is not an assignment", () => {
    expect(parseDotenv('A=1\nB="two words"\nC="a\\nb"\nD=\'single\'\n# a comment\nexport E=5\nF="quote \\" inside"\nnot a line\nG=plain # trailing\n')).toEqual({ A: "1", B: "two words", C: "a\nb", D: "single", E: "5", F: 'quote " inside', G: "plain" });
  });
});

describe("vercelSecrets", () => {
  it("takes a name from the worker's own environment first and never calls Vercel when nothing is missing", async () => {
    process.env.RELAY_TEST_LOCAL = "from-this-machine";
    try {
      const found = await vercelSecrets({ bin: fake })({ project: "store", names: ["RELAY_TEST_LOCAL"], vercel: { project: "store" } });
      expect(found).toEqual({ RELAY_TEST_LOCAL: "from-this-machine" });
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.RELAY_TEST_LOCAL;
    }
  });

  it("reads the rest from the project's development environment, keeps only the granted names, and leaves nothing behind", async () => {
    const found = await vercelSecrets({ bin: fake })({ project: "store", names: ["BLOB_TOKEN", "SHOP_TOKEN", "NOT_SET_ANYWHERE"], vercel: { project: "store", team: "acme" } });
    expect(found).toEqual({ BLOB_TOKEN: "blob-from-vercel", SHOP_TOKEN: "line one\nline two" });
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines.map((l) => l.split("|")[1])).toEqual(["link --yes --project store --scope acme", "env pull .env --yes --environment=development --scope acme"]);
    // the scratch directory it pulled into is gone, with the file that held every value
    const scratch = lines[0]!.split("|")[0]!;
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(tmp).sort()).toEqual(["calls.log", "vercel"]);
  });

  it("without a project in the profile, or without the CLI, says what it found or why it could not look", async () => {
    expect(await vercelSecrets({ bin: fake })({ project: "store", names: ["BLOB_TOKEN"], vercel: null })).toEqual({});
    // a pull that fails keeps what the worker's own environment gave, and says why the rest is missing
    const said: string[] = [];
    process.env.RELAY_TEST_FROM_ENV = "from-the-environment";
    try {
      const found = await vercelSecrets({ bin: fake, log: (l) => said.push(l) })({ project: "store", names: ["RELAY_TEST_FROM_ENV", "BLOB_TOKEN"], vercel: { project: "no-such-project" } });
      expect(found).toEqual({ RELAY_TEST_FROM_ENV: "from-the-environment" });
      expect(said).toEqual([expect.stringMatching(/^BLOB_TOKEN not read from the Vercel project no-such-project: vercel link failed: Error: Project not found/)]);
    } finally {
      delete process.env.RELAY_TEST_FROM_ENV;
    }
  });
});
