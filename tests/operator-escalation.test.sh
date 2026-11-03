#!/usr/bin/env bash
# Unit tests for shared/lib/operator-escalation.sh (HOK-3360): the one
# operator-escalation step. Each basis is accepted only when it holds and
# refused (rc 3, no .needs-attention) when it does not, and the basis is
# recorded in the marker detail.
#
# protects: a caller can raise .needs-attention on a first occurrence by
# mislabelling the escalation basis (exhausted/policy-terminal/operator-decision).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/transient-marker.sh
source "$REPO_DIR/shared/lib/transient-marker.sh"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"
# shellcheck source=../shared/lib/operator-escalation.sh
source "$REPO_DIR/shared/lib/operator-escalation.sh"

# The operator-decision basis validates against OPERATOR_DECISIONS via the CLI.
wavemill_run_tool() { npx tsx "$REPO_DIR/tools/$1" "${@:2}"; }

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; echo "    $2"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# A state dir inside a real git repo so _operator_attention_write can resolve
# HEAD. The state dir is the repo root itself (git -C <state_dir> works).
fresh_state() {
  local dir="$TEST_TMP/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email t@example.com
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
  echo "$dir"
}

marker_exists() { [[ -f "$1/.needs-attention" ]]; }
marker_basis() { jq -r '.detail.escalationBasis // empty' "$1/.needs-attention" 2>/dev/null || true; }

# --- exhausted: refused when the bucket is not terminalized ------------------
dir="$(fresh_state exhausted-refused)"
rc=0
escalate_operator_attention "$dir" exhausted stage-failure-ready "boom" 2>/dev/null || rc=$?
if [[ "$rc" -eq 3 ]] && ! marker_exists "$dir"; then
  pass "exhausted basis refused (rc 3, no marker) when bucket not exhausted"
else
  fail "exhausted basis should refuse when bucket not exhausted" "rc=$rc, marker=$(marker_exists "$dir" && echo yes || echo no)"
fi

# --- exhausted: accepted once the bucket is terminalized --------------------
dir="$(fresh_state exhausted-ok)"
bounded_retry_mark_exhausted "$dir" stage-failure-ready "spent after 3 relaunches" >/dev/null
rc=0
escalate_operator_attention "$dir" exhausted stage-failure-ready "Ready budget spent for PR #9" || rc=$?
if [[ "$rc" -eq 0 ]] && marker_exists "$dir"; then
  pass "exhausted basis accepted when bucket terminalized"
else
  fail "exhausted basis should write a marker when terminalized" "rc=$rc"
fi
if [[ "$(marker_basis "$dir")" == "exhausted:stage-failure-ready" ]]; then
  pass "exhausted basis recorded in marker detail"
else
  fail "exhausted basis should be recorded" "got '$(marker_basis "$dir")'"
fi

# --- policy-terminal: accepts a terminal decision JSON ----------------------
dir="$(fresh_state policy-terminal-json)"
rc=0
escalate_operator_attention "$dir" policy-terminal '{"class":"terminal","failureKind":"provider-config-error"}' "terminal fail" || rc=$?
if [[ "$rc" -eq 0 ]] && marker_exists "$dir" && [[ "$(marker_basis "$dir")" == "policy-terminal:terminal" ]]; then
  pass "policy-terminal basis accepts a terminal decision JSON"
else
  fail "policy-terminal JSON should write a marker" "rc=$rc basis=$(marker_basis "$dir")"
fi

# --- policy-terminal: accepts the bare class word ---------------------------
dir="$(fresh_state policy-terminal-word)"
rc=0
escalate_operator_attention "$dir" policy-terminal terminal "review gate terminal" || rc=$?
if [[ "$rc" -eq 0 ]] && marker_exists "$dir"; then
  pass "policy-terminal basis accepts the bare class word 'terminal'"
else
  fail "policy-terminal word should write a marker" "rc=$rc"
fi

# --- policy-terminal: refuses a non-terminal class --------------------------
dir="$(fresh_state policy-terminal-refused)"
rc=0
escalate_operator_attention "$dir" policy-terminal '{"class":"retryable"}' "should not page" 2>/dev/null || rc=$?
if [[ "$rc" -eq 3 ]] && ! marker_exists "$dir"; then
  pass "policy-terminal basis refuses a non-terminal decision"
else
  fail "policy-terminal should refuse class=retryable" "rc=$rc"
fi

# --- operator-decision: accepts a known code --------------------------------
dir="$(fresh_state operator-decision-known)"
rc=0
escalate_operator_attention "$dir" operator-decision merged-before-ready "PR merged before ready" || rc=$?
if [[ "$rc" -eq 0 ]] && marker_exists "$dir" && [[ "$(marker_basis "$dir")" == "operator-decision:merged-before-ready" ]]; then
  pass "operator-decision basis accepts a known OPERATOR_DECISIONS code"
else
  fail "operator-decision known code should write a marker" "rc=$rc basis=$(marker_basis "$dir")"
fi

# --- operator-decision: refuses an unknown code -----------------------------
dir="$(fresh_state operator-decision-unknown)"
rc=0
escalate_operator_attention "$dir" operator-decision not-a-real-code "should not page" 2>/dev/null || rc=$?
if [[ "$rc" -eq 3 ]] && ! marker_exists "$dir"; then
  pass "operator-decision basis refuses an unknown code"
else
  fail "operator-decision should refuse an unknown code" "rc=$rc"
fi

# --- unknown basis: refused -------------------------------------------------
dir="$(fresh_state unknown-basis)"
rc=0
escalate_operator_attention "$dir" not-a-basis arg "should not page" 2>/dev/null || rc=$?
if [[ "$rc" -eq 3 ]] && ! marker_exists "$dir"; then
  pass "unknown basis refused"
else
  fail "unknown basis should refuse" "rc=$rc"
fi

# --- condition flags reach the marker ---------------------------------------
dir="$(fresh_state condition-flags)"
bounded_retry_mark_exhausted "$dir" review-infra-recovery "spent" >/dev/null
head_sha="$(git -C "$dir" rev-parse HEAD)"
escalate_operator_attention "$dir" exhausted review-infra-recovery "infra exhausted" \
  --head "$head_sha" --expires-on "head,operator-event,review-artifact" --review-artifact >/dev/null || true
if jq -e '.condition.expiresOn | index("review-artifact")' "$dir/.needs-attention" >/dev/null 2>&1; then
  pass "condition flags reach the marker"
else
  fail "condition flags should reach the marker" "condition=$(jq -c '.condition // {}' "$dir/.needs-attention" 2>/dev/null)"
fi

echo ""
echo "operator-escalation.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
