#!/usr/bin/env bash
# check-package.sh: build @kyleroche/relay, pack it, install the tarball into an empty directory with npm, and run
# the CLI from there the way `npx @kyleroche/relay <cmd>` does on a machine with no checkout. Fails if the bundle
# misses a dependency, the migrations or hook scripts are not in the tarball, or PGlite cannot create its database.
# Usage: scripts/check-package.sh [--keep]   (--keep leaves the temp directory and prints its path)
set -euo pipefail
cd "$(dirname "$0")/.."

keep=0
[ "${1:-}" = "--keep" ] && keep=1

pnpm --filter @kyleroche/relay build

tmp="$(mktemp -d "${TMPDIR:-/tmp}/relay-package-XXXXXX")"
cleanup() { [ "$keep" = 1 ] && echo "kept $tmp" || rm -rf "$tmp"; }
trap cleanup EXIT

echo "== npm pack"
# --ignore-scripts: the build above already ran; prepack would run it again and print into the JSON.
packed="$(cd packages/cli && npm pack --ignore-scripts --pack-destination "$tmp" --json 2>/dev/null)"
tarball="$(jq -r '.[0].filename' <<<"$packed")"
jq -r '.[0] | "\(.filename): \(.files | length) files, \(.size) bytes packed, \(.unpackedSize) bytes unpacked"' <<<"$packed"
jq -r '.[0].files[].path' <<<"$packed" | sort
for f in dist/relay.js dist/relay-mcp.js dist/hooks/_lib.mjs dist/hooks/session-start.mjs dist/hooks/user-prompt.mjs dist/hooks/session-end.mjs dist/migrations/001_init.sql dist/container/Dockerfile dist/container/relay-entry templates/relay-caller.yml templates/relay-review.yml README.md LICENSE; do
  if ! tar -tzf "$tmp/$tarball" "package/$f" >/dev/null 2>&1; then echo "::error::$f missing from the tarball"; exit 1; fi
done

echo "== npm install into an empty directory"
app="$tmp/app"
mkdir -p "$app" && cd "$app"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$tmp/$tarball"

# Isolated homes: relay's data under $tmp/home, the CLIs' configs under $tmp/user, so nothing on this machine is read or written.
export RELAY_HOME="$tmp/home" RELAY_USER_HOME="$tmp/user"
mkdir -p "$RELAY_USER_HOME/.claude"
unset DATABASE_URL

echo "== relay --version / --help"
npx --no-install relay --version
npx --no-install relay --help >/dev/null

echo "== relay doctor (first run creates the PGlite database)"
npx --no-install relay init
npx --no-install relay doctor || true   # exit 1 is expected on a machine without claude/gh logins
grep -q "schema v" <(npx --no-install relay doctor 2>&1 || true) || { echo "::error::doctor did not report the database schema"; exit 1; }

echo "== relay setup records the package's dist/ files (written into the isolated RELAY_USER_HOME)"
npx --no-install relay setup --only claude --yes >/dev/null
settings="$RELAY_USER_HOME/.claude/settings.json"
claude_json="$RELAY_USER_HOME/.claude.json"
for want in "dist/hooks/session-start.mjs --cli claude" "dist/hooks/user-prompt.mjs --cli claude" "dist/hooks/session-end.mjs --cli claude"; do
  grep -qF "$want" "$settings" || { echo "::error::$settings does not run $want"; cat "$settings"; exit 1; }
done
grep -qF "dist/relay-mcp.js" "$claude_json" || { echo "::error::$claude_json does not point mcpServers.relay at dist/relay-mcp.js"; cat "$claude_json"; exit 1; }
if grep -q "packages/cli/hooks\|packages/mcp/bin" "$settings" "$claude_json"; then echo "::error::setup recorded checkout paths"; cat "$settings" "$claude_json"; exit 1; fi
# the second run must change nothing, and --remove must take relay's entries out again
npx --no-install relay setup --only claude 2>&1 | grep -q "nothing to change" || { echo "::error::setup is not idempotent from the package"; exit 1; }
npx --no-install relay setup --only claude --remove --yes >/dev/null
grep -q "session-start.mjs" "$settings" && { echo "::error::setup --remove left relay's hooks in place"; exit 1; }

echo "== relay-mcp starts and answers initialize"
# The server exits when stdin closes; `timeout` (absent on stock macOS) only guards against a hang.
bounded() { if command -v timeout >/dev/null; then timeout 60 "$@"; else "$@"; fi; }
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  | bounded npx --no-install relay-mcp 2>/dev/null | grep -q '"serverInfo"' || { echo "::error::relay-mcp did not answer initialize"; exit 1; }

echo "ok: @kyleroche/relay works from a clean install"
