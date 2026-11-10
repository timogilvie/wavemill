#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

log() {
  local level="${1:-}" message="${2:-}"
  if [[ "$level" == "warn" ]]; then
    printf '%s\n' "$message" >&2
  else
    printf '%s\n' "$message"
  fi
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Router Log Verbosity ==="

route_file="$(mktemp /tmp/router-route.XXXXXX.json)"
cat > "$route_file" <<'JSON'
{"planner":"p","planDepth":"deep","coder":"c","codeDepth":"medium","reviewer":"r","reviewMode":"llm","provenance":{"routerMode":"constrained"}}
JSON

quiet_out="$(log_router_route_summary "HOK-1" "$route_file" 2>&1)"
if grep -q '\[HOK-1\] \[router\] \[mode=constrained\] planner=p, planDepth=deep, coder=c, codeDepth=medium, reviewer=r, reviewMode=llm' <<< "$quiet_out"; then
  pass "concise summary emits one line"
else
  fail "concise summary should emit one line"
fi

quiet_lifecycle="$(log_route_lifecycle "expanded_assigned" "issue=HOK-1" "route=\"x\"" 2>&1 || true)"
if [[ -z "$quiet_lifecycle" ]]; then
  pass "success lifecycle suppressed by default"
else
  fail "success lifecycle should be suppressed by default"
fi

verbose_lifecycle="$(WAVEMILL_ROUTER_LOG_VERBOSE=1 log_route_lifecycle "expanded_assigned" "issue=HOK-1" "route=\"x\"" 2>&1 || true)"
if grep -q 'route.lifecycle: event=expanded_assigned issue=HOK-1' <<< "$verbose_lifecycle"; then
  pass "success lifecycle restored in verbose mode"
else
  fail "success lifecycle should restore in verbose mode"
fi

rm -f "$route_file"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
