#!/usr/bin/env bash
# check-readme-commands.sh: every `pnpm <name>` line inside a ```bash block of README.md must name a script in the
# root package.json or a pnpm built-in. AGENTS.md promises this check so renamed scripts cannot leave README stale.
set -euo pipefail
cd "$(dirname "$0")/.."

bad=0
while IFS= read -r line; do
  read -ra words <<< "$line"
  words=("${words[@]:1}")                                   # drop the leading "pnpm"
  while [ "${#words[@]}" -gt 0 ] && [[ "${words[0]}" == -* ]]; do
    case "${words[0]}" in
      --filter|-F) echo "skip (package-scoped): $line"; continue 2 ;;   # script lives in a workspace package
      --dir|-C) words=("${words[@]:2}") ;;                              # flag with a value
      *) words=("${words[@]:1}") ;;                                     # bare flag such as -r
    esac
  done
  cmd="${words[0]:-}"
  case "$cmd" in
    ''|install|i|add|remove|rm|update|up|run|exec|dlx|create|link|unlink|why|ls|list|outdated|store|config|setup|env|patch|publish|pack|dedupe|prune|rebuild|audit|licenses|self-update|init)
      continue ;;                                               # pnpm built-ins need no script
  esac
  if jq -e --arg s "$cmd" '.scripts[$s]' package.json >/dev/null; then
    echo "ok: $line"
  else
    echo "README.md: 'pnpm $cmd' is not a script in package.json -> $line" >&2
    bad=1
  fi
done < <(awk '/^```bash/{f=1; next} /^```/{f=0} f' README.md | grep -E '^[[:space:]]*pnpm( |$)' || true)
exit "$bad"
