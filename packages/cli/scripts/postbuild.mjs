#!/usr/bin/env node
// After tsup: lay out the rest of the package beside the bundle so `runtimePaths()` finds it (dist/hooks/*.mjs,
// dist/migrations/*.sql), make the two bins executable, and bring the repo's LICENSE into the package.
import { chmodSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
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
for (const bin of ["relay.js", "relay-mcp.js"]) chmodSync(join(dist, bin), 0o755);
copyFileSync(join(pkg, "..", "..", "LICENSE"), join(pkg, "LICENSE"));
console.log(`postbuild: ${hooks.length} hook scripts, ${migrations.length} migrations, LICENSE`);
