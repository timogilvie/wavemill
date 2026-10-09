#!/usr/bin/env bash
# Boolean settings default to true only when unset; an explicit false is honoured.
#
# jq's `//` treats false like null, so `x // true` turned every configured
# `false` into `true` (mill.requireConfirm, mergeQueue.enabled, router.enabled,
# autoEval, ...). requireConfirm=false being ignored is why merged tasks waited
# forever for their review window to be closed instead of being reaped.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS  $label"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $label (expected '$expected', got '$actual')"; FAIL=$((FAIL + 1))
  fi
}

echo "=== load_config honours explicit false ==="
FALSE_REPO="$TMP_DIR/false-repo"
mkdir -p "$FALSE_REPO"
cat > "$FALSE_REPO/.wavemill-config.json" <<'EOF'
{
  "mill": { "requireConfirm": false },
  "autoEval": false,
  "router": { "enabled": false },
  "mergeQueue": { "enabled": false, "conflictGroupingEnabled": false },
  "integration": { "deleteBranchAfterMerge": false }
}
EOF
(
  export HOME="$TMP_DIR/home"
  mkdir -p "$HOME"
  unset REQUIRE_CONFIRM AUTO_EVAL ROUTER_ENABLED MERGE_QUEUE_ENABLED \
    MERGE_QUEUE_CONFLICT_GROUPING_ENABLED INTEGRATION_DELETE_BRANCH_AFTER_MERGE
  # shellcheck source=../shared/lib/wavemill-common.sh
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  load_config "$FALSE_REPO"
  printf '%s\n' "$REQUIRE_CONFIRM" "$AUTO_EVAL" "$ROUTER_ENABLED" \
    "$MERGE_QUEUE_ENABLED" "$MERGE_QUEUE_CONFLICT_GROUPING_ENABLED" \
    "$INTEGRATION_DELETE_BRANCH_AFTER_MERGE"
) > "$TMP_DIR/false.out"
mapfile -t got < "$TMP_DIR/false.out"
assert_eq "mill.requireConfirm=false" "false" "${got[0]:-}"
assert_eq "autoEval=false" "false" "${got[1]:-}"
assert_eq "router.enabled=false" "false" "${got[2]:-}"
assert_eq "mergeQueue.enabled=false" "false" "${got[3]:-}"
assert_eq "mergeQueue.conflictGroupingEnabled=false" "false" "${got[4]:-}"
assert_eq "integration.deleteBranchAfterMerge=false" "false" "${got[5]:-}"

echo "=== load_config still defaults unset booleans to true ==="
EMPTY_REPO="$TMP_DIR/empty-repo"
mkdir -p "$EMPTY_REPO"
echo '{}' > "$EMPTY_REPO/.wavemill-config.json"
(
  export HOME="$TMP_DIR/home"
  unset AUTO_EVAL ROUTER_ENABLED MERGE_QUEUE_ENABLED
  source "$REPO_DIR/shared/lib/wavemill-common.sh"
  load_config "$EMPTY_REPO"
  printf '%s\n' "$AUTO_EVAL" "$ROUTER_ENABLED" "$MERGE_QUEUE_ENABLED"
) > "$TMP_DIR/empty.out"
mapfile -t got < "$TMP_DIR/empty.out"
assert_eq "autoEval unset -> true" "true" "${got[0]:-}"
assert_eq "router.enabled unset -> true" "true" "${got[1]:-}"
assert_eq "mergeQueue.enabled unset -> true" "true" "${got[2]:-}"

echo "=== startup runner plan-file reads honour false ==="
plan_value() { # jq-filter plan-json
  jq -r "$1" <<<"$2"
}
filter="$(sed -n "s/^REQUIRE_CONFIRM=\"\$(jq -r '\([^']*\)'.*/\1/p" "$REPO_DIR/shared/lib/wavemill-startup-runner.sh")"
assert_eq "plan requireConfirm=false" "false" "$(plan_value "$filter" '{"monitorConfig":{"requireConfirm":false}}')"
assert_eq "plan requireConfirm unset -> true" "true" "$(plan_value "$filter" '{"monitorConfig":{}}')"

echo "=== guard: no '// true' boolean defaults in shell libs ==="
offenders="$(grep -nE '// true\b' "$REPO_DIR"/shared/lib/*.sh "$REPO_DIR/wavemill" | grep -vE '^\S+:[0-9]+:\s*#' || true)"
assert_eq "no '// true' defaults remain" "" "$offenders"

echo ""
echo "pass=$PASS fail=$FAIL"
exit "$FAIL"
