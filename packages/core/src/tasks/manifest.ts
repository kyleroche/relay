/**
 * The nodes lane's manifest: a fenced ```relay-nodes block in the issue body naming a Griptape Nodes workflow file in
 * the task's repository, the inputs for its start node(s) and, optionally, which end nodes count as outputs. The body
 * is data typed by a GitHub user, so everything here is pure parsing and validation with no file access; the job
 * resolves the workflow inside its clone (`work/job.ts`).
 *
 *   ```relay-nodes
 *   workflow: workflows/cutscene.py          # repo-relative, must end in .py, no `..`
 *   inputs:                                   # { <node name>: { <parameter>: value } }, for the flow's start nodes
 *     Start Flow:
 *       prompt: "A rain-slicked street at night"
 *       duration: 8
 *   outputs: [End Flow]                       # optional: only these end nodes become assets (default: every end node)
 *   model: bytedance/seedance-2.0             # optional: the model id the usage rows carry when the node type is unknown
 *   stage: cutscene                           # optional: a tag on the assets
 *   ```
 *
 * The block is JSON or the YAML subset `parseYamlSubset` reads (nested mappings by indentation, `- ` lists, inline
 * `[a, b]` lists and `{...}` JSON values, quoted or bare scalars). No YAML library: a dependency this small is not
 * worth one, and the subset is what a person types into an issue.
 */

export interface NodesManifest {
  /** Repository-relative path of the workflow file (posix separators, normalised). */
  workflow: string;
  /** `{ nodeName: { parameter: value } }`, passed as the flow input. */
  inputs: Record<string, Record<string, unknown>>;
  /** End nodes whose parameters become assets; every end node when omitted. */
  outputs?: string[];
  /** Model id for the usage rows when the workflow's node types are not in the adapter's table. */
  model?: string;
  /** A production stage name, tagged onto the assets. */
  stage?: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export const MANIFEST_FENCE = "relay-nodes";
const KNOWN_KEYS = new Set(["workflow", "inputs", "outputs", "model", "stage"]);

/**
 * The text inside the first ```<fence> block (`relay-nodes` by default; `relay-job` for app workers, `job-manifest.ts`),
 * or undefined when the body has none.
 */
export function extractManifestBlock(body: string, fence: string = MANIFEST_FENCE): string | undefined {
  const name = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*(\`{3,}|~{3,})[ \\t]*${name}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\\1[ \\t]*$`, "m").exec(body ?? "");
  return m ? m[2] : undefined;
}

/** True when the body carries a manifest block (whether or not it parses). */
export const hasManifest = (body: string): boolean => extractManifestBlock(body) !== undefined;

/**
 * Parse the manifest out of an issue body. Throws `ManifestError` with a sentence an operator can act on when the
 * block is missing, unreadable or names something the lane cannot run.
 */
export function parseNodesManifest(body: string): NodesManifest {
  const block = extractManifestBlock(body);
  if (block === undefined) throw new ManifestError("the issue has no ```relay-nodes block; the nodes lane needs one naming the workflow file and its inputs");
  return manifestFromValue(parseManifestText(block));
}

/** Parse the block's text as JSON when it starts with `{`, else as the YAML subset. `fence` names the block in errors. */
export function parseManifestText(text: string, fence: string = MANIFEST_FENCE): unknown {
  const t = text.trim();
  if (!t) throw new ManifestError(`the ${fence} block is empty`);
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch (e) {
      throw new ManifestError(`the ${fence} block is not valid JSON: ${(e as Error).message}`);
    }
  }
  return parseYamlSubset(t, fence);
}

/** Validate a parsed object into a manifest. */
export function manifestFromValue(v: unknown): NodesManifest {
  if (!isRecord(v)) throw new ManifestError("the relay-nodes block must be a mapping with a `workflow` key");
  const unknown = Object.keys(v).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw new ManifestError(`unknown key${unknown.length > 1 ? "s" : ""} in the relay-nodes block: ${unknown.join(", ")} (allowed: ${[...KNOWN_KEYS].join(", ")})`);
  const workflow = normalizeWorkflowPath(v.workflow);
  const inputs: Record<string, Record<string, unknown>> = {};
  if (v.inputs !== undefined && v.inputs !== null) {
    if (!isRecord(v.inputs)) throw new ManifestError("`inputs` must be a mapping of node name to parameter values");
    for (const [node, params] of Object.entries(v.inputs)) {
      if (!node.trim()) throw new ManifestError("`inputs` has an empty node name");
      if (!isRecord(params)) throw new ManifestError(`inputs.${node} must be a mapping of parameter name to value`);
      inputs[node] = { ...params };
    }
  }
  const out: NodesManifest = { workflow, inputs };
  if (v.outputs !== undefined && v.outputs !== null) {
    const list = Array.isArray(v.outputs) ? v.outputs : typeof v.outputs === "string" ? [v.outputs] : undefined;
    if (!list || !list.every((s) => typeof s === "string" && s.trim())) throw new ManifestError("`outputs` must be a list of end-node names");
    out.outputs = list.map((s) => (s as string).trim());
  }
  if (v.model !== undefined && v.model !== null) {
    if (typeof v.model !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(v.model)) throw new ManifestError("`model` must be a `provider/model` id, e.g. bytedance/seedance-2.0");
    out.model = v.model;
  }
  if (v.stage !== undefined && v.stage !== null) {
    if (typeof v.stage !== "string" || !v.stage.trim() || v.stage.length > 64) throw new ManifestError("`stage` must be a short name");
    out.stage = v.stage.trim();
  }
  return out;
}

