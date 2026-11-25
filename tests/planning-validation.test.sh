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

check_file_exists() {
  local name="$1"
  local path="$2"
  if [[ -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_file_absent() {
  local name="$1"
  local path="$2"
  if [[ ! -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_file_content() {
  local name="$1"
  local expected="$2"
  local path="$3"
  local actual=""
  if [[ -f "$path" ]]; then
    actual="$(<"$path")"
  fi
  check_eq "$name" "$expected" "$actual"
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

log_warn() { :; }
eval "$(extract_function "$MONITOR_SCRIPT_FILE" capture_planning_baseline)"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" validate_planning_phase_output)"
source "$REPO_DIR/shared/lib/mill-owned-paths.sh"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" wavemill_owned_feature_artifact_path)"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" wavemill_owned_dirty_path)"

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

create_repo() {
  local slug="${1:-my-task}"
  local repo="$TEST_TMP/$slug"

  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "tests@example.com"
  git -C "$repo" config user.name "Wavemill Tests"

  mkdir -p "$repo/features/$slug"
  printf 'initial\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "Initial commit"

  printf '%s\n' "$repo"
}

run_validation() {
  local repo="$1"
  set +e
  validate_planning_phase_output "$repo"
  local status=$?
  set -e
  printf '%s\n' "$status"
}

echo "=== Planning Phase Validation ==="

repo="$(create_repo planning-artifacts)"
mkdir -p "$repo/features/planning-artifacts"
printf 'plan\n' > "$repo/features/planning-artifacts/plan.md"
printf 'packet\n' > "$repo/features/planning-artifacts/task-packet.md"
printf '{}\n' > "$repo/features/planning-artifacts/.initial-route.json"
touch "$repo/features/planning-artifacts/.plan-approved"
check_eq "allows planning artifacts under features/" "0" "$(run_validation "$repo")"
check_file_exists "keeps .plan-approved for planning artifacts" "$repo/features/planning-artifacts/.plan-approved"

repo="$(create_repo runtime-artifacts)"
mkdir -p "$repo/.wavemill/logs" "$repo/.wavemill/evals" "$repo/features/runtime-artifacts"
printf '{"warning":"linear"}\n' > "$repo/.wavemill/logs/linear-validation-warnings.jsonl"
printf '{"prompt":"registry"}\n' > "$repo/.wavemill/evals/prompt-registry.jsonl"
touch "$repo/features/runtime-artifacts/.plan-approved"
check_eq "allows wavemill runtime artifacts under .wavemill/" "0" "$(run_validation "$repo")"
check_file_exists "keeps .plan-approved for runtime artifacts" "$repo/features/runtime-artifacts/.plan-approved"

repo="$(create_repo local-config-overlay)"
mkdir -p "$repo/features/local-config-overlay"
printf '{"router":{"llmModel":"local-model"}}\n' > "$repo/.wavemill-config.local.json"
touch "$repo/features/local-config-overlay/.plan-approved"
check_eq "allows the per-developer local config overlay" "0" "$(run_validation "$repo")"
check_file_exists "keeps local config overlay during planning" "$repo/.wavemill-config.local.json"
check_file_exists "keeps .plan-approved for local config overlay" "$repo/features/local-config-overlay/.plan-approved"

repo="$(create_repo untracked-source)"
mkdir -p "$repo/src" "$repo/features/untracked-source"
printf 'export const value = 1;\n' > "$repo/src/new-feature.ts"
touch "$repo/features/untracked-source/.plan-approved"
check_eq "rejects untracked source files outside allowed roots" "1" "$(run_validation "$repo")"
check_file_absent "removes untracked source overreach" "$repo/src/new-feature.ts"
check_file_absent "removes .plan-approved after untracked overreach" "$repo/features/untracked-source/.plan-approved"

repo="$(create_repo tracked-source)"
mkdir -p "$repo/shared/lib" "$repo/features/tracked-source"
printf 'original\n' > "$repo/shared/lib/foo.sh"
git -C "$repo" add shared/lib/foo.sh
git -C "$repo" commit -q -m "Add tracked source"
printf 'modified\n' > "$repo/shared/lib/foo.sh"
touch "$repo/features/tracked-source/.plan-approved"
check_eq "rejects tracked source edits outside allowed roots" "1" "$(run_validation "$repo")"
check_file_content "reverts tracked source edits" "original" "$repo/shared/lib/foo.sh"
check_file_absent "removes .plan-approved after tracked overreach" "$repo/features/tracked-source/.plan-approved"

repo="$(create_repo source-overreach-marker)"
mkdir -p "$repo/src" "$repo/features/source-overreach-marker" "$repo/.wavemill/logs"
printf 'bad\n' > "$repo/src/bad.ts"
printf '{"ok":true}\n' > "$repo/.wavemill/logs/allowed.jsonl"
touch "$repo/features/source-overreach-marker/.plan-approved"
check_eq "rejects true source overreach even with allowed artifacts" "1" "$(run_validation "$repo")"
check_file_absent "removes .plan-approved only when source overreach exists" "$repo/features/source-overreach-marker/.plan-approved"

repo="$(create_repo pre-existing-dirty)"
mkdir -p "$repo/src" "$repo/features/pre-existing-dirty"
printf 'original\n' > "$repo/src/existing.ts"
git -C "$repo" add src/existing.ts
git -C "$repo" commit -q -m "Add existing source"
printf 'pre-existing tracked\n' > "$repo/src/existing.ts"
printf 'pre-existing untracked\n' > "$repo/src/pre-existing.txt"
printf 'src/existing.ts\nsrc/pre-existing.txt\n' > "$repo/features/pre-existing-dirty/.planning-baseline-dirty"
printf 'planning overreach\n' > "$repo/src/new-overreach.ts"
touch "$repo/features/pre-existing-dirty/.plan-approved"
check_eq "rejects only planning delta beyond baseline" "1" "$(run_validation "$repo")"
check_file_content "keeps baseline tracked content" "pre-existing tracked" "$repo/src/existing.ts"
check_file_content "keeps baseline untracked content" "pre-existing untracked" "$repo/src/pre-existing.txt"
check_file_absent "stashes new planning overreach" "$repo/src/new-overreach.ts"
check_eq "creates one recovery stash" "1" "$(git -C "$repo" stash list | wc -l | tr -d ' ')"
check_eq "stash contains only planning delta" "src/new-overreach.ts" "$(git -C "$repo" stash show --include-untracked --name-only stash@{0})"
git -C "$repo" stash pop -q stash@{0}
check_file_content "stash pop restores planning overreach" "planning overreach" "$repo/src/new-overreach.ts"

repo="$(create_repo baseline-only-dirty)"
mkdir -p "$repo/src" "$repo/features/baseline-only-dirty"
printf 'baseline only\n' > "$repo/src/baseline-only.ts"
printf 'src/baseline-only.ts\n' > "$repo/features/baseline-only-dirty/.planning-baseline-dirty"
touch "$repo/features/baseline-only-dirty/.plan-approved"
check_eq "allows baseline-only dirt" "0" "$(run_validation "$repo")"
check_file_exists "keeps approval for baseline-only dirt" "$repo/features/baseline-only-dirty/.plan-approved"
check_eq "does not stash baseline-only dirt" "0" "$(git -C "$repo" stash list | wc -l | tr -d ' ')"

repo="$(create_repo prompt-registry-tracked)"
mkdir -p "$repo/features/prompt-registry-tracked"
printf 'old\n' > "$repo/prompt-registry.jsonl"
git -C "$repo" add prompt-registry.jsonl
git -C "$repo" commit -q -m "Track prompt registry"
printf 'new\n' > "$repo/prompt-registry.jsonl"
touch "$repo/features/prompt-registry-tracked/.plan-approved"
check_eq "allows tracked root prompt registry" "0" "$(run_validation "$repo")"
check_file_content "keeps tracked root prompt registry" "new" "$repo/prompt-registry.jsonl"

repo="$(create_repo prompt-registry-untracked)"
mkdir -p "$repo/features/prompt-registry-untracked"
printf 'generated\n' > "$repo/prompt-registry.jsonl"
touch "$repo/features/prompt-registry-untracked/.plan-approved"
check_eq "allows untracked root prompt registry" "0" "$(run_validation "$repo")"
check_file_content "keeps untracked root prompt registry" "generated" "$repo/prompt-registry.jsonl"

repo="$(create_repo no-substring-match)"
printf 'not allowed\n' > "$repo/my-prompt-registry.jsonl"
touch "$repo/features/no-substring-match/.plan-approved"
check_eq "rejects prompt registry substring" "1" "$(run_validation "$repo")"
check_file_absent "stashes prompt registry substring" "$repo/my-prompt-registry.jsonl"

repo="$(create_repo missing-baseline)"
mkdir -p "$repo/src"
printf 'planning output\n' > "$repo/src/missing-baseline.ts"
touch "$repo/features/missing-baseline/.plan-approved"
check_eq "missing baseline rejects via stash" "1" "$(run_validation "$repo")"
check_file_absent "missing baseline stashes overreach" "$repo/src/missing-baseline.ts"
git -C "$repo" stash pop -q stash@{0}
check_file_content "missing baseline stash is recoverable" "planning output" "$repo/src/missing-baseline.ts"

repo="$(create_repo stash-failure)"
mkdir -p "$repo/src" "$repo/features/stash-failure"
printf 'do not delete\n' > "$repo/src/keep.ts"
touch "$repo/features/stash-failure/.plan-approved"
stub_dir="$TEST_TMP/git-stub"
mkdir -p "$stub_dir"
real_git="$(command -v git)"
cat > "$stub_dir/git" <<STUB
#!/usr/bin/env bash
if [[ "\$*" == *" stash push "* ]]; then
  exit 1
fi
exec "$real_git" "\$@"
STUB
chmod +x "$stub_dir/git"
old_path="$PATH"
PATH="$stub_dir:$PATH"
check_eq "stash failure still rejects" "1" "$(run_validation "$repo")"
PATH="$old_path"
check_file_content "stash failure leaves file in place" "do not delete" "$repo/src/keep.ts"
check_file_absent "stash failure removes approval" "$repo/features/stash-failure/.plan-approved"

repo="$(create_repo allowed-marker)"
mkdir -p "$repo/features/allowed-marker" "$repo/.wavemill/logs"
printf 'plan\n' > "$repo/features/allowed-marker/plan.md"
printf '{"ok":true}\n' > "$repo/.wavemill/logs/foo.jsonl"
touch "$repo/features/allowed-marker/.plan-approved"
check_eq "accepts only allowed planning and runtime artifacts" "0" "$(run_validation "$repo")"
check_file_exists "preserves .plan-approved when no source overreach exists" "$repo/features/allowed-marker/.plan-approved"

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS planning validation tests passed"
else
  echo "$FAIL planning validation tests failed ($PASS passed)"
  exit 1
fi
