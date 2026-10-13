#!/usr/bin/env node
/**
 * Post-deploy gate: run Vercel's is-agentic scanner against the public URL and fail
 * below a threshold. Usage: RELAY_PUBLIC_URL=https://harness.kyro.house pnpm --filter @relay/web check:agentic
 * Env: RELAY_PUBLIC_URL (or first arg), AGENTIC_THRESHOLD (default 95).
 */
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? process.env.RELAY_PUBLIC_URL ?? "https://harness.kyro.house";
const threshold = Number(process.env.AGENTIC_THRESHOLD ?? 95);
const domain = target.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

const run = spawnSync("npx", ["--yes", "is-agentic", domain, "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (run.error) {
  console.error(`check:agentic: could not run is-agentic: ${run.error.message}`);
  process.exit(2);
}
const out = `${run.stdout ?? ""}`;
const start = out.indexOf("{");
if (start < 0) {
  console.error("check:agentic: no JSON in scanner output");
  console.error(out.slice(0, 2000), run.stderr?.slice(0, 2000) ?? "");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(out.slice(start));
} catch (err) {
  console.error(`check:agentic: could not parse scanner JSON: ${err.message}`);
  process.exit(2);
}

const score = Number(report.score ?? report.overall?.score ?? report.summary?.score ?? NaN);
const issues = report.issues ?? report.checks ?? [];
const failing = Array.isArray(issues) ? issues.filter((i) => i && (i.result === "fail" || i.status === "fail" || i.passed === false)) : [];

console.log(`is-agentic ${domain}: score ${Number.isNaN(score) ? "unknown" : score} (threshold ${threshold})`);
for (const i of failing) {
  console.log(`  - ${i.id ?? i.name ?? "check"}: ${i.recommendation ?? i.message ?? i.description ?? ""}`);
}
if (Number.isNaN(score)) {
  console.error("check:agentic: score missing from report");
  process.exit(2);
}
process.exit(score >= threshold ? 0 : 1);
