#!/usr/bin/env bash
# HOK-3182: interactive workflow-state edits are recorded as operator touches;
# mill label writes are recorded in the label-write ledger.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON_SCRIPT="$(cd "$SCRIPT_DIR/.." && pwd)/shared/lib/wavemill-common.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

wavemill_dir="$tmp/repo/.wavemill"
mkdir -p "$wavemill_dir"
state="$wavemill_dir/workflow-state.json"
printf '{"tasks":{"HOK-1":{"phase":"coding"}}}\n' > "$state"
touch_log="$wavemill_dir/operator-touches.jsonl"

# 1. Non-interactive (the monitor and every tool it spawns): no touch.
bash -c 'source "$1" >/dev/null 2>&1; state_mutate "$2" ".tasks[\$issue].phase = \"review\"" --arg issue HOK-1' _ "$COMMON_SCRIPT" "$state"
[[ "$(jq -r '.tasks["HOK-1"].phase' "$state")" == "review" ]] || fail "non-interactive mutate did not apply"
[[ ! -f "$touch_log" ]] || fail "non-interactive state_mutate recorded a touch"

# 2. Interactive shell: one state-edit touch naming the issue.
bash -i -c 'source "$1" >/dev/null 2>&1; state_mutate "$2" ".tasks[\$issue].phase = \"coding\"" --arg issue HOK-1' _ "$COMMON_SCRIPT" "$state" >/dev/null 2>&1 </dev/null
[[ "$(jq -r '.tasks["HOK-1"].phase' "$state")" == "coding" ]] || fail "interactive mutate did not apply"
[[ -f "$touch_log" ]] || fail "interactive state_mutate did not record a touch"
[[ "$(wc -l < "$touch_log" | tr -d ' ')" == "1" ]] || fail "expected exactly one touch"
[[ "$(jq -r '.kind' "$touch_log")" == "state-edit" ]] || fail "touch kind"
[[ "$(jq -r '.issue' "$touch_log")" == "HOK-1" ]] || fail "touch issue"
[[ "$(jq -r '.detail' "$touch_log")" == "state_mutate workflow-state.json" ]] || fail "touch detail"

# 3. Interactive edit of some other JSON state file: not a workflow-state touch.
other="$wavemill_dir/other.json"
printf '{}\n' > "$other"
bash -i -c 'source "$1" >/dev/null 2>&1; state_mutate "$2" ".x = 1"' _ "$COMMON_SCRIPT" "$other" >/dev/null 2>&1 </dev/null
[[ "$(wc -l < "$touch_log" | tr -d ' ')" == "1" ]] || fail "non-workflow-state file recorded a touch"

# 4. Mill label writes: recorded only inside a mill session with REPO_DIR.
ledger="$tmp/repo/.wavemill/label-writes.jsonl"
(
  source "$COMMON_SCRIPT" >/dev/null 2>&1
  unset WAVEMILL_SESSION SESSION
  REPO_DIR="$tmp/repo" mill_label_write_record 42 "wm:ready" "unlabeled"
)
[[ ! -f "$ledger" ]] || fail "label write recorded outside a mill session"
(
  source "$COMMON_SCRIPT" >/dev/null 2>&1
  WAVEMILL_SESSION=wavemill REPO_DIR="$tmp/repo" mill_label_write_record 42 "wm:ready" "unlabeled"
)
[[ "$(jq -c '{prNumber, label, action, writer, session}' "$ledger")" == '{"prNumber":42,"label":"wm:ready","action":"unlabeled","writer":"mill","session":"wavemill"}' ]] \
  || fail "unexpected ledger entry: $(cat "$ledger")"

echo "operator-touch-record test passed"
