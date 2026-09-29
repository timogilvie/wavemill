#!/usr/bin/env bash
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

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-C" ]]; then
  shift 2
fi

lookup_sha() {
  local ref="$1"
  [[ -f "${GIT_STUB_SHAS_FILE:-}" ]] || return 1
  awk -v ref="$ref" '$1 == ref { print $2; found=1; exit } END { if (!found) exit 1 }' "$GIT_STUB_SHAS_FILE"
}

case "${1:-}" in
  fetch)
    exit "${GIT_STUB_FETCH_RC:-0}"
    ;;
  show-ref)
    shift
    if [[ "${1:-}" == "--verify" ]]; then shift; fi
    if [[ "${1:-}" == "--quiet" ]]; then shift; fi
    ref="${1:-}"
    if [[ -f "${GIT_STUB_REFS_FILE:?}" ]] && grep -Fxq "$ref" "$GIT_STUB_REFS_FILE"; then
      exit 0
    fi
    exit 1
    ;;
  symbolic-ref)
    if [[ "${GIT_STUB_DEFAULT_BRANCH:-}" ]]; then
      printf '%s\n' "$GIT_STUB_DEFAULT_BRANCH"
      exit 0
    fi
    exit 1
    ;;
  rev-parse)
    shift
    # Skip flags like --verify
    while [[ "${1:-}" == --* ]]; do shift; done
    arg="${1:-}"
    # Strip ^{commit} suffix if present
    ref="${arg%^\{commit\}}"
    if sha="$(lookup_sha "$ref")"; then
      printf '%s\n' "$sha"
      exit 0
    fi
    exit 1
    ;;
  rev-list)
    if [[ "${GIT_STUB_REV_LIST_LEFT_RIGHT:-}" ]]; then
      printf '%s\n' "$GIT_STUB_REV_LIST_LEFT_RIGHT"
      exit 0
    fi
    exit 0
    ;;
  worktree)
    if [[ -f "${GIT_STUB_WORKTREE_FILE:-}" ]]; then
      cat "$GIT_STUB_WORKTREE_FILE"
    fi
    exit 0
    ;;
  update-ref)
    shift
    # git update-ref <ref> <new> [<old>]
    printf '%s\t%s\t%s\n' "${1:-}" "${2:-}" "${3:-}" >> "${GIT_STUB_UPDATE_REF_LOG:-/dev/null}"
    exit "${GIT_STUB_UPDATE_REF_RC:-0}"
    ;;
esac

exit 1
EOF
chmod +x "$BIN_DIR/git"

export PATH="$BIN_DIR:$PATH"
export REPO_DIR="$TMP/repo"
export STATE_FILE="$TMP/workflow-state.json"
export GIT_STUB_REFS_FILE="$TMP/refs.txt"
export GIT_STUB_SHAS_FILE="$TMP/shas.txt"
export GIT_STUB_WORKTREE_FILE="$TMP/worktrees.txt"
export GIT_STUB_UPDATE_REF_LOG="$TMP/update-ref.log"
export GIT_FETCH_TTL_SECONDS=0
mkdir -p "$REPO_DIR"
printf '{"tasks":{}}\n' > "$STATE_FILE"
: > "$GIT_STUB_SHAS_FILE"
: > "$GIT_STUB_WORKTREE_FILE"
: > "$GIT_STUB_UPDATE_REF_LOG"
source "$COMMON"

run_preflight() {
  local branch="$1" out="$TMP/preflight.json" rc=0
  rm -f "$out"
  wavemill_base_ref_preflight "$branch" --force-fetch --json-out "$out" || rc=$?
  printf '%s\n' "$rc"
}

echo "=== Base Ref Preflight ==="

: > "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/remotes/origin/main" >> "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=0
export GIT_STUB_DEFAULT_BRANCH="origin/main"
rc="$(run_preflight "auto/integration")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_unavailable" ]]; then
  pass "absent remote branch reports unavailable"
else
  fail "absent remote branch did not report base_ref_unavailable"
fi
if [[ "$(jq -r '.checkedRefs | join(",")' <<<"$json")" == "refs/remotes/origin/auto/integration,refs/heads/auto/integration" ]]; then
  pass "checked refs are origin-first by default"
else
  fail "checked refs are not origin-first as expected"
