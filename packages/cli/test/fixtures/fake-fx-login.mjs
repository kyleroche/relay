#!/usr/bin/env node
// A stand-in for `fx login <provider>` inside the container, for packages/cli/test/work.test.ts. It prints an
// authorize URL whose redirect_uri names the loopback port in FAKE_PORT (grok: 127.0.0.1:<port>/callback; codex:
// localhost:<port>/auth/callback), then behaves per FAKE_MODE:
//   paste (default)  waits for one line on stdin and exits 0 when it is FAKE_CODE, else prints fx's failure and exits 1
//   finish           exits 0 on its own after FAKE_AFTER_MS (the published-port path: the redirect never reaches the Mac)
//   hang             never exits (the timeout path); the Mac side kills it
//   fail             exits 1 before printing any URL
import { createInterface } from "node:readline";

const provider = process.argv[2] ?? "grok";
const port = process.env.FAKE_PORT ?? "42723";
const mode = process.env.FAKE_MODE ?? "paste";
if (mode === "fail") {
  process.stderr.write("fx login: failed to sign in\n");
  process.exit(1);
}
const redirect = provider === "codex" ? `http://localhost:${port}/auth/callback` : `http://127.0.0.1:${port}/callback`;
const base = provider === "codex" ? "https://auth.openai.com/oauth/authorize" : "https://auth.x.ai/oauth2/authorize";
const url = `${base}?response_type=code&client_id=fake&redirect_uri=${encodeURIComponent(redirect)}&state=st4te`;
process.stdout.write(`Open this URL in your browser to sign in:\n\n  ${url}\n\n`);
if (mode === "finish") {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_AFTER_MS ?? "300"));
} else if (mode === "hang") {
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(`Paste the code shown by ${provider === "codex" ? "OpenAI" : "xAI"} and press enter: `);
  const rl = createInterface({ input: process.stdin });
  rl.once("line", (line) => {
    if (line.trim() === (process.env.FAKE_CODE ?? "")) {
      process.stdout.write(`\nSigned in to ${provider}.\n`);
      process.exit(0);
    }
    process.stderr.write("fx login: failed to sign in\n");
    process.exit(1);
  });
}
