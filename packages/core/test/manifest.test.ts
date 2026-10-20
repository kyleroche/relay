/** The nodes lane's manifest (tasks/manifest.ts): the fenced block, the YAML subset, JSON, and every refusal an operator can act on. */
import { describe, it, expect } from "vitest";
import { extractManifestBlock, hasManifest, ManifestError, normalizeWorkflowPath, parseNodesManifest, parseYamlSubset } from "../src/tasks/manifest.ts";

const body = (block: string, fence = "```") => `Make the cutscene.\n\n${fence}relay-nodes\n${block}\n${fence}\n\n<!-- relay:task key=abc -->\n`;

describe("extractManifestBlock", () => {
  it("finds the first relay-nodes fence, with backticks or tildes, and ignores other fences", () => {
    expect(extractManifestBlock("```bash\nls\n```\n" + body("workflow: a.py"))).toBe("workflow: a.py");
    expect(extractManifestBlock(body("workflow: a.py", "~~~"))).toBe("workflow: a.py");
    expect(extractManifestBlock("no block here")).toBeUndefined();
    expect(hasManifest(body("x: 1"))).toBe(true);
    expect(hasManifest("")).toBe(false);
  });
  it("tolerates CRLF bodies from the GitHub API", () => {
    expect(extractManifestBlock("```relay-nodes\r\nworkflow: a.py\r\ninputs: {}\r\n```\r\n")).toBe("workflow: a.py\r\ninputs: {}");
  });
});

describe("parseYamlSubset", () => {
  it("reads nested mappings, lists, inline lists, JSON values, quoted and bare scalars, and comments", () => {
    const v = parseYamlSubset(
      [
        "workflow: workflows/cutscene.py   # the file",
        "inputs:",
        "  Start Flow:",
        "    prompt: \"A rain-slicked street, #noir\"",
        "    duration: 8",
        "    ratio: '16:9'",
        "    seed: -1",
        "    loop: false",
        "    refs: [a.png, \"b.png\"]",
        "    extra: {\"k\": [1, 2]}",
        "    nothing:",
        "outputs:",
        "  - End Flow",
        "  - Stills",
        "model: bytedance/seedance-2.0",
      ].join("\n"),
    );
    expect(v).toEqual({
      workflow: "workflows/cutscene.py",
      inputs: { "Start Flow": { prompt: "A rain-slicked street, #noir", duration: 8, ratio: "16:9", seed: -1, loop: false, refs: ["a.png", "b.png"], extra: { k: [1, 2] }, nothing: null } },
      outputs: ["End Flow", "Stills"],
      model: "bytedance/seedance-2.0",
    });
  });
  it("reads a list at the key's own indentation and list items that are mappings", () => {
    expect(parseYamlSubset("outputs:\n- a\n- b\nshots:\n  - name: one\n    len: 2\n  - name: two")).toEqual({ outputs: ["a", "b"], shots: [{ name: "one", len: 2 }, { name: "two" }] });
  });
  it("refuses tabs, bad indentation, duplicate keys and anchors with a line number", () => {
    expect(() => parseYamlSubset("a:\n\tb: 1")).toThrow(/line 2: tabs/);
    expect(() => parseYamlSubset("a: 1\n  b: 2")).toThrow(/line 2: unexpected indentation/);
    expect(() => parseYamlSubset("a: 1\na: 2")).toThrow(/line 2: duplicate key 'a'/);
    expect(() => parseYamlSubset("a: &x 1")).toThrow(/line 1: anchors/);
    expect(() => parseYamlSubset("a: \"open")).toThrow(/line 1: unterminated/);
    expect(() => parseYamlSubset("   ")).toThrow(/empty/);
  });
});

describe("parseNodesManifest", () => {
  it("accepts YAML and JSON blocks and normalises the workflow path", () => {
    const y = parseNodesManifest(body("workflow: ./workflows\\cutscene.py\ninputs:\n  Start Flow:\n    prompt: hi\noutputs: [End Flow]\nstage: cutscene"));
    expect(y).toEqual({ workflow: "workflows/cutscene.py", inputs: { "Start Flow": { prompt: "hi" } }, outputs: ["End Flow"], stage: "cutscene" });
    const j = parseNodesManifest(body('{"workflow": "a.py", "inputs": {"S": {"n": 1}}, "model": "openai/gpt-image-2"}'));
    expect(j).toEqual({ workflow: "a.py", inputs: { S: { n: 1 } }, model: "openai/gpt-image-2" });
  });
  it("defaults inputs to an empty mapping and accepts a single output as a string", () => {
    expect(parseNodesManifest(body("workflow: a.py\noutputs: End Flow"))).toEqual({ workflow: "a.py", inputs: {}, outputs: ["End Flow"] });
  });
  it("names the problem: no block, empty block, bad JSON, unknown key, bad inputs, bad outputs, bad model", () => {
    expect(() => parseNodesManifest("just text")).toThrow(/no ```relay-nodes block/);
    expect(() => parseNodesManifest(body("  "))).toThrow(/empty/);
    expect(() => parseNodesManifest(body("{\"workflow\": }"))).toThrow(/not valid JSON/);
    expect(() => parseNodesManifest(body("workflow: a.py\nworkflw: b.py"))).toThrow(/unknown key in the relay-nodes block: workflw/);
    expect(() => parseNodesManifest(body("workflow: a.py\ninputs: [1]"))).toThrow(/`inputs` must be a mapping/);
    expect(() => parseNodesManifest(body("workflow: a.py\ninputs:\n  S: 3"))).toThrow(/inputs.S must be a mapping/);
    expect(() => parseNodesManifest(body("workflow: a.py\noutputs: [1, 2]"))).toThrow(/`outputs` must be a list/);
    expect(() => parseNodesManifest(body("workflow: a.py\nmodel: seedance"))).toThrow(/provider\/model/);
    expect(() => parseNodesManifest(body("- a\n- b"))).toThrow(/must be a mapping with a `workflow` key/);
    try {
      parseNodesManifest("x");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
    }
  });
});

describe("normalizeWorkflowPath", () => {
  it("keeps the path inside the repository and requires .py", () => {
    expect(normalizeWorkflowPath("workflows/a.py")).toBe("workflows/a.py");
    expect(normalizeWorkflowPath("./a.py")).toBe("a.py");
    for (const bad of ["", "/abs/a.py", "C:/a.py", "../a.py", "x/../a.py", "x//a.py", "a.txt", "a.py/", 42]) expect(() => normalizeWorkflowPath(bad)).toThrow(ManifestError);
  });
});
