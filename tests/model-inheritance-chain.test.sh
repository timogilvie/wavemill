#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: expected '$2', got '$3'"; FAIL=$((FAIL + 1)); }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    fail "$name" "$expected" "$actual"
  fi
}

check_matches() {
  local name="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then
    pass "$name"
  else
    fail "$name" "$pattern" "$actual"
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RESOLVER="$TMP_DIR/resolve-model.ts"
cat > "$RESOLVER" <<EOF
import { readQuotaSnapshot } from '${REPO_ROOT}/shared/lib/quota-state.ts';
import { resolveEffectiveModel } from '${REPO_ROOT}/shared/lib/model-resolution.ts';

const selector = process.argv[2];
if (!selector) {
  throw new Error('missing selector');
}

const resolved = resolveEffectiveModel({
  workspaceSelector: selector,
  policyContext: {
    taskType: 'coding',
    difficulty: 'moderate',
    quotaState: readQuotaSnapshot(process.cwd()),
    repoDir: process.cwd(),
  },
});

process.stdout.write(String(resolved.resolved) + '\n');
EOF

resolve_selector() {
  local selector="$1"
  local parent="${2-}"

  if [[ -n "$parent" ]]; then
    (
      cd "$REPO_ROOT"
      WAVEMILL_RESOLVED_MODEL="$parent" node "$RESOLVER" "$selector"
    )
  else
    (
      cd "$REPO_ROOT"
      unset WAVEMILL_RESOLVED_MODEL
      node "$RESOLVER" "$selector"
    )
  fi
}

echo "=== Chain A ==="
default_without_parent="$(resolve_selector inherit)"
root_a="$(resolve_selector opus)"
child_a="$(resolve_selector inherit "$root_a")"
grandchild_a="$(resolve_selector inherit "$child_a")"
check_matches "chain A root resolves opus" '^claude-opus-' "$root_a"
check "chain A child inherits root" "$root_a" "$child_a"
check "chain A grandchild inherits child" "$child_a" "$grandchild_a"

echo ""
echo "=== Chain B ==="
root_b="$(resolve_selector opus)"
child_b="$(resolve_selector claude-haiku-4-5-20251001 "$root_b")"
grandchild_b="$(resolve_selector inherit "$child_b")"
check_matches "chain B root resolves opus" '^claude-opus-' "$root_b"
check "chain B child keeps pinned model" "claude-haiku-4-5-20251001" "$child_b"
check "chain B grandchild inherits pinned child" "$child_b" "$grandchild_b"

echo ""
echo "=== Chain C ==="
root_c="$default_without_parent"
child_c="$(resolve_selector opus "$root_c")"
grandchild_c="$(resolve_selector inherit "$child_c")"
check "chain C root falls back to default" "$default_without_parent" "$root_c"
check_matches "chain C child keeps explicit opus" '^claude-opus-' "$child_c"
check "chain C grandchild inherits explicit child" "$child_c" "$grandchild_c"

echo ""
echo "=== Edge Cases ==="
empty_parent="$(cd "$REPO_ROOT" && WAVEMILL_RESOLVED_MODEL='' node "$RESOLVER" inherit)"
check "empty parent env falls back to default" "$default_without_parent" "$empty_parent"

run_one_root="$(resolve_selector opus)"
run_one_child="$(resolve_selector inherit "$run_one_root")"
run_two_root="$(resolve_selector opus)"
run_two_child="$(resolve_selector inherit "$run_two_root")"
check "deterministic root resolution" "$run_one_root" "$run_two_root"
check "deterministic inherited resolution" "$run_one_child" "$run_two_child"

inherit_1="$(resolve_selector opus)"
inherit_2="$(resolve_selector inherit "$inherit_1")"
inherit_3="$(resolve_selector inherit "$inherit_2")"
inherit_4="$(resolve_selector inherit "$inherit_3")"
inherit_5="$(resolve_selector inherit "$inherit_4")"
inherit_6="$(resolve_selector inherit "$inherit_5")"
check "five-level inherit chain level 2" "$inherit_1" "$inherit_2"
check "five-level inherit chain level 3" "$inherit_1" "$inherit_3"
check "five-level inherit chain level 4" "$inherit_1" "$inherit_4"
check "five-level inherit chain level 5" "$inherit_1" "$inherit_5"
check "five-level inherit chain level 6" "$inherit_1" "$inherit_6"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
