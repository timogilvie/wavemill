#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

eval "$(extract_function "$MONITOR_SCRIPT_FILE" coding_output_dirty_paths)"
source "$REPO_DIR/shared/lib/mill-owned-paths.sh"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" wavemill_owned_feature_artifact_path)"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" wavemill_owned_dirty_path)"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" blocked_completion_auto_allowed_dirty_path)"

allowed_by() {
  local fn="$1" path="$2" slug="${3:-guard-task}"
  if "$fn" "$path" "$slug"; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

echo "=== Wavemill Guard Allowlist ==="

slug="guard-task"
paths=(
  ".wavemill/x"
  ".wavemill-config.local.json"
  ".claude/settings.local.json"
  "prompt-registry.jsonl"
  "features/$slug/challenge-intent.json"
  "features/$slug/.challenge-intent.json"
  "features/$slug/plan.md"
  "src/app.ts"
  "features/other-task/plan.md"
  "my-prompt-registry.jsonl"
  "challenge-intent.json"
)
expected=(0 1 1 1 1 1 1 0 0 0 0)

for i in "${!paths[@]}"; do
  check_eq "shared allowlist ${paths[$i]}" "${expected[$i]}" "$(allowed_by wavemill_owned_dirty_path "${paths[$i]}" "$slug")"
  check_eq "coding gate agrees ${paths[$i]}" "${expected[$i]}" "$(allowed_by blocked_completion_auto_allowed_dirty_path "${paths[$i]}" "$slug")"
done

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

repo="$TEST_TMP/$slug"
mkdir -p "$repo/features/$slug" "$repo/src"
git -C "$TEST_TMP" init -q "$slug"
git -C "$repo" config user.email "tests@example.com"
git -C "$repo" config user.name "Wavemill Tests"
printf 'initial\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m "Initial commit"

printf '{}\n' > "$repo/features/$slug/challenge-intent.json"
printf '{"prompt":"registry"}\n' > "$repo/prompt-registry.jsonl"
printf 'source\n' > "$repo/src/x.ts"

check_eq "coding dirty paths report only source" "src/x.ts" "$(coding_output_dirty_paths "$repo" "$slug")"

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS guard allowlist tests passed"
else
  echo "$FAIL guard allowlist tests failed ($PASS passed)"
  exit 1
fi
