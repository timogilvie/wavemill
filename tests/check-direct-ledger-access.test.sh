#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERN='DatabaseSync|better-sqlite3|node:sqlite|\.wavemill/ledger\.sqlite'
scan() {
  local root="$1" hit file line failed=0
  while IFS= read -r hit; do
    file="${hit%%:*}"
    line="${hit#*:}"
    case "${file#"$root"/}" in
      shared/lib/ledger.ts|shared/lib/ledger-sqlite.ts|tests/ledger.test.ts|tests/check-direct-ledger-access.test.sh) continue ;;
    esac
    if [[ "$line" != *'ledger-access: allow '* ]]; then
      printf '%s\n' "$hit" >&2
      failed=1
    fi
  done < <(grep -REn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sh' --exclude-dir=node_modules -e "$PATTERN" "$root/shared" "$root/tools" "$root/commands" "$root/tests" "$root/codex" "$root/claude" 2>/dev/null || true)
  return "$failed"
}
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture"/{shared,tools,commands,tests,codex,claude}
printf '%s\n' "new DatabaseSync('ledger.sqlite')" > "$fixture/tools/rogue.ts"
if scan "$fixture" 2>/dev/null; then echo 'guard failed to detect direct access' >&2; exit 1; fi
printf '%s\n' "new DatabaseSync('ledger.sqlite') // ledger-access: allow fixture" > "$fixture/tools/rogue.ts"
scan "$fixture"
scan "$REPO_DIR"
echo 'ok - no direct ledger access'
