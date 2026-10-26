/**
 * The app worker's manifest: a fenced ```relay-job block in the issue body that tells an external app's agent (an
 * embroidery digitizer, a laser cutter's driver; docs/WORKER-AGENTS.md) which assets it works from, the parameters
 * in the lane's own vocabulary and the outputs it is expected to upload. The lane itself comes from the issue's
 * `agent:<lane>` label; `lane` here is informational. The fence extraction and the YAML subset are the nodes lane's
 * (`manifest.ts`); only the shape differs.
 *
 *   ```relay-job
 *   lane: embroidery                     # optional, informational (the label is authoritative)
 *   inputs:                              # asset ids on this project, optionally named
 *     - asset: 01J…                      # or a bare string id
 *       as: artwork
 *   params:                              # free: the lane's own vocabulary
 *     hoop: 130x180
 *     format: [pes, dst]
 *     max_colors: 8
 *   outputs:                             # what the worker is expected to upload (names, for the summary)
 *     - { name: stitch-file, format: pes }
 *     - { name: preview, format: png }
 *   ```
 *
 * `parseJobManifest` is pure (the body is data typed by a GitHub user); `resolveJobInputs` looks the input assets up
 * and signs a URL for each, which is what a claim hands the worker.
 */
import type { Db } from "../db/client.ts";
import { getAsset, type AssetKind } from "../db/assets.ts";
import type { AssetStore } from "../assets/store.ts";
import { extractManifestBlock, isRecord, ManifestError, parseManifestText } from "./manifest.ts";

export const JOB_FENCE = "relay-job";
const KNOWN_KEYS = new Set(["lane", "inputs", "params", "outputs"]);
/** A lane name as the label carries it; the registry decides which exist. */
const LANE_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_INPUTS = 32;
const MAX_OUTPUTS = 32;
const MAX_PARAMS_BYTES = 16_000;

export interface JobInput {
  /** The asset id (`relay_asset_list`, the library). */
  asset: string;
  /** The name the lane's vocabulary gives this input (`artwork`), when the manifest named it. */
  as?: string;
}

export interface JobOutput {
  /** What the worker calls the deliverable (`stitch-file`, `preview`). */
  name: string;
  /** A file format or extension (`pes`, `png`), when the manifest named one. */
  format?: string;
}

export interface JobManifest {
  /** Informational; the issue's `agent:<lane>` label is what the scheduler matches. */
  lane?: string;
  inputs: JobInput[];
  /** Free parameters in the lane's own vocabulary, as given (JSON values). */
  params: Record<string, unknown>;
  outputs: JobOutput[];
}

/** An input asset as a claim hands it to the worker: the row's facts and a signed URL to read the bytes. */
export interface ResolvedJobInput {
  id: string;
  as: string | null;
  kind: AssetKind;
  mime: string;
  title: string;
  version: number;
  size: number;
  /** A signed read URL, valid for the ttl the resolver was given. */
  url: string;
}

/** True when the body carries a ```relay-job block (whether or not it parses). */
export const hasJobManifest = (body: string): boolean => extractManifestBlock(body ?? "", JOB_FENCE) !== undefined;

/**
 * The manifest in an issue body, or undefined when the body has no ```relay-job block (a job without one is just the
 * prose). Throws `ManifestError` with a line to fix on bad content; unknown keys are errors so a typo never passes
 * as "no parameters".
 */
export function parseJobManifest(body: string): JobManifest | undefined {
  const block = extractManifestBlock(body ?? "", JOB_FENCE);
  if (block === undefined) return undefined;
  return jobManifestFromValue(parseManifestText(block, JOB_FENCE));
}

/** Validate a parsed object into a job manifest. */
export function jobManifestFromValue(v: unknown): JobManifest {
  if (!isRecord(v)) throw new ManifestError(`the ${JOB_FENCE} block must be a mapping (inputs, params, outputs, lane)`);
  const unknown = Object.keys(v).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw new ManifestError(`unknown key${unknown.length > 1 ? "s" : ""} in the ${JOB_FENCE} block: ${unknown.join(", ")} (allowed: ${[...KNOWN_KEYS].join(", ")})`);
  const out: JobManifest = { inputs: [], params: {}, outputs: [] };
  if (v.lane !== undefined && v.lane !== null) {
    if (typeof v.lane !== "string" || !LANE_SHAPE.test(v.lane)) throw new ManifestError("`lane` must be a lane name: lowercase letters, digits and dashes, e.g. embroidery");
    out.lane = v.lane;
  }
  if (v.inputs !== undefined && v.inputs !== null) {
    const list = Array.isArray(v.inputs) ? v.inputs : typeof v.inputs === "string" ? [v.inputs] : undefined;
    if (!list) throw new ManifestError("`inputs` must be a list of asset ids, or of { asset, as } entries");
    if (list.length > MAX_INPUTS) throw new ManifestError(`\`inputs\` lists ${list.length} assets; at most ${MAX_INPUTS}`);
    const names = new Set<string>();
    const ids = new Set<string>();
    list.forEach((item, i) => {
      const input = jobInputFrom(item, i + 1);
      if (ids.has(input.asset)) throw new ManifestError(`inputs[${i + 1}]: asset ${input.asset} is listed twice`);
      ids.add(input.asset);
      if (input.as) {
        if (names.has(input.as)) throw new ManifestError(`inputs[${i + 1}]: the name '${input.as}' is used twice`);
        names.add(input.as);
      }
      out.inputs.push(input);
    });
  }
  if (v.params !== undefined && v.params !== null) {
    if (!isRecord(v.params)) throw new ManifestError("`params` must be a mapping of parameter name to value");
    const bytes = JSON.stringify(v.params).length;
    if (bytes > MAX_PARAMS_BYTES) throw new ManifestError(`\`params\` is ${bytes} bytes of JSON; at most ${MAX_PARAMS_BYTES}`);
    for (const k of Object.keys(v.params)) if (!k.trim()) throw new ManifestError("`params` has an empty parameter name");
    out.params = { ...v.params };
  }
  if (v.outputs !== undefined && v.outputs !== null) {
    const list = Array.isArray(v.outputs) ? v.outputs : typeof v.outputs === "string" ? [v.outputs] : undefined;
    if (!list) throw new ManifestError("`outputs` must be a list of names, or of { name, format } entries");
    if (list.length > MAX_OUTPUTS) throw new ManifestError(`\`outputs\` lists ${list.length} entries; at most ${MAX_OUTPUTS}`);
    const names = new Set<string>();
    list.forEach((item, i) => {
      const output = jobOutputFrom(item, i + 1);
      if (names.has(output.name)) throw new ManifestError(`outputs[${i + 1}]: the name '${output.name}' is used twice`);
      names.add(output.name);
      out.outputs.push(output);
    });
  }
  return out;
}

