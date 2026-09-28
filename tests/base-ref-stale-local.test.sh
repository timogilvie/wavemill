#!/usr/bin/env bash
# Regression test for HOK-3090: worktrees must be cut from origin/<base>, not a
# stale local <base>. Exercises the hokusai-sdk shape (operator checkout on a
# different branch, local main N commits behind origin/main) plus the incident-2
# shape (operator checkout on auto/integration, that same branch N behind
# origin/auto/integration).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_ROOT/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git_env() { GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t "$@"; }

seed_origin_and_checkout() {
  rm -rf "$TMP/origin.git" "$TMP/seed" "$TMP/op" "$TMP/push"
  ORIGIN="$TMP/origin.git"
  git init --bare -q -b main "$ORIGIN"

  # Build initial state in a scratch clone, push both branches.
  SEED="$TMP/seed"
  git_env git clone -q "$ORIGIN" "$SEED"
  (
    cd "$SEED"
    echo initial > README.md
    git_env git add README.md
    git_env git commit -q -m 'initial'
    git_env git checkout -q -b auto/integration
    echo integ > integ.txt
    git_env git add integ.txt
    git_env git commit -q -m 'auto/integration commit 1'
    git_env git push -q origin main auto/integration
  )

  # Operator checkout, mimic the mill's REPO_DIR
  OP="$TMP/op"
  git_env git clone -q "$ORIGIN" "$OP"
  git_env git -C "$OP" fetch -q origin auto/integration:auto/integration
}

advance_origin() {
  local branch="$1" n="$2"
  local push="$TMP/push"
  local safe_branch
  safe_branch="$(printf '%s' "$branch" | tr '/' '-')"
  rm -rf "$push"
  git_env git clone -q "$ORIGIN" "$push"
  (
    cd "$push"
    git_env git checkout -q "$branch"
    local i
    for i in $(seq 1 "$n"); do
      echo "step-$i" >> "advance-$safe_branch.txt"
      git_env git add "advance-$safe_branch.txt"
      git_env git commit -q -m "advance $branch $i"
    done
    git_env git push -q origin "$branch"
  )
}

run_preflight() {
  local branch="$1" out="$2" rc=0
  ( source "$COMMON"; wavemill_base_ref_preflight "$branch" --force-fetch --json-out "$out" ) || rc=$?
  return "$rc"
}

echo "=== Base Ref Stale Local (real git) ==="

# ─── Case 1: operator on auto/integration, local main 2 behind origin/main ───
seed_origin_and_checkout
git_env git -C "$OP" checkout -q auto/integration
advance_origin main 2
export REPO_DIR="$OP"
export STATE_FILE="$TMP/state.json"
printf '{"tasks":{}}\n' > "$STATE_FILE"
export GIT_FETCH_TTL_SECONDS=0

out="$TMP/preflight-1.json"
if ! run_preflight main "$out"; then
  fail "case 1: preflight returned non-zero"
else
  json="$(cat "$out")"
  origin_sha="$(git -C "$OP" rev-parse refs/remotes/origin/main 2>/dev/null || true)"
  if [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/remotes/origin/main" ]]; then
    pass "case 1: resolvedRef is refs/remotes/origin/main"
  else
    fail "case 1: resolvedRef=$(jq -r '.resolvedRef' <<<"$json")"
  fi
  if [[ "$(jq -r '.resolvedSha' <<<"$json")" == "$origin_sha" ]]; then
    pass "case 1: resolvedSha equals origin tip"
  else
    fail "case 1: resolvedSha=$(jq -r '.resolvedSha' <<<"$json") origin_sha=$origin_sha"
  fi
  if [[ "$(jq -r '.localBehindOrigin' <<<"$json")" == "2" ]] \
    || [[ "$(jq -r '.localBehindOrigin' <<<"$json")" == "0" \
    && "$(jq -r '.localFastForwarded' <<<"$json")" == "true" ]]; then
    pass "case 1: local main behind reported / fast-forwarded"
  else
    fail "case 1: localBehindOrigin=$(jq -r '.localBehindOrigin' <<<"$json") localFastForwarded=$(jq -r '.localFastForwarded' <<<"$json")"
  fi
  # Now cut a worktree from resolvedRef and verify HEAD equals origin tip.
  wt="$TMP/wt-1"
  if git_env git -C "$OP" worktree add -q "$wt" -b task/1 "$(jq -r '.resolvedRef' <<<"$json")" 2>/dev/null; then
    wt_head="$(git -C "$wt" rev-parse HEAD)"
    if [[ "$wt_head" == "$origin_sha" ]]; then
      pass "case 1: new worktree HEAD == origin/main tip"
    else
      fail "case 1: new worktree HEAD=$wt_head origin_sha=$origin_sha"
    fi
    git_env git -C "$OP" worktree remove -f "$wt" 2>/dev/null || true
    git_env git -C "$OP" branch -D task/1 2>/dev/null || true
  else
    fail "case 1: git worktree add failed"
  fi
fi

# ─── Case 2: fast-forward runs (local main not checked out) ───
seed_origin_and_checkout
git_env git -C "$OP" checkout -q auto/integration
git_env git -C "$OP" fetch -q origin main:main
advance_origin main 2
export REPO_DIR="$OP"
export STATE_FILE="$TMP/state.json"
printf '{"tasks":{}}\n' > "$STATE_FILE"

pre_local="$(git -C "$OP" rev-parse refs/heads/main)"
out="$TMP/preflight-2.json"
if ! run_preflight main "$out"; then
  fail "case 2: preflight returned non-zero"
else
  json="$(cat "$out")"
  origin_sha="$(git -C "$OP" rev-parse refs/remotes/origin/main)"
  post_local="$(git -C "$OP" rev-parse refs/heads/main)"
  if [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "true" ]]; then
    pass "case 2: localFastForwarded=true"
  else
    fail "case 2: fast-forward did not run (localFastForwarded=$(jq -r '.localFastForwarded' <<<"$json") pre=$pre_local post=$post_local origin=$origin_sha)"
  fi
  if [[ "$post_local" == "$origin_sha" ]]; then
    pass "case 2: refs/heads/main == origin tip after fast-forward"
  else
    fail "case 2: refs/heads/main=$post_local origin=$origin_sha"
  fi
