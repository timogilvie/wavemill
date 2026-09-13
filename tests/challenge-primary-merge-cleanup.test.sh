#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helper_file="$tmp/primary-merge-helper.sh"
extract_function "$MONITOR_SCRIPT_FILE" "resolve_pair_on_primary_merge" > "$helper_file"
extract_function "$MONITOR_SCRIPT_FILE" "cleanup_merged_primary_challenge_task" >> "$helper_file"

case_dir="$tmp/case"
mkdir -p "$case_dir/repo/.wavemill/evals"
STATE_FILE="$case_dir/repo/.wavemill/workflow-state.json"
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-2881": {
      "pr": 1230,
      "branch": "task/primary",
      "challengePairId": "HOK-2881",
      "challengeRole": "primary",
      "challengeModel": "gpt-5",
      "evalCompleted": true
    },
    "HOK-2881_c": {
      "branch": "task/primary-challenger",
      "challengePairId": "HOK-2881",
      "challengeRole": "challenger",
      "challengeModel": "claude-sonnet-4",
      "phase": "review",
      "status": "active"
    }
  }
}
JSON
printf '{}\n' > "$case_dir/repo/.wavemill-config.json"

output="$(
  CASE_DIR="$case_dir" REPO_ROOT="$REPO_DIR" bash -lc '
    set -euo pipefail
    source "$CASE_DIR/../primary-merge-helper.sh"

    REPO_DIR="$CASE_DIR/repo"
    TOOLS_DIR="$REPO_ROOT/tools"
    STATE_FILE="$REPO_DIR/.wavemill/workflow-state.json"
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    COMPARED_PAIR=""

    get_task_meta() {
      local issue="$1" key="$2"
      jq -r --arg issue "$issue" --arg key "$key" ".tasks[\$issue][\$key] // \"\"" "$STATE_FILE"
    }
    mark_challenge_compared() {
      COMPARED_PAIR="$1"
      return 0
    }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }

    resolve_pair_on_primary_merge "HOK-2881" "1230"
    resolve_pair_on_primary_merge "HOK-2881" "1230"

    printf "phase=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].phase" "$STATE_FILE")"
    printf "status=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].status" "$STATE_FILE")"
    printf "reason=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].supersededReason" "$STATE_FILE")"
    printf "compared=%s\n" "$COMPARED_PAIR"
    printf "winner=%s\n" "$(jq -r ".winner" "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
    printf "terminal=%s\n" "$(jq -r ".terminalReason" "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
    printf "status_log=%s\n" "$LOG_OUTPUT"
  '
)"

[[ "$output" == *"phase=superseded"* ]] || { echo "$output"; echo "challenger phase was not superseded" >&2; exit 1; }
[[ "$output" == *"status=superseded"* ]] || { echo "$output"; echo "challenger status was not superseded" >&2; exit 1; }
[[ "$output" == *"reason=Primary already merged as PR #1230"* ]] || { echo "$output"; echo "superseded reason mismatch" >&2; exit 1; }
[[ "$output" == *"compared=HOK-2881"* ]] || { echo "$output"; echo "pair was not marked compared" >&2; exit 1; }
[[ "$output" == *"winner=primary"* ]] || { echo "$output"; echo "comparison record winner mismatch" >&2; exit 1; }
[[ "$output" == *"terminal=primary_merged"* ]] || { echo "$output"; echo "terminal reason mismatch" >&2; exit 1; }
[[ "$output" != *"already resolved, primary merge cleanup continuing"* ]] || { echo "$output"; echo "already-resolved cleanup status was logged" >&2; exit 1; }

preserve_output="$(
  CASE_DIR="$case_dir" REPO_ROOT="$REPO_DIR" bash -lc '
    set -euo pipefail
    source "$CASE_DIR/../primary-merge-helper.sh"

    REPO_DIR="$CASE_DIR/repo"
    STATE_FILE="$REPO_DIR/.wavemill/workflow-state.json"
    CLEANUP_COUNT=0
    cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2881": {
      "pr": 1230,
      "branch": "task/primary",
      "slug": "primary",
      "challengePairId": "HOK-2881",
      "challengeRole": "primary",
      "challengeModel": "gpt-5",
      "evalCompleted": true
    }
  }
}
JSON

    get_task_meta() {
      local issue="$1" key="$2"
      jq -r --arg issue "$issue" --arg key "$key" ".tasks[\$issue][\$key] // \"\"" "$STATE_FILE"
    }
    state_mutate() {
      local file="$1" filter="$2" tmp
      shift 2
      tmp="$(mktemp)"
      jq "$@" "$filter" "$file" > "$tmp"
      mv "$tmp" "$file"
    }
    cleanup_completed_task() {
      CLEANUP_COUNT=$((CLEANUP_COUNT + 1))
      state_mutate "$STATE_FILE" "del(.tasks[\$issue])" --arg issue "$1"
    }
    log_warn() { :; }

    cleanup_merged_primary_challenge_task "HOK-2881" "primary" "post-review cleanup" "1230"

    printf "cleanup=%s\n" "$CLEANUP_COUNT"
    printf "primary_role=%s\n" "$(jq -r ".tasks[\"HOK-2881\"].challengeRole" "$STATE_FILE")"
    printf "primary_pr=%s\n" "$(jq -r ".tasks[\"HOK-2881\"].pr" "$STATE_FILE")"
    printf "primary_status=%s\n" "$(jq -r ".tasks[\"HOK-2881\"].status" "$STATE_FILE")"
    printf "primary_slug=%s\n" "$(jq -r ".tasks[\"HOK-2881\"].slug" "$STATE_FILE")"
  '
)"

[[ "$preserve_output" == *"cleanup=1"* ]] || { echo "$preserve_output"; echo "primary cleanup did not run" >&2; exit 1; }
[[ "$preserve_output" == *"primary_role=primary"* ]] || { echo "$preserve_output"; echo "primary role was not preserved" >&2; exit 1; }
[[ "$preserve_output" == *"primary_pr=1230"* ]] || { echo "$preserve_output"; echo "primary PR was not preserved" >&2; exit 1; }
[[ "$preserve_output" == *"primary_status=merged"* ]] || { echo "$preserve_output"; echo "primary status was not preserved as merged" >&2; exit 1; }
[[ "$preserve_output" == *"primary_slug=primary"* ]] || { echo "$preserve_output"; echo "primary slug was not preserved" >&2; exit 1; }

echo "challenge-primary-merge-cleanup test passed"
