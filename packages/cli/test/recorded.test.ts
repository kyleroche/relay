import { describe, expect, it } from "vitest";
import { recordedNodeCheck } from "../src/commands/probes.ts";

describe("recordedNodeCheck", () => {
  const gone = "/opt/homebrew/Cellar/node@24/24.18.0/bin/node";
  const files: Record<string, string> = {
    // a checkout's hook commands never say "relay": the script name marks them
    "/h/.claude/settings.json": JSON.stringify({ statusLine: { type: "command", command: `${gone} /Users/k/kyro-harness/packages/cli/hooks/statusline.mjs` } }, null, 2),
    "/h/.claude.json": JSON.stringify({ mcpServers: { relay: { type: "stdio", command: "/opt/homebrew/opt/node@24/bin/node", args: ["/x/relay-mcp.mjs"] }, other: { command: "/gone/bin/node", args: ["/y/server.js"] } } }, null, 2),
  };
  const read = (p: string) => files[p];
  const exists = (p: string) => p === "/opt/homebrew/opt/node@24/bin/node";

  it("fails with the file, the path and the fix when relay's own entry runs a Node that is gone", () => {
    const c = recordedNodeCheck({ configs: Object.keys(files) }, { read, exists });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(`/h/.claude/settings.json runs ${gone}`);
    expect(c.detail).toContain("relay setup --yes");
    expect(c.detail).not.toContain("/gone/bin/node");
  });
  it("reads the service file whole and names the second fix", () => {
    const plist = `<string>${gone}</string>\n<string>/Users/k/kyro-harness/node_modules/tsx/dist/cli.mjs</string>\n<string>work</string>`;
    const c = recordedNodeCheck({ configs: [], owned: ["/h/Library/LaunchAgents/house.kyro.relay.work.plist"] }, { read: () => plist, exists });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("relay work --install --yes");
  });
  it("flags a service file that still passes an option relay work no longer takes", () => {
    const plist = "<string>/opt/homebrew/opt/node@24/bin/node</string>\n<string>/x/dist/relay.js</string>\n<string>work</string>\n<string>--max-interval</string>\n<string>900</string>";
    const c = recordedNodeCheck({ configs: [], owned: ["/h/Library/LaunchAgents/house.kyro.relay.work.plist"] }, { read: () => plist, exists: () => true });
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("passes --max-interval, which relay work no longer takes");
    expect(c.detail).toContain("relay work --install --yes");
  });
  it("is ok when every recorded path exists, and says so when nothing is installed", () => {
    expect(recordedNodeCheck({ configs: Object.keys(files) }, { read, exists: () => true }).status).toBe("ok");
    expect(recordedNodeCheck({ configs: ["/h/none"] }, { read, exists }).detail).toMatch(/no relay hooks or service installed/);
  });
});