fi

# ─── Case 3: fetch failure falls back to local ref, warns fetchDegraded ───
seed_origin_and_checkout
git_env git -C "$OP" checkout -q auto/integration
export REPO_DIR="$OP"
export STATE_FILE="$TMP/state.json"
printf '{"tasks":{}}\n' > "$STATE_FILE"
git -C "$OP" remote set-url origin "$TMP/missing.git" 2>/dev/null || true

out="$TMP/preflight-3.json"
warn_output=""
if ! warn_output="$(( source "$COMMON"; wavemill_base_ref_preflight main --force-fetch --json-out "$out" ) 2>&1 >/dev/null)"; then
  :
fi
if [[ -f "$out" ]]; then
  json="$(cat "$out")"
  if [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/heads/main" ]] \
    && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]]; then
    pass "case 3: failed fetch falls back to refs/heads/main with fetchDegraded"
  else
    fail "case 3: resolvedRef=$(jq -r '.resolvedRef' <<<"$json") fetchDegraded=$(jq -r '.fetchDegraded' <<<"$json")"
  fi
  if grep -q "fetchDegraded" <<<"$warn_output"; then
    pass "case 3: warning names fetchDegraded"
  else
    fail "case 3: warning does not name fetchDegraded (got: $warn_output)"
  fi
else
  fail "case 3: preflight did not emit JSON"
fi

# ─── Case 4: operator on auto/integration, that branch 2 behind ───
seed_origin_and_checkout
git_env git -C "$OP" checkout -q auto/integration
advance_origin auto/integration 2
export REPO_DIR="$OP"
export STATE_FILE="$TMP/state.json"
printf '{"tasks":{}}\n' > "$STATE_FILE"
pre_local="$(git -C "$OP" rev-parse refs/heads/auto/integration)"
out="$TMP/preflight-4.json"
if ! run_preflight auto/integration "$out"; then
  fail "case 4: preflight returned non-zero"
else
  json="$(cat "$out")"
  post_local="$(git -C "$OP" rev-parse refs/heads/auto/integration)"
  if [[ "$(jq -r '.localCheckedOut' <<<"$json")" == "true" ]] \
    && [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "false" ]]; then
    pass "case 4: checked-out base is detected and not fast-forwarded"
  else
    fail "case 4: localCheckedOut=$(jq -r '.localCheckedOut' <<<"$json") localFastForwarded=$(jq -r '.localFastForwarded' <<<"$json")"
  fi
  if [[ "$post_local" == "$pre_local" ]]; then
    pass "case 4: refs/heads/auto/integration unchanged"
  else
    fail "case 4: refs/heads/auto/integration mutated"
  fi
  # wavemill_base_compare_ref should return origin/auto/integration.
  cr="$( source "$COMMON"; wavemill_base_compare_ref auto/integration )"
  if [[ "$cr" == "origin/auto/integration" ]]; then
    pass "case 4: base_compare_ref returns origin/auto/integration"
  else
    fail "case 4: base_compare_ref=$cr"
  fi
fi

# ─── Case 5: diverged local main (ahead 1, behind 2) → no fast-forward ───
seed_origin_and_checkout
git_env git -C "$OP" checkout -q main
echo local-diverge > "$OP/divergent.txt"
git_env git -C "$OP" add divergent.txt
git_env git -C "$OP" commit -q -m 'local divergence'
git_env git -C "$OP" checkout -q auto/integration
advance_origin main 2
export REPO_DIR="$OP"
export STATE_FILE="$TMP/state.json"
printf '{"tasks":{}}\n' > "$STATE_FILE"
pre_local="$(git -C "$OP" rev-parse refs/heads/main)"
out="$TMP/preflight-5.json"
if ! run_preflight main "$out"; then
  fail "case 5: preflight returned non-zero"
else
  json="$(cat "$out")"
  post_local="$(git -C "$OP" rev-parse refs/heads/main)"
  if [[ "$(jq -r '.localAheadOfOrigin' <<<"$json")" == "1" ]] \
    && [[ "$(jq -r '.localBehindOrigin' <<<"$json")" == "2" ]] \
    && [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "false" ]]; then
    pass "case 5: diverged local main not fast-forwarded"
  else
    fail "case 5: state=$(jq -c '{a:.localAheadOfOrigin,b:.localBehindOrigin,ff:.localFastForwarded}' <<<"$json")"
  fi
  if [[ "$post_local" == "$pre_local" ]]; then
    pass "case 5: refs/heads/main unchanged after diverged detection"
  else
    fail "case 5: refs/heads/main was mutated"
  fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