/** A repository-relative `.py` path: forward slashes, no leading slash, no drive, no `..` segment, no empty segment. */
export function normalizeWorkflowPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ManifestError("`workflow` is required: the repository-relative path of the workflow .py file");
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new ManifestError(`\`workflow\` must be relative to the repository, not ${p}`);
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) throw new ManifestError(`\`workflow\` may not contain '..' or empty segments: ${p}`);
  if (!p.endsWith(".py")) throw new ManifestError(`\`workflow\` must be a Griptape Nodes workflow file ending in .py: ${p}`);
  return p;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- the YAML subset ----------

interface Line {
  indent: number;
  text: string;
  no: number;
}

/**
 * Mappings nested by indentation, `- ` block lists, inline `[a, b]` lists, `{...}`/`[...]` JSON values, quoted
 * strings, numbers, booleans and null; `#` comments outside quotes. Anchors, multi-line scalars, flow mappings with
 * YAML (not JSON) syntax and tabs are refused with a line number.
 */
export function parseYamlSubset(text: string, fence: string = MANIFEST_FENCE): unknown {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.includes("\t")) throw new ManifestError(`line ${i + 1}: tabs are not allowed in the ${fence} block; indent with spaces`);
    const stripped = stripComment(raw);
    if (!stripped.trim()) return;
    lines.push({ indent: raw.length - raw.trimStart().length, text: stripped.trim(), no: i + 1 });
  });
  if (!lines.length) throw new ManifestError(`the ${fence} block is empty`);
  const [value, next] = parseNode(lines, 0, lines[0]!.indent);
  if (next !== lines.length) throw new ManifestError(`line ${lines[next]!.no}: unexpected indentation`);
  return value;
}

function parseNode(lines: Line[], i: number, indent: number): [unknown, number] {
  const first = lines[i]!;
  if (first.text.startsWith("- ") || first.text === "-") return parseList(lines, i, indent);
  return parseMapping(lines, i, indent);
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new ManifestError(`line ${line.no}: unexpected indentation`);
    if (line.text.startsWith("- ")) throw new ManifestError(`line ${line.no}: a list item where a key was expected`);
    const kv = splitKey(line.text, line.no);
    if (kv.key in out) throw new ManifestError(`line ${line.no}: duplicate key '${kv.key}'`);
    i++;
    if (kv.rest === "") {
      // a nested block, or an empty value
      const child = lines[i];
      if (child && child.indent > indent) {
        const [v, next] = parseNode(lines, i, child.indent);
        out[kv.key] = v;
        i = next;
      } else if (child && child.indent === indent && (child.text.startsWith("- ") || child.text === "-")) {
        // YAML allows a list at the key's own indentation
        const [v, next] = parseList(lines, i, indent);
        out[kv.key] = v;
        i = next;
      } else out[kv.key] = null;
    } else out[kv.key] = parseScalar(kv.rest, line.no);
  }
  return [out, i];
}

function parseList(lines: Line[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new ManifestError(`line ${line.no}: unexpected indentation`);
    if (!(line.text.startsWith("- ") || line.text === "-")) break;
    const item = line.text.slice(1).trim();
    i++;
    if (item === "") {
      const child = lines[i];
      if (child && child.indent > indent) {
        const [v, next] = parseNode(lines, i, child.indent);
        out.push(v);
        i = next;
      } else out.push(null);
    } else if (/^[^"'[{][^:]*:(\s|$)/.test(item)) {
      // `- key: value` starts an inline mapping whose further keys sit two columns in
      const kv = splitKey(item, line.no);
      const obj: Record<string, unknown> = { [kv.key]: kv.rest === "" ? null : parseScalar(kv.rest, line.no) };
      const child = lines[i];
      if (child && child.indent > indent) {
        const [more, next] = parseMapping(lines, i, child.indent);
        Object.assign(obj, more);
        i = next;
      }
      out.push(obj);
    } else out.push(parseScalar(item, line.no));
  }
  return [out, i];
}

function splitKey(text: string, no: number): { key: string; rest: string } {
  let key: string;
  let rest: string;
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0]!;
    const end = text.indexOf(q, 1);
    if (end < 0 || text[end + 1] !== ":") throw new ManifestError(`line ${no}: expected \`key: value\``);
    key = text.slice(1, end);
    rest = text.slice(end + 2);
  } else {
    const m = /^([^:\[\]{}"']+?):(?:\s+|$)([\s\S]*)$/.exec(text);
    if (!m) throw new ManifestError(`line ${no}: expected \`key: value\``);
    key = m[1]!.trim();
    rest = m[2] ?? "";
  }
  if (!key) throw new ManifestError(`line ${no}: empty key`);
  return { key, rest: rest.trim() };
}

function parseScalar(s: string, no: number): unknown {
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch {
      // `[a, b]` with bare words: an inline list of scalars
      if (s.startsWith("[") && s.endsWith("]")) {
        const inner = s.slice(1, -1).trim();
        return inner ? splitInline(inner, no).map((x) => parseScalar(x, no)) : [];
      }
      throw new ManifestError(`line ${no}: inline value must be JSON (quote the strings): ${s}`);
    }
  }
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new ManifestError(`line ${no}: unterminated or malformed double-quoted string`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new ManifestError(`line ${no}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("&") || s.startsWith("*") || s.startsWith("|") || s.startsWith(">")) throw new ManifestError(`line ${no}: anchors and block scalars are not supported: ${s}`);
  return s;
}

/** Split `a, "b, c", d` on top-level commas. */
function splitInline(s: string, no: number): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (quote) throw new ManifestError(`line ${no}: unterminated quote in inline list`);
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

/** Drop a ` # comment` outside quotes (a `#` glued to text, as in a URL fragment, stays). */
function stripComment(raw: string): string {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) return raw.slice(0, i);
  }
  return raw;
}
