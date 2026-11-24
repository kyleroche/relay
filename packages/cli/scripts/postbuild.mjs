#!/usr/bin/env node
// After tsup: lay out the rest of the package beside the bundle so `runtimePaths()` finds it (dist/hooks/*.mjs,
// dist/migrations/*.sql, dist/container/ with the worker image's Dockerfile and entry script, dist/python/ with the
// Griptape Nodes shim, dist/steps/ with the steps relay ships and dist/steps/checks/ with their checks), make the two
// bins executable, and bring the repo's LICENSE into the package.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkg, "dist");

function copyDir(from, to, keep) {
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).filter(keep).sort();
  for (const n of names) copyFileSync(join(from, n), join(to, n));
  return names;
}

const hooks = copyDir(join(pkg, "hooks"), join(dist, "hooks"), (n) => n.endsWith(".mjs"));
const migrations = copyDir(join(pkg, "..", "core", "src", "db", "migrations"), join(dist, "migrations"), (n) => /^\d{3,}_[\w-]+\.sql$/.test(n));
const container = copyDir(join(pkg, "container"), join(dist, "container"), (n) => n === "Dockerfile" || n === "relay-entry");
chmodSync(join(dist, "container", "relay-entry"), 0o755);
// the Griptape Nodes shim runs under the engine's own Python (lanes/nodes.ts), found through runtimePaths().runWorkflowScript
const python = copyDir(join(pkg, "python"), join(dist, "python"), (n) => n.endsWith(".py"));
// the steps relay ships (remove-yap, eval, cleanup), found through runtimePaths().stepsDir
const steps = copyDir(join(pkg, "steps"), join(dist, "steps"), (n) => n.endsWith(".md"));
// their checks (`relay steps check`): a directory per step and case, looked up as checks/ beside the steps
cpSync(join(pkg, "steps", "checks"), join(dist, "steps", "checks"), { recursive: true });
const checks = readdirSync(join(dist, "steps", "checks")).flatMap((step) => readdirSync(join(dist, "steps", "checks", step)));
for (const bin of ["relay.js", "relay-mcp.js"]) chmodSync(join(dist, bin), 0o755);
copyFileSync(join(pkg, "..", "..", "LICENSE"), join(pkg, "LICENSE"));
console.log(`postbuild: ${hooks.length} hook scripts, ${migrations.length} migrations, ${container.length} container files, ${python.length} python scripts, ${steps.length} steps, ${checks.length} step checks, LICENSE`);
