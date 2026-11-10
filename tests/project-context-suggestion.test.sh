#!/usr/bin/env bash
# wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_FILE="$TMP_DIR/state.json"
TEST_REPO="$TMP_DIR/repo"
mkdir -p "$TEST_REPO/.wavemill"
printf '{"tasks":{}}\n' > "$STATE_FILE"

source "$REPO_DIR/shared/lib/wavemill-common.sh"
check_fn="$(extract_function "$MILL_SCRIPT" check_project_context_size)"
if [[ -z "$check_fn" ]]; then
  echo "Could not extract check_project_context_size"
  exit 1
fi

log() { :; }
wavemill_config_annotation() { :; }
REPO_DIR="$TEST_REPO"
PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB=1
export STATE_FILE REPO_DIR PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB

eval "$check_fn"

echo "=== Project Context Suggestion ==="

# 1. oversized sets suggestion
head -c 2048 /dev/zero | tr '\0' 'a' > "$TEST_REPO/.wavemill/project-context.md"
check_project_context_size
if jq -e '.project_context_suggestion.sizeBytes > .project_context_suggestion.thresholdBytes' "$STATE_FILE" >/dev/null 2>&1; then
  pass "sets project_context_suggestion when oversized"
else
  fail "sets project_context_suggestion when oversized"
fi

# 2. shrink clears suggestion
printf 'small\n' > "$TEST_REPO/.wavemill/project-context.md"
check_project_context_size
if jq -e '.project_context_suggestion == null' "$STATE_FILE" >/dev/null 2>&1; then
  pass "clears suggestion when file is under threshold"
else
  fail "clears suggestion when file is under threshold"
fi

# 3. missing file leaves no suggestion and no error
rm -f "$TEST_REPO/.wavemill/project-context.md"
check_project_context_size
if jq -e '.project_context_suggestion == null' "$STATE_FILE" >/dev/null 2>&1; then
  pass "missing file leaves suggestion cleared"
else
  fail "missing file leaves suggestion cleared"
fi

# 4. boundary behavior threshold and threshold+1
threshold_bytes=$((PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB * 1024))
head -c "$threshold_bytes" /dev/zero | tr '\0' 'b' > "$TEST_REPO/.wavemill/project-context.md"
check_project_context_size
if jq -e '.project_context_suggestion == null' "$STATE_FILE" >/dev/null 2>&1; then
  pass "exact threshold does not suggest compaction"
else
  fail "exact threshold does not suggest compaction"
fi

head -c $((threshold_bytes + 1)) /dev/zero | tr '\0' 'c' > "$TEST_REPO/.wavemill/project-context.md"
check_project_context_size
if jq -e '.project_context_suggestion.sizeBytes == ($size|tonumber)' --arg size "$((threshold_bytes + 1))" "$STATE_FILE" >/dev/null 2>&1; then
  pass "threshold+1 triggers compaction suggestion"
else
  fail "threshold+1 triggers compaction suggestion"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
