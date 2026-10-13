#!/usr/bin/env bash
# HOK-3210: persist_task_window_id must never recreate a reaped task row.
#
# It used a raw `.tasks[$issue].windowId = ...` state_mutate, which on a
# reaped issue wrote back a windowId-only HOK-3125 orphan stub. It now goes
# through task_state_mutate_existing: a reaped issue leaves
# workflow-state.json byte-identical, a live one still records its window id.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}

# Brace-depth-aware extraction (same approach as tests/monitor-late-completion.test.sh).
extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE"
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SHIM_DIR="$TMP_ROOT/bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/tmux" <<'SHIM'
#!/usr/bin/env bash
case "${1:-}" in
  display-message) printf '@42\n' ;;
esac
exit 0
SHIM
chmod +x "$SHIM_DIR/tmux"
export PATH="$SHIM_DIR:$PATH"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

extracted="$(extract_function persist_task_window_id)"
[[ -n "$extracted" ]] || { echo "Could not extract persist_task_window_id()" >&2; exit 1; }
eval "$extracted"

SESSION="wavemill-test"
STATE_FILE="$TMP_ROOT/workflow-state.json"
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-ALIVE": {"slug": "alive", "phase": "executing", "status": "running", "updated": "2026-01-01T00:00:00Z"}
  },
  "terminalTaskHistory": {"tasks": {"HOK-GONE": {"issue": "HOK-GONE"}}}
}
JSON

echo "=== REQ-F2: reaped issue leaves workflow-state.json unchanged ==="
cp "$STATE_FILE" "$TMP_ROOT/before.json"
persist_task_window_id "HOK-GONE" "@99"
if cmp -s "$TMP_ROOT/before.json" "$STATE_FILE"; then
  pass "state file byte-identical after persist on reaped issue"
else
  fail "state file changed after persist on reaped issue: $(diff "$TMP_ROOT/before.json" "$STATE_FILE" || true)"
fi
assert_eq "no stub row created" "true" "$(jq '.tasks["HOK-GONE"] == null' "$STATE_FILE")"

echo ""
echo "=== REQ-F2: live issue still records its window id ==="
persist_task_window_id "HOK-ALIVE" "HOK-ALIVE-alive"
assert_eq "windowId recorded from tmux" "@42" "$(jq -r '.tasks["HOK-ALIVE"].windowId' "$STATE_FILE")"
assert_eq "updated refreshed" "true" "$(jq '.tasks["HOK-ALIVE"].updated != "2026-01-01T00:00:00Z"' "$STATE_FILE")"
assert_eq "existing fields preserved" "executing|running|alive" "$(jq -r '.tasks["HOK-ALIVE"] | "\(.phase)|\(.status)|\(.slug)"' "$STATE_FILE")"
assert_eq "no other task keys appeared" '["HOK-ALIVE"]' "$(jq -c '.tasks | keys' "$STATE_FILE")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
