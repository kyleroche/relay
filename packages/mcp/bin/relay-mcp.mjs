#!/usr/bin/env node
// relay-mcp: stdio entry the CLIs' MCP configs point at. The server is TypeScript, so this wrapper runs it through
// the repo's own tsx (a root devDependency) with the same node binary that launched this script. stdio is inherited
// untouched: stdout is the MCP protocol, stderr carries logs.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "stdio.ts");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
