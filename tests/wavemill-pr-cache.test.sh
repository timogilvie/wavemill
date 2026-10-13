#!/usr/bin/env bash
# HOK-3206: one batched PR query per monitor pass feeds every per-task PR
# reader; repo constants come from a session cache.
#
#   1. refresh: one gh call, superset fields, rows scoped to task branches
#   2. spawn sample: 3 tasks' readers after one refresh make 0 extra gh calls
#   3. branch coverage: unsearched branches and truncated pages miss
#   4. stale meta / kill switch / search failure fall back to direct gh
#   5. session repo cache: one repo view + one protection read per base
#   6. the dashboard does not overwrite a fresh monitor cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin"
ln -s "$SCRIPT_DIR/fixtures/monitor-perf/mock-gh.sh" "$TMP_DIR/bin/gh"
export PATH="$TMP_DIR/bin:$PATH"
export MOCK_GH_LOG="$TMP_DIR/gh.log"
export MOCK_GH_PRS="$SCRIPT_DIR/fixtures/monitor-perf/pr-rows.json"
export MOCK_GH_REQUIRED='["Shell and Unit Tests","Preflight Checks"]'
export SESSION="pr-cache-test"
export MONITOR_PR_CACHE="$TMP_DIR/pr-cache.json"
export WAVEMILL_SESSION_REPO_CACHE="$TMP_DIR/repo.json"
API_TIMEOUT=10
export BASE_BRANCH=main

source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
gh_calls() { local n; n="$(grep -c . "$MOCK_GH_LOG" 2>/dev/null)" || true; printf '%s\n' "${n:-0}"; }
reset_calls() { : > "$MOCK_GH_LOG"; }

BRANCHES=(task/alpha task/beta task/gamma)

echo "=== 1. one batched refresh ==="
reset_calls
wavemill_pr_cache_refresh "${BRANCHES[@]}"
assert_eq "one gh call" "1" "$(gh_calls)"
assert_eq "searched every task branch" "1" "$(grep -c -- '--search head:task/alpha head:task/beta head:task/gamma' "$MOCK_GH_LOG")"
assert_eq "requested the superset fields" "1" "$(grep -c -- "--json $WAVEMILL_PR_CACHE_FIELDS" "$MOCK_GH_LOG")"
assert_eq "all states requested" "1" "$(grep -c -- '--state all' "$MOCK_GH_LOG")"
assert_eq "rows scoped to task branches" "4" "$(jq 'length' "$MONITOR_PR_CACHE")"
assert_eq "meta records coverage" '["task/alpha","task/beta","task/gamma"]' "$(jq -c '.branches' "$MONITOR_PR_CACHE.meta.json")"
assert_eq "cache file stays a raw array" "array" "$(jq -r 'type' "$MONITOR_PR_CACHE")"

echo "=== 2. per-task readers hit the cache (spawn sample) ==="
reset_calls
assert_eq "pr_state OPEN" "OPEN" "$(pr_state 4501)"
assert_eq "pr_state MERGED" "MERGED" "$(pr_state 4502)"
validate_pr_merge 4502 && merged=yes || merged=no
assert_eq "validate_pr_merge confirms merge" "yes" "$merged"
validate_pr_merge 4501 && merged=yes || merged=no
assert_eq "validate_pr_merge refuses an open PR" "no" "$merged"
assert_eq "candidates newest first" "4502,4400" "$(wavemill_pr_candidates_for_branch task/beta | jq -r 'map(.number) | join(",")')"
assert_eq "candidates carry lineage fields" "Implements HOK-2" "$(wavemill_pr_candidates_for_branch task/beta | jq -r '.[0].body')"
check_pr_exists task/gamma && exists=yes || exists=no
assert_eq "check_pr_exists from cache" "yes" "$exists"
assert_eq "live state terminal" "MERGED" "$(wavemill_pr_live_state 4502 | jq -r '.terminalState')"
assert_eq "labels by PR" '[{"name":"wm:blocked"}]' "$(wavemill_pr_cache_lookup_pr 4503 labels)"
assert_eq "head by branch" "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1" "$(wavemill_pr_cache_lookup task/alpha headRefOid)"
assert_eq "zero gh calls after the refresh" "0" "$(gh_calls)"
assert_eq "hits counted" "yes" "$([[ -s "$MONITOR_PR_CACHE.hits" ]] && echo yes || echo no)"

