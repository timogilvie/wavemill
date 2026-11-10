#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
# Regression test for HOK-1377:
# save_migration_reservation must be defined inside the monitor heredoc scope.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HEREDOC="$(cat "$MONITOR_SCRIPT_FILE")"

if [[ -z "$HEREDOC" ]]; then
  echo "FATAL: Could not extract monitor heredoc"
  exit 1
fi

if grep -q '^save_migration_reservation()' <<< "$HEREDOC"; then
  pass "save_migration_reservation() is defined in monitor heredoc"
else
  fail "save_migration_reservation() is NOT defined in monitor heredoc (regression: HOK-1377)"
fi

STATE_FILE="$TMP/state.json"
echo '{"session":"test","tasks":{}}' > "$STATE_FILE"

FUNC_BODY="$(awk '
  /^save_migration_reservation\(\)/ { capture=1 }
  capture { print }
  capture && /^\}$/ { exit }
' <<< "$HEREDOC")"

if [[ -z "$FUNC_BODY" ]]; then
  fail "Could not extract save_migration_reservation body from heredoc"
else
  FUNC_FILE="$TMP/func.sh"
  HARNESS_FILE="$TMP/test-harness.sh"

  printf 'STATE_FILE="%s"\n' "$STATE_FILE" > "$FUNC_FILE"
  printf '%s\n' "$FUNC_BODY" >> "$FUNC_FILE"

  cat > "$HARNESS_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
save_migration_reservation "HOK-TEST" 42
EOF
  chmod +x "$HARNESS_FILE"

  if bash "$HARNESS_FILE" "$FUNC_FILE" 2>/dev/null; then
    reserved="$(jq -r '.migrationReservations["HOK-TEST"] // empty' "$STATE_FILE" 2>/dev/null)"
    next_num="$(jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null)"
    if [[ "$reserved" == "42" && "$next_num" == "43" ]]; then
      pass "save_migration_reservation writes reservation and nextMigrationNum"
    else
      fail "save_migration_reservation wrote unexpected state (reservation: ${reserved:-<empty>}, next: ${next_num:-<empty>})"
    fi
  else
    fail "save_migration_reservation invocation failed (exit 127 regression?)"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
