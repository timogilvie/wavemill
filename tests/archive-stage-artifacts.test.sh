#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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

REPO_DIR="$tmp/repo"
WORKTREE_ROOT="$REPO_DIR/worktrees"
feature_dir="$WORKTREE_ROOT/demo/features/demo"
archive_dir="$REPO_DIR/.wavemill/evals/artifacts/HOK-2766"
mkdir -p "$feature_dir"

printf '{"severity":"major","type":"operator_recovery"}\n' > "$feature_dir/.operator-intervention.json"
printf '{"stage":"planning","status":"completed","startedAt":"2026-01-01T00:00:00Z","finishedAt":"2026-01-01T00:01:00Z","agent":"claude","model":"m","notes":""}\n' > "$feature_dir/.planning-result.json"
printf '{"stage":"coding","status":"failed","startedAt":"2026-01-01T00:00:00Z","finishedAt":"2026-01-01T00:01:00Z","agent":"native","model":"m","notes":"bad"}\n' > "$feature_dir/.coding-result.attempt-1-failed.json"
printf '{bad\n' > "$feature_dir/.coding-result.json"
printf '{"payload":{"state":"working","timestamp":1}}\n' > "$feature_dir/.terminal-history.jsonl"
printf '{"seq":1,"command":"advance","at":"2026-01-01T00:00:00Z"}\n' > "$feature_dir/.operator-events.jsonl"

warnings="$tmp/warnings.log"
(
  set -euo pipefail
  source "$COMMON_SCRIPT"
  log() { :; }
  log_warn() { printf '%s\n' "$*" >> "$warnings"; }
  trace_read_id() { return 1; }
  trace_append_event() { :; }
  export REPO_DIR WORKTREE_ROOT warnings
  archive_stage_artifacts "HOK-2766" "demo"
)

[[ -f "$archive_dir/operator-intervention.json" ]] || { echo "missing operator archive" >&2; exit 1; }
# HOK-3182: reliability evidence survives reaping.
cmp -s "$feature_dir/.terminal-history.jsonl" "$archive_dir/terminal-history.jsonl" || { echo "missing terminal history archive" >&2; exit 1; }
cmp -s "$feature_dir/.operator-events.jsonl" "$archive_dir/operator-events.jsonl" || { echo "missing operator events archive" >&2; exit 1; }
[[ -f "$archive_dir/planning-result.json" ]] || { echo "missing planning result archive" >&2; exit 1; }
[[ -f "$archive_dir/coding-result.attempt-1-failed.json" ]] || { echo "missing failed attempt archive" >&2; exit 1; }
[[ ! -f "$archive_dir/coding-result.json" ]] || { echo "malformed coding result was archived" >&2; exit 1; }
grep -q "Skipping invalid stage result archive" "$warnings" || { echo "missing invalid JSON warning" >&2; exit 1; }

echo "archive-stage-artifacts test passed"