echo "=== 3. coverage ==="
reset_calls
check_pr_exists task/unrelated && exists=yes || exists=no
assert_eq "unsearched branch asks GitHub" "1" "$(gh_calls)"
assert_eq "absent row on a covered branch means no PR" "[]" "$(wavemill_pr_candidates_for_branch task/delta-never 2>/dev/null | jq -c '.' 2>/dev/null || echo miss)"
reset_calls
saved_limit="$WAVEMILL_PR_CACHE_BATCH_LIMIT"
WAVEMILL_PR_CACHE_BATCH_LIMIT=2
wavemill_pr_cache_refresh task/alpha task/beta
assert_eq "full page marks the cache incomplete" "false" "$(jq -r '.complete' "$MONITOR_PR_CACHE.meta.json")"
reset_calls
wavemill_pr_candidates_for_branch task/beta >/dev/null
assert_eq "incomplete page never claims coverage" "1" "$(gh_calls)"
WAVEMILL_PR_CACHE_BATCH_LIMIT="$saved_limit"

echo "=== 4. fallbacks ==="
wavemill_pr_cache_refresh "${BRANCHES[@]}"
reset_calls
WAVEMILL_DISABLE_GH_BATCH_CACHE=1 pr_state 4501 >/dev/null
assert_eq "kill switch reads GitHub directly" "1" "$(gh_calls)"
reset_calls
jq '.writtenAt -= 3600' "$MONITOR_PR_CACHE.meta.json" > "$TMP_DIR/m" && mv "$TMP_DIR/m" "$MONITOR_PR_CACHE.meta.json"
pr_state 4501 >/dev/null
assert_eq "stale cache reads GitHub directly" "1" "$(gh_calls)"
reset_calls
MOCK_GH_FAIL_SEARCH=1 wavemill_pr_cache_refresh "${BRANCHES[@]}"
assert_eq "failed search falls back to the open dump" "2" "$(gh_calls)"
assert_eq "fallback claims no branch coverage" "[]" "$(jq -c '.branches' "$MONITOR_PR_CACHE.meta.json")"
assert_eq "fallback rows are open PRs" "3" "$(jq 'length' "$MONITOR_PR_CACHE")"
reset_calls
wavemill_pr_candidates_for_branch task/beta >/dev/null
assert_eq "uncovered branch after fallback asks GitHub" "1" "$(gh_calls)"
assert_eq "PR rows still served by number" "OPEN" "$(pr_state 4503)"

echo "=== 5. session repo cache ==="
reset_calls
wavemill_session_repo_cache_refresh "$TMP_DIR" main
assert_eq "repo view + one protection read" "2" "$(gh_calls)"
assert_eq "nameWithOwner cached" "acme/widgets" "$(jq -r '.nameWithOwner' "$WAVEMILL_SESSION_REPO_CACHE")"
assert_eq "required checks cached per base" '["Shell and Unit Tests","Preflight Checks"]' "$(jq -c '.requiredChecks.main' "$WAVEMILL_SESSION_REPO_CACHE")"
reset_calls
wavemill_session_repo_cache_refresh "$TMP_DIR" main
assert_eq "second refresh makes no calls" "0" "$(gh_calls)"
wavemill_session_repo_cache_refresh "$TMP_DIR" main auto/integration
assert_eq "new base costs one protection read" "1" "$(gh_calls)"
reset_calls
assert_eq "repo name from cache" "acme/widgets" "$(wavemill_repo_name_with_owner "$TMP_DIR")"
assert_eq "no gh call for the repo name" "0" "$(gh_calls)"

echo "=== 6. dashboard leaves a fresh monitor cache alone ==="
wavemill_pr_cache_refresh "${BRANCHES[@]}"
eval "$(awk '/^refresh_pr_cache\(\) \{/,/^}/' "$REPO_DIR/shared/lib/wavemill-status.sh")"
PR_CACHE="$MONITOR_PR_CACHE"
PR_TTL=0
before="$(cksum < "$PR_CACHE")"
reset_calls
refresh_pr_cache
assert_eq "dashboard skipped its gh call" "0" "$(gh_calls)"
assert_eq "monitor cache untouched" "$before" "$(cksum < "$PR_CACHE")"

echo
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
