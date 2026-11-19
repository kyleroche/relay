import { describe, expect, it } from "vitest";
import { missingNodePaths, stableNodePath } from "../src/runtime.ts";

describe("stableNodePath", () => {
  it("records Homebrew's opt symlink instead of the versioned Cellar directory", () => {
    const exists = (p: string) => p === "/opt/homebrew/opt/node@24/bin/node";
    expect(stableNodePath("/opt/homebrew/Cellar/node@24/24.18.0/bin/node", exists)).toBe("/opt/homebrew/opt/node@24/bin/node");
    expect(stableNodePath("/usr/local/Cellar/node/25.1.0_1/bin/node", (p) => p === "/usr/local/opt/node/bin/node")).toBe("/usr/local/opt/node/bin/node");
  });
  it("keeps the real path when there is no opt symlink, and any path that is not a Cellar one", () => {
    expect(stableNodePath("/opt/homebrew/Cellar/node@24/24.18.0/bin/node", () => false)).toBe("/opt/homebrew/Cellar/node@24/24.18.0/bin/node");
    expect(stableNodePath("/Users/k/.nvm/versions/node/v24.3.0/bin/node", () => true)).toBe("/Users/k/.nvm/versions/node/v24.3.0/bin/node");
    expect(stableNodePath("/usr/bin/node", () => true)).toBe("/usr/bin/node");
  });
});

describe("missingNodePaths", () => {
  const gone = "/opt/homebrew/Cellar/node@24/24.18.0/bin/node";
  const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${gone} /Users/k/kyro-harness/packages/cli/hooks/session-start.mjs --cli claude` }] }] } }, null, 2);
  it("finds a recorded node that is gone", () => {
    expect(missingNodePaths(settings, { exists: () => false })).toEqual([gone]);
    expect(missingNodePaths(settings, { exists: () => true })).toEqual([]);
  });
  it("with `runs`, leaves a user's own entries alone and still sees a pretty-printed MCP entry", () => {
    const other = JSON.stringify({ mcpServers: { mine: { command: "/gone/elsewhere/bin/node", args: ["/Users/k/tools/server.js"] } } }, null, 2);
    expect(missingNodePaths(other, { exists: () => false, runs: /relay/i })).toEqual([]);
    const mcp = JSON.stringify({ mcpServers: { relay: { type: "stdio", command: gone, args: ["/Users/k/pkg/dist/relay-mcp.js"] } } }, null, 2);
    expect(missingNodePaths(mcp, { exists: () => false, runs: /relay/i })).toEqual([gone]);
    // an entry of the user's own right after relay's is not relay's
    const both = JSON.stringify({ mcpServers: { relay: { command: "/ok/bin/node", args: ["/x/relay-mcp.mjs"] }, mine: { command: "/gone/elsewhere/bin/node", args: ["/y/server.js"] } } }, null, 2);
    expect(missingNodePaths(both, { exists: () => false, runs: /relay/i })).toEqual(["/ok/bin/node"]);
  });
  it("does not mistake node_modules or a longer name for the binary", () => {
    expect(missingNodePaths("/a/bin/node_modules/x /a/bin/nodejs /a/bin/node.exe", { exists: () => false })).toEqual([]);
  });
});
