#!/usr/bin/env bash
# HOK-3076: the eval report keeps priced-nothing cost out of its aggregates
# (no $0.00 for unavailable cost) and labels CLI/local estimates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.wavemill/evals"

attribution() {
  # source coverage pricedSessions pricingSource
  printf '{"source":"%s","coverage":"%s","sessions":1,"turns":1,"pricedSessions":%s,"unpricedSessions":0,"models":[{"provider":"%s","modelId":"m","priced":%s,"pricingSource":"%s"}]}' \
    "$1" "$2" "$3" "$1" "$([[ "$3" -gt 0 ]] && echo true || echo false)" "$4"
}
record() {
  # id agentType workflowCost attribution-json
  printf '{"id":"%s","score":0.8,"scoreBand":"Minor Feedback","timestamp":"2026-10-01T00:00:00Z","agentType":"%s","rationale":"ok","workflowCost":%s,"workflowCostAttribution":%s}\n' "$1" "$2" "$3" "$4"
}
{
  record cli claude 1.5 "$(attribution claude complete 1 local_estimate)"
  record exact native 0.5 "$(attribution native complete 1 openrouter_api)"
  record unpriced native 0 "$(attribution native unavailable 0 local_estimate)"
  record free native 0 "$(attribution native known_zero 1 openrouter_api)"
} > "$TMP/.wavemill/evals/evals.jsonl"

json="$(REPO_DIR="$TMP" bash "$REPO_ROOT/shared/lib/wavemill-eval-report.sh" --json)"
text="$(REPO_DIR="$TMP" bash "$REPO_ROOT/shared/lib/wavemill-eval-report.sh")"

pass=0
fail=0
check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — expected '$expected', got '$actual'"
    fail=$((fail + 1))
  fi
}
check_contains() {
  local label="$1" needle="$2"
  if [[ "$text" == *"$needle"* ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — output missing '$needle'"
    fail=$((fail + 1))
  fi
}

check "total excludes priced-nothing, keeps known zero" "$(jq -r '.total_cost' <<<"$json")" "2"
check "average over reportable records only" "$(jq -r '.avg_cost' <<<"$json")" "0.6667"
check "unavailable records counted" "$(jq -r '.unavailable_cost_records' <<<"$json")" "1"
check "estimated records counted" "$(jq -r '.estimated_cost_records' <<<"$json")" "1"
check "CLI agent cost is an estimate" "$(jq -r '.per_model[] | select(.model == "claude") | .cost_is_estimate' <<<"$json")" "true"
check "provider-reported native cost is exact" "$(jq -r '.per_model[] | select(.model == "native") | .cost_is_estimate' <<<"$json")" "false"
check_contains "total labelled estimate" 'Total Workflow Cost:'
check_contains "estimate marker" '~$2.0000'
check_contains "estimate note" 'estimate: 1 record(s)'
check_contains "unavailable line" 'Cost unavailable (excluded from totals):'

echo "eval-report-cost-availability: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