fi
diagnostic="$(wavemill_format_base_ref_preflight_failure "$json")"
if grep -q 'Available default branch: origin/main.' <<<"$diagnostic"; then
  pass "failure diagnostic includes default branch"
else
  fail "failure diagnostic omitted default branch"
fi

: > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=0
unset GIT_STUB_DEFAULT_BRANCH
rc="$(run_preflight "missing")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_unavailable" ]] && [[ "$(jq -r 'has("resolvedRef")' <<<"$json")" == "false" ]]; then
  pass "absent local and remote branch has no resolved ref"
else
  fail "absent local and remote branch resolved unexpectedly"
fi

printf '%s\n' "refs/heads/main" > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -eq 0 ]] && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]] && [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/heads/main" ]]; then
  pass "fetch failure proceeds with valid local branch"
else
  fail "fetch failure did not use valid local branch"
fi

printf '%s\n' "refs/remotes/origin/main" > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -eq 0 ]] && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]] && [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/remotes/origin/main" ]]; then
  pass "fetch failure proceeds with valid remote-tracking branch"
else
  fail "fetch failure did not use valid remote-tracking branch"
fi

: > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_fetch_failed" ]]; then
  pass "fetch failure with no fallback reports fetch failure"
else
  fail "fetch failure with no fallback reason was not base_ref_fetch_failed"
fi

# Both refs exist + successful fetch → origin/main wins
: > "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/heads/main" >> "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/remotes/origin/main" >> "$GIT_STUB_REFS_FILE"
: > "$GIT_STUB_SHAS_FILE"
printf '%s\t%s\n' "refs/heads/main" "0000000000000000000000000000000000000015" >> "$GIT_STUB_SHAS_FILE"
printf '%s\t%s\n' "refs/remotes/origin/main" "0000000000000000000000000000000000000042" >> "$GIT_STUB_SHAS_FILE"
: > "$GIT_STUB_WORKTREE_FILE"
export GIT_STUB_FETCH_RC=0
export GIT_STUB_REV_LIST_LEFT_RIGHT="0	2"
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/remotes/origin/main" ]] \
  && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "false" ]] \
  && [[ "$(jq -r '.checkedRefs[0]' <<<"$json")" == "refs/remotes/origin/main" ]]; then
  pass "both refs exist and fetch succeeded → origin/main wins"
else
  fail "both refs exist and fetch succeeded but origin/main was not chosen"
fi
if [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "true" ]] \
  && [[ "$(jq -r '.localBehindOrigin' <<<"$json")" == "0" ]]; then
  pass "clean local behind origin fast-forwards (behind=0 after ff)"
else
  fail "clean local behind origin did not fast-forward (behind=$(jq -r '.localBehindOrigin' <<<"$json") ff=$(jq -r '.localFastForwarded' <<<"$json"))"
fi
if grep -q 'refs/heads/main	0000000000000000000000000000000000000042	0000000000000000000000000000000000000015' "$GIT_STUB_UPDATE_REF_LOG"; then
  pass "fast-forward invokes update-ref with old value (CAS)"
else
  fail "fast-forward did not invoke update-ref with old value"
fi
unset GIT_STUB_REV_LIST_LEFT_RIGHT

# Both refs exist, fetch failed → local main wins with warning
: > "$GIT_STUB_UPDATE_REF_LOG"
export GIT_STUB_FETCH_RC=42
export GIT_STUB_REV_LIST_LEFT_RIGHT="0	2"
warn_out="$(run_preflight "main" 2>&1 >/dev/null)"
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/heads/main" ]] \
  && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]]; then
  pass "both refs exist and fetch failed → local main wins with fetchDegraded"
else
  fail "both refs exist and fetch failed but local main was not chosen"
fi
if grep -q "fetchDegraded" <<<"$warn_out"; then
  pass "degraded fetch emits warning naming fetchDegraded"
else
  fail "degraded fetch did not emit fetchDegraded warning"
fi
if [[ ! -s "$GIT_STUB_UPDATE_REF_LOG" ]]; then
  pass "degraded fetch does not fast-forward local branch"
else
  fail "degraded fetch attempted a fast-forward"
fi
unset GIT_STUB_REV_LIST_LEFT_RIGHT

