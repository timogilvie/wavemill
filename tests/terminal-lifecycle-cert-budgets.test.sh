#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/terminal-lifecycle-cert-harness.sh
source "$SCRIPT_DIR/lib/terminal-lifecycle-cert-harness.sh"
incident_harness_require_tools
cert_harness_require_tmux

FAILURES=0
BUDGETS=()

record_budget() {
  local name="$1" measured="$2" limit="$3" pass="$4"
  BUDGETS+=("$(jq -cn --arg name "$name" --argjson measured "$measured" --argjson limit "$limit" --argjson pass "$pass" \
    '{name:$name,measured:$measured,limit:$limit,pass:$pass}')")
}

fail_budget() {
  printf '  FAIL budget %s: measured=%s limit=%s\n' "$1" "$2" "$3" >&2
  FAILURES=$((FAILURES + 1))
  record_budget "$1" "$2" "$3" false
}

pass_budget() {
  printf '  PASS budget %s: measured=%s limit=%s\n' "$1" "$2" "$3"
  record_budget "$1" "$2" "$3" true
}

assert_budget_le() {
  local name="$1" measured="$2" limit="$3"
  if (( measured <= limit )); then
    pass_budget "$name" "$measured" "$limit"
  else
    fail_budget "$name" "$measured" "$limit"
  fi
}

write_budgets() {
  local out="$CERT_REPO_DIR/.wavemill/terminal-lifecycle-cert/budgets.json"
  mkdir -p "$(dirname "$out")"
  printf '%s\n' "${BUDGETS[@]}" | jq -s . > "$out"
}

printf '\n=== terminal lifecycle budgets ===\n'
start_ms="$(incident_now_ms)"
cert_setup_delivery "budget-smoke" "squash" "shadow"
slots_before="$(incident_slot_consuming_count)"
cert_run_release_and_cleanup
end_ms="$(incident_now_ms)"
iteration_ms=$((end_ms - start_ms))

poll_seconds="${WAVEMILL_TERMINAL_CERT_POLL_SECONDS:-10}"
multiplier="${WAVEMILL_TERMINAL_CERT_TIMING_TOLERANCE_MULTIPLIER:-1}"
case "$poll_seconds:$multiplier" in
  *[!0-9:]*|*:|:*) limit_ms=10000 ;;
  *) limit_ms=$((poll_seconds * multiplier * 1000)) ;;
esac

assert_budget_le "idle-iteration-ms" "$iteration_ms" "$limit_ms"
assert_budget_le "slot-accounting-before" "$slots_before" 1

if cert_assert_pane_converged; then
  pass_budget "pane-convergence" 0 0
else
  fail_budget "pane-convergence" 1 0
fi

if cert_assert_authority_recorded; then
  pass_budget "deletion-authority-recorded" 0 0
else
  fail_budget "deletion-authority-recorded" 1 0
fi

if [[ "$CERT_CLEANUP_OUTCOME" == "shadow_would_delete" ]] && git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$CERT_BRANCH"; then
  pass_budget "shadow-deletion-disabled" 0 0
else
  fail_budget "shadow-deletion-disabled" 1 0
fi

write_budgets

if [[ "$FAILURES" -gt 0 ]]; then
  echo "terminal lifecycle budgets failed: $FAILURES" >&2
  exit 1
fi

echo "terminal lifecycle budgets passed"
