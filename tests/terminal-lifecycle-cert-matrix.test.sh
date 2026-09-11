#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/terminal-lifecycle-cert-harness.sh
source "$SCRIPT_DIR/lib/terminal-lifecycle-cert-harness.sh"
incident_harness_require_tools
cert_harness_require_tmux

FIXTURES_DIR="$SCRIPT_DIR/fixtures/terminal-lifecycle"
# shellcheck source=fixtures/terminal-lifecycle/merge_commit_delivery.sh
source "$FIXTURES_DIR/merge_commit_delivery.sh"
# shellcheck source=fixtures/terminal-lifecycle/squash_delivery.sh
source "$FIXTURES_DIR/squash_delivery.sh"
# shellcheck source=fixtures/terminal-lifecycle/rebase_delivery.sh
source "$FIXTURES_DIR/rebase_delivery.sh"
# shellcheck source=fixtures/terminal-lifecycle/changed_after_review_head.sh
source "$FIXTURES_DIR/changed_after_review_head.sh"
# shellcheck source=fixtures/terminal-lifecycle/merged_pr_plain.sh
source "$FIXTURES_DIR/merged_pr_plain.sh"

FAILURES=0

scenario_enabled() {
  local name="$1" filter="${WAVEMILL_TERMINAL_CERT_SCENARIOS:-}"
  [[ -z "$filter" || "$filter" == "all" ]] && return 0
  [[ "$filter" == "smoke" && "$name" == "merge-commit-delivery" ]] && return 0
  IFS=',' read -ra parts <<< "$filter"
  local part
  for part in "${parts[@]}"; do
    [[ "$part" == "$name" ]] && return 0
  done
  return 1
}

run_delivery_case() {
  local name="$1" setup_fn="$2" merge_method="$3" mode="$4"
  scenario_enabled "$name" || return 0
  printf '\n=== %s (%s/%s) ===\n' "$name" "$merge_method" "$mode"
  local start_ms end_ms passed=true
  start_ms="$(incident_now_ms)"
  "$setup_fn" "$mode"
  cert_run_release_and_cleanup
  cert_assert_pane_converged || passed=false
  cert_assert_branch_shadow_or_enforced "$mode" || passed=false
  cert_assert_authority_recorded || passed=false
  cert_assert_no_leaks || passed=false
  end_ms="$(incident_now_ms)"
  if [[ "$passed" == "true" ]]; then
    printf '  PASS %s\n' "$name"
  else
    printf '  FAIL %s\n' "$name" >&2
    FAILURES=$((FAILURES + 1))
  fi
  cert_record_matrix_result "$name" "$merge_method" "$passed" "$((end_ms - start_ms))"
}

run_changed_after_review_case() {
  local name="changed-after-review-head" passed=true start_ms end_ms marker
  scenario_enabled "$name" || return 0
  printf '\n=== %s ===\n' "$name"
  start_ms="$(incident_now_ms)"
  cert_setup_changed_after_review_head "shadow"
  cert_run_release_and_cleanup || true
  cert_assert_pane_converged || passed=false
  cert_assert_eq "retain_unpublished" "$CERT_CLEANUP_OUTCOME" "changed_after_review_outcome" || passed=false
  git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$CERT_BRANCH" || passed=false
  [[ -d "$CERT_WT" ]] || passed=false
  marker="$REPO_DIR/.wavemill/incidents/preserved-branches/${CERT_BRANCH//\//__}.json"
  [[ -f "$marker" ]] || passed=false
  [[ "$(jq -r '.verificationReason // empty' "$marker")" == "changed_after_pr_head" ]] || passed=false
  end_ms="$(incident_now_ms)"
  if [[ "$passed" == "true" ]]; then
    printf '  PASS %s\n' "$name"
  else
    printf '  FAIL %s\n' "$name" >&2
    FAILURES=$((FAILURES + 1))
  fi
  cert_record_matrix_result "$name" "squash" "$passed" "$((end_ms - start_ms))"
}

run_delivery_case "merge-commit-delivery" cert_setup_merge_commit_delivery "merge" "shadow"
run_delivery_case "squash-delivery" cert_setup_squash_delivery "squash" "shadow"
run_delivery_case "rebase-delivery" cert_setup_rebase_delivery "rebase" "shadow"
run_delivery_case "merged-pr-plain" cert_setup_merged_pr_plain "merge" "enforce"
run_changed_after_review_case

cert_write_matrix_results

if [[ "$FAILURES" -gt 0 ]]; then
  echo "terminal lifecycle cert matrix failed: $FAILURES" >&2
  exit 1
fi

echo "terminal lifecycle cert matrix passed"