function jobInputFrom(item: unknown, n: number): JobInput {
  if (typeof item === "string") {
    if (!ASSET_ID.test(item)) throw new ManifestError(`inputs[${n}]: '${item}' is not an asset id`);
    return { asset: item };
  }
  if (!isRecord(item)) throw new ManifestError(`inputs[${n}] must be an asset id or { asset: <id>, as: <name> }`);
  const extra = Object.keys(item).filter((k) => k !== "asset" && k !== "as");
  if (extra.length) throw new ManifestError(`inputs[${n}]: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (allowed: asset, as)`);
  if (typeof item.asset !== "string" || !ASSET_ID.test(item.asset)) throw new ManifestError(`inputs[${n}]: \`asset\` must be an asset id`);
  const out: JobInput = { asset: item.asset };
  if (item.as !== undefined && item.as !== null) {
    if (typeof item.as !== "string" || !NAME.test(item.as)) throw new ManifestError(`inputs[${n}]: \`as\` must be a short name (letters, digits, dot, dash, underscore)`);
    out.as = item.as;
  }
  return out;
}

function jobOutputFrom(item: unknown, n: number): JobOutput {
  if (typeof item === "string") {
    if (!NAME.test(item)) throw new ManifestError(`outputs[${n}]: '${item}' is not a short name (letters, digits, dot, dash, underscore)`);
    return { name: item };
  }
  if (!isRecord(item)) throw new ManifestError(`outputs[${n}] must be a name or { name: <name>, format: <ext> }`);
  const extra = Object.keys(item).filter((k) => k !== "name" && k !== "format");
  if (extra.length) throw new ManifestError(`outputs[${n}]: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (allowed: name, format)`);
  if (typeof item.name !== "string" || !NAME.test(item.name)) throw new ManifestError(`outputs[${n}]: \`name\` must be a short name (letters, digits, dot, dash, underscore)`);
  const out: JobOutput = { name: item.name };
  if (item.format !== undefined && item.format !== null) {
    if (typeof item.format !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,15}$/.test(item.format)) throw new ManifestError(`outputs[${n}]: \`format\` must be a file format such as pes or png`);
    out.format = item.format.toLowerCase();
  }
  return out;
}

/**
 * The check `openTask` runs before an issue is opened: a `relay-job` block that parses, whose input assets exist and
 * belong to the project. Nothing is signed. Returns the manifest, or undefined when the body has no block; throws
 * `ManifestError` with the line to fix.
 */
export async function assertJobManifest(db: Db, body: string, project: string): Promise<JobManifest | undefined> {
  const manifest = parseJobManifest(body);
  if (!manifest) return undefined;
  for (const input of manifest.inputs) {
    const row = await getAsset(db, input.asset);
    if (!row) throw new ManifestError(`input asset ${input.asset} does not exist in the library`);
    if (row.project !== project) throw new ManifestError(`input asset ${input.asset} belongs to project '${row.project ?? "_"}', not '${project}'`);
  }
  return manifest;
}

export interface ResolveJobInputsOptions {
  /** Map the store's signed URL to what the caller can fetch (the web app's public view route); identity by default. */
  viewUrl?: (signedUrl: string, key: string) => string;
}

/**
 * Look every input asset up and sign a read URL for it (`ttl` seconds). Each must exist and belong to `project`;
 * otherwise a `ManifestError` names the id, since a job that reads the wrong project's files must not start.
 */
export async function resolveJobInputs(db: Db, store: Pick<AssetStore, "getSignedUrl">, manifest: JobManifest, project: string, ttl: number, opts: ResolveJobInputsOptions = {}): Promise<ResolvedJobInput[]> {
  const out: ResolvedJobInput[] = [];
  for (const input of manifest.inputs) {
    const row = await getAsset(db, input.asset);
    if (!row) throw new ManifestError(`input asset ${input.asset} does not exist in the library`);
    if (row.project !== project) throw new ManifestError(`input asset ${input.asset} belongs to project '${row.project ?? "_"}', not '${project}'`);
    const signed = await store.getSignedUrl(row.storage_key, ttl);
    out.push({
      id: row.id,
      as: input.as ?? null,
      kind: row.kind,
      mime: row.mime,
      title: row.title,
      version: row.version,
      size: row.size,
      url: opts.viewUrl ? opts.viewUrl(signed, row.storage_key) : signed,
    });
  }
  return out;
}
