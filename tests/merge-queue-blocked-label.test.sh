#!/usr/bin/env bash
# HOK-3111: Regression for wm:blocked PRs being promoted then demoted every ~15
# minutes forever. Exercises the planner and the monitor's transition-report
# recorder so the log spam described in the ticket cannot come back.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

# --- planner: a wm:blocked green PR is excluded, not selected, not stuck ---

INPUT="$TMP_DIR/input.json"
OUTPUT="$TMP_DIR/output.json"
cat >"$INPUT" <<'JSON'
{
  "now": "2026-09-29T12:00:00Z",
  "config": {
    "enabled": true,
    "maxConcurrentCandidates": 2,
    "stuckTimeoutSeconds": 900,
    "conflictGroupingEnabled": true,
    "skipCooldownSeconds": 60
  },
  "readyPrs": [
    {
      "issue": "HOK-3106",
      "slug": "blocked-pr",
      "prNumber": 1518,
      "branch": "task/blocked-pr",
      "queueState": "ready-stale",
      "changedFiles": ["a.ts"],
      "readyAt": "2026-09-29T11:30:00Z",
      "workflowStatus": "ready",
      "prState": "OPEN",
      "labels": ["wavemill", "wm:blocked"],
      "ci": {
        "conclusion": "pass",
        "headSha": "abcdef1",
        "mergeStateStatus": "CLEAN"
      }
    }
  ]
}
JSON

node --import tsx "$REPO_DIR/tools/merge-queue-select.ts" --input "$INPUT" >"$OUTPUT"

if [[ "$(jq -r '.selectedIssues | length' "$OUTPUT")" != "0" ]]; then
  echo "wm:blocked PR was selected as a candidate" >&2
  cat "$OUTPUT" >&2
  exit 1
fi
if [[ "$(jq -r '.stuckIssues | length' "$OUTPUT")" != "0" ]]; then
  echo "wm:blocked PR was reported stuck" >&2
  cat "$OUTPUT" >&2
  exit 1
fi
if [[ "$(jq -r '.excludedIssues | length' "$OUTPUT")" != "1" ]]; then
  echo "expected exactly one excludedIssues entry" >&2
  cat "$OUTPUT" >&2
  exit 1
fi
if [[ "$(jq -r '.excludedIssues[0].blockingLabel' "$OUTPUT")" != "wm:blocked" ]]; then
  echo "excludedIssues did not name wm:blocked" >&2
  cat "$OUTPUT" >&2
  exit 1
fi

# --- monitor sidecar: repeated ticks emit at most one status line per head ---

# Extract only the two recorder functions from the monitor script so the test
# does not have to boot the whole mill env.
extract_function() {
  local file="$1" name="$2"
  awk -v n="$name" '
    $0 ~ "^" n "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$file"
}

FUNCS="$TMP_DIR/monitor-funcs.sh"
{
  echo 'set -euo pipefail'
  echo 'log_warn() { :; }'
  echo 'MERGE_QUEUE_ESCALATION_THRESHOLD=3'
  extract_function "$MONITOR_SCRIPT_FILE" "merge_queue_exclusion_report"
  echo
  extract_function "$MONITOR_SCRIPT_FILE" "merge_queue_transition_report"
} > "$FUNCS"

STATE_DIR="$TMP_DIR/state" bash -c '
  # shellcheck source=/dev/null
  source "$1"
  d1=$(merge_queue_exclusion_report "1518" "abcdef1" "carries wm:blocked")
  d2=$(merge_queue_exclusion_report "1518" "abcdef1" "carries wm:blocked")
  d3=$(merge_queue_exclusion_report "1518" "abcdef1" "carries wm:blocked")
  printf "%s %s %s\n" "$d1" "$d2" "$d3"
  # A fresh head SHA legitimately re-emits status.
  d4=$(merge_queue_exclusion_report "1518" "beef123" "carries wm:blocked")
  printf "%s\n" "$d4"
' _ "$FUNCS" >"$TMP_DIR/exclusion-decisions.txt" 2>"$TMP_DIR/exclusion-decisions.err" || {
  cat "$TMP_DIR/exclusion-decisions.err" >&2
  exit 1
}

decisions="$(head -n1 "$TMP_DIR/exclusion-decisions.txt")"
if [[ "$decisions" != "log skip skip" ]]; then
  echo "expected exclusion dedup pattern 'log skip skip' but got '$decisions'" >&2
  exit 1
fi
fresh="$(sed -n 2p "$TMP_DIR/exclusion-decisions.txt")"
if [[ "$fresh" != "log" ]]; then
  echo "expected fresh head to re-emit 'log' but got '$fresh'" >&2
  exit 1
fi

# --- promote/demote cycle: escalates once at threshold, then suppresses ---

STATE_DIR="$TMP_DIR/state2" bash -c '
  # shellcheck source=/dev/null
  source "$1"
  # cycle 1: promoted (log) → demoted-stuck (log)
  a1=$(merge_queue_transition_report "42" "cafef00" "promoted")
  a2=$(merge_queue_transition_report "42" "cafef00" "demoted-stuck")
  # cycle 2: promoted (log) → demoted-stuck (log)
  a3=$(merge_queue_transition_report "42" "cafef00" "promoted")
  a4=$(merge_queue_transition_report "42" "cafef00" "demoted-stuck")
  # cycle 3: promoted → ESCALATE, demoted-stuck → skip
  a5=$(merge_queue_transition_report "42" "cafef00" "promoted")
  a6=$(merge_queue_transition_report "42" "cafef00" "demoted-stuck")
  # further cycles are suppressed
  a7=$(merge_queue_transition_report "42" "cafef00" "promoted")
  printf "%s %s %s %s %s %s %s\n" "$a1" "$a2" "$a3" "$a4" "$a5" "$a6" "$a7"
' _ "$FUNCS" >"$TMP_DIR/cycle-decisions.txt" 2>"$TMP_DIR/cycle-decisions.err" || {
  cat "$TMP_DIR/cycle-decisions.err" >&2
  exit 1
}

got="$(cat "$TMP_DIR/cycle-decisions.txt")"
expected="log log log log escalate skip skip"
if [[ "$got" != "$expected" ]]; then
  echo "unexpected transition-report cadence" >&2
  echo "  expected: $expected" >&2
  echo "  got:      $got" >&2
  exit 1
fi

echo "merge queue wm:blocked regression passed"