# Local checked out → not fast-forwarded
: > "$GIT_STUB_UPDATE_REF_LOG"
: > "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/heads/auto/integration" >> "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/remotes/origin/auto/integration" >> "$GIT_STUB_REFS_FILE"
: > "$GIT_STUB_SHAS_FILE"
printf '%s\t%s\n' "refs/heads/auto/integration" "0000000000000000000000000000000000000015" >> "$GIT_STUB_SHAS_FILE"
printf '%s\t%s\n' "refs/remotes/origin/auto/integration" "0000000000000000000000000000000000000042" >> "$GIT_STUB_SHAS_FILE"
printf 'worktree /tmp/op\nbranch refs/heads/auto/integration\n' > "$GIT_STUB_WORKTREE_FILE"
export GIT_STUB_FETCH_RC=0
export GIT_STUB_REV_LIST_LEFT_RIGHT="0	2"
rc="$(run_preflight "auto/integration")"
json="$(cat "$TMP/preflight.json")"
if [[ "$(jq -r '.localCheckedOut' <<<"$json")" == "true" ]] \
  && [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "false" ]] \
  && [[ "$(jq -r '.localCheckoutPath' <<<"$json")" == "/tmp/op" ]]; then
  pass "checked-out base is reported and never fast-forwarded"
else
  fail "checked-out base was fast-forwarded or not detected"
fi
if [[ ! -s "$GIT_STUB_UPDATE_REF_LOG" ]]; then
  pass "checked-out base does not invoke update-ref"
else
  fail "checked-out base invoked update-ref anyway"
fi
unset GIT_STUB_REV_LIST_LEFT_RIGHT

# Diverged local branch → no fast-forward
: > "$GIT_STUB_UPDATE_REF_LOG"
: > "$GIT_STUB_WORKTREE_FILE"
export GIT_STUB_REV_LIST_LEFT_RIGHT="1	2"
rc="$(run_preflight "auto/integration")"
json="$(cat "$TMP/preflight.json")"
if [[ "$(jq -r '.localAheadOfOrigin' <<<"$json")" == "1" ]] \
  && [[ "$(jq -r '.localBehindOrigin' <<<"$json")" == "2" ]] \
  && [[ "$(jq -r '.localFastForwarded' <<<"$json")" == "false" ]]; then
  pass "diverged local branch is reported and not fast-forwarded"
else
  fail "diverged local branch state not reported correctly"
fi
if [[ ! -s "$GIT_STUB_UPDATE_REF_LOG" ]]; then
  pass "diverged local branch does not invoke update-ref"
else
  fail "diverged local branch invoked update-ref"
fi
unset GIT_STUB_REV_LIST_LEFT_RIGHT

# base_compare_ref pass-through and fallback
: > "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/remotes/origin/main" >> "$GIT_STUB_REFS_FILE"
if [[ "$(wavemill_base_compare_ref "origin/x")" == "origin/x" ]]; then
  pass "compare_ref passes through origin/x"
else
  fail "compare_ref did not pass through origin/x"
fi
if [[ "$(wavemill_base_compare_ref "refs/heads/x")" == "refs/heads/x" ]]; then
  pass "compare_ref passes through refs/heads/x"
else
  fail "compare_ref did not pass through refs/heads/x"
fi
if [[ "$(wavemill_base_compare_ref "0123456789abcdef0123456789abcdef01234567")" == "0123456789abcdef0123456789abcdef01234567" ]]; then
  pass "compare_ref passes through explicit SHA"
else
  fail "compare_ref did not pass through explicit SHA"
fi
if [[ "$(wavemill_base_compare_ref "main")" == "origin/main" ]]; then
  pass "compare_ref rewrites bare name to origin/main when origin ref exists"
else
  fail "compare_ref did not rewrite bare name to origin/main"
fi
if [[ "$(wavemill_base_compare_ref "unknown-branch")" == "unknown-branch" ]]; then
  pass "compare_ref falls back to bare name when origin ref missing"
else
  fail "compare_ref did not fall back to bare name"
fi

# --prefer-local flag on checked_refs reverses the order
out="$(wavemill_base_ref_checked_refs "main" --prefer-local | head -2 | paste -sd, -)"
if [[ "$out" == "refs/heads/main,refs/remotes/origin/main" ]]; then
  pass "--prefer-local flag reverses checked_refs order"
else
  fail "--prefer-local did not reverse checked_refs order (got: $out)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
