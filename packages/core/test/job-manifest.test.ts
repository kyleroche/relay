/** The app worker's manifest (tasks/job-manifest.ts): the ```relay-job fence, its shape, every refusal, and input resolution against the library. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { LocalStore } from "../src/assets/store.ts";
import { hasJobManifest, JOB_FENCE, jobManifestFromValue, parseJobManifest, resolveJobInputs } from "../src/tasks/job-manifest.ts";
import { extractManifestBlock, ManifestError } from "../src/tasks/manifest.ts";

const body = (block: string, fence = "```") => `Digitize the logo for the left chest.\n\n${fence}relay-job\n${block}\n${fence}\n`;

describe("the relay-job fence", () => {
  it("is found by name and does not collide with the nodes fence", () => {
    expect(hasJobManifest(body("params: {}"))).toBe(true);
    expect(hasJobManifest("```relay-nodes\nworkflow: a.py\n```")).toBe(false);
    expect(extractManifestBlock("```relay-nodes\nworkflow: a.py\n```")).toBe("workflow: a.py");
    expect(extractManifestBlock(body("lane: embroidery", "~~~"), JOB_FENCE)).toBe("lane: embroidery");
    expect(parseJobManifest("prose only")).toBeUndefined();
    expect(parseJobManifest("")).toBeUndefined();
  });
});

describe("parseJobManifest", () => {
  it("reads the documented example", () => {
    const m = parseJobManifest(body(["lane: embroidery", "inputs:", "  - asset: 01JAAAAAAAAAAAAAAAAAAAAAAA", "    as: artwork", "  - 01JBBBBBBBBBBBBBBBBBBBBBBB", "params:", "  hoop: 130x180", "  format: [pes, dst]", "  max_colors: 8", "outputs:", '  - { "name": "stitch-file", "format": "pes" }', "  - name: preview", "    format: PNG"].join("\n")));
    expect(m).toEqual({
      lane: "embroidery",
      inputs: [{ asset: "01JAAAAAAAAAAAAAAAAAAAAAAA", as: "artwork" }, { asset: "01JBBBBBBBBBBBBBBBBBBBBBBB" }],
      params: { hoop: "130x180", format: ["pes", "dst"], max_colors: 8 },
      outputs: [{ name: "stitch-file", format: "pes" }, { name: "preview", format: "png" }],
    });
  });
  it("accepts JSON, a bare output name, and an empty block of defaults", () => {
    expect(parseJobManifest(body('{"inputs": ["01J1"], "outputs": ["preview"]}'))).toEqual({ inputs: [{ asset: "01J1" }], params: {}, outputs: [{ name: "preview" }] });
    expect(parseJobManifest(body("params:\n  depth: 2"))).toEqual({ inputs: [], params: { depth: 2 }, outputs: [] });
    expect(jobManifestFromValue({})).toEqual({ inputs: [], params: {}, outputs: [] });
  });
  it("names the problem: empty, bad JSON, unknown keys, bad lane, bad inputs, bad params, bad outputs, duplicates", () => {
    expect(() => parseJobManifest(body("  "))).toThrow(/relay-job block is empty/);
    expect(() => parseJobManifest(body('{"inputs": }'))).toThrow(/relay-job block is not valid JSON/);
    expect(() => parseJobManifest(body("input: [a]"))).toThrow(/unknown key in the relay-job block: input \(allowed: lane, inputs, params, outputs\)/);
    expect(() => parseJobManifest(body("- a"))).toThrow(/must be a mapping/);
    expect(() => parseJobManifest(body("lane: Embroidery"))).toThrow(/`lane` must be a lane name/);
    expect(() => parseJobManifest(body("inputs: 3"))).toThrow(/`inputs` must be a list/);
    expect(() => parseJobManifest(body("inputs:\n  - 'not an id!'"))).toThrow(/inputs\[1\]: 'not an id!' is not an asset id/);
    expect(() => parseJobManifest(body("inputs:\n  - asset: 01J1\n    name: x"))).toThrow(/inputs\[1\]: unknown key name/);
    expect(() => parseJobManifest(body("inputs:\n  - as: x"))).toThrow(/inputs\[1\]: `asset` must be an asset id/);
    expect(() => parseJobManifest(body("inputs:\n  - asset: 01J1\n    as: 'has space'"))).toThrow(/`as` must be a short name/);
    expect(() => parseJobManifest(body("inputs: [01J1, 01J1]"))).toThrow(/asset 01J1 is listed twice/);
    expect(() => parseJobManifest(body("inputs:\n  - asset: 01J1\n    as: art\n  - asset: 01J2\n    as: art"))).toThrow(/'art' is used twice/);
    expect(() => parseJobManifest(body("params: [1]"))).toThrow(/`params` must be a mapping/);
    expect(() => parseJobManifest(body("outputs: 1"))).toThrow(/`outputs` must be a list/);
    expect(() => parseJobManifest(body("outputs:\n  - format: pes"))).toThrow(/outputs\[1\]: `name` must be a short name/);
    expect(() => parseJobManifest(body("outputs:\n  - name: a\n    format: 'p e s'"))).toThrow(/`format` must be a file format/);
    expect(() => parseJobManifest(body("outputs: [a, a]"))).toThrow(/'a' is used twice/);
    expect(() => parseJobManifest(body("params:\n\tx: 1"))).toThrow(/tabs are not allowed in the relay-job block/);
    try {
      parseJobManifest(body("nope: 1"));
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
    }
  });
});

describe("resolveJobInputs", () => {
  let db: Db;
  let home: string;
  let store: LocalStore;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "relay-job-"));
    store = new LocalStore(join(home, "assets"));
    db = await openDb({ file: ":memory:" });
    await migrate(db);
    await repo.upsertProject(db, { slug: "stitch", repo: "acme/stitch", path: "/tmp/stitch" });
    await repo.upsertProject(db, { slug: "other", repo: "acme/other", path: "/tmp/other" });
  });
  afterAll(async () => {
    await db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const asset = (id: string, project: string) =>
    repo.createAsset(db, { id, project, title: `logo ${id}`, kind: "image", mime: "image/png", size: 3, sha256: id.padEnd(64, "0"), storageKey: `${project}/${id}/logo.png`, createdBy: "human:kyle" });

  it("signs a URL per input and carries the asset's facts and the manifest's name", async () => {
    await asset("01JART", "stitch");
    await asset("01JREF", "stitch");
    const m = parseJobManifest(body("inputs:\n  - asset: 01JART\n    as: artwork\n  - 01JREF"))!;
    const r = await resolveJobInputs(db, store, m, "stitch", 600, { viewUrl: (u, k) => `https://site.example/view/${k}?${new URL(u).searchParams.get("exp") ? "signed" : "plain"}` });
    expect(r.map((x) => [x.id, x.as, x.kind, x.mime, x.version])).toEqual([
      ["01JART", "artwork", "image", "image/png", 1],
      ["01JREF", null, "image", "image/png", 1],
    ]);
    expect(r[0]!.url).toBe("https://site.example/view/stitch/01JART/logo.png?signed");
    expect(r[0]!.title).toBe("logo 01JART");
    const plain = await resolveJobInputs(db, store, m, "stitch", 600);
    expect(plain[1]!.url.startsWith("file://")).toBe(true);
  });
  it("refuses a missing asset and one from another project, naming the id", async () => {
    await asset("01JOTHER", "other");
    await expect(resolveJobInputs(db, store, parseJobManifest(body("inputs: [01JNOPE]"))!, "stitch", 600)).rejects.toThrow(/input asset 01JNOPE does not exist/);
    await expect(resolveJobInputs(db, store, parseJobManifest(body("inputs: [01JOTHER]"))!, "stitch", 600)).rejects.toThrow(/input asset 01JOTHER belongs to project 'other', not 'stitch'/);
  });
});
