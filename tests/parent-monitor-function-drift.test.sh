#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_DIR/tools/check-parent-monitor-drift.ts"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

# HOK-2900: the parent/monitor save_task_state pair is gone — the canonical
# writer lives in shared/lib/wavemill-common.sh and both live scopes source it.
# HOK-2901: the parent/monitor linear_set_state and linear_is_completed
# helpers are gone from both scopes — the canonical implementations live in
# shared/lib/wavemill-common.sh and are inherited by both mill and monitor.
# HOK-2902: completed-task and remote-branch cleanup are now common helpers.
# HOK-2903: the parent/monitor get_task_phase and remove_task_state copies are
# gone — the canonical helpers live in shared/lib/wavemill-common.sh and are
# inherited by the mill, the monitor, and the startup runner.
# HOK-2904: the parent/monitor pr_state and validate_pr_merge copies are gone
# — the canonical helpers live in shared/lib/wavemill-common.sh and are
# inherited by the mill and the monitor.
# HOK-2905: challenge hard-failure resolution is gone from both local scopes;
# the canonical monitor-semantics helper lives in shared/lib/wavemill-common.sh.
# HOK-2906: _with_timeout is gone from both local scopes; the canonical
# implementation lives in shared/lib/wavemill-common.sh, alongside
# wavemill_git_remote_with_timeout.
# HOK-2924: challenge_eval_retry_max_attempts and
# challenge_eval_hard_failure_max_retries are gone from both local scopes;
# the canonical ceilings live in shared/lib/wavemill-common.sh next to
# resolve_challenge_pair_hard_failure, which consumes them.
# HOK-2923: set_window_attention_state and clear_window_attention_state remain
# intentionally duplicated while both parent and monitor scopes are migrated
# to the shared transient-marker lifecycle contract.
# HOK-3007: write_invalid_challenge_artifact is duplicated with the manual
# comparison artifact helper so monitor and parent operator artifacts stay in sync.
# HOK-3065: release_challenge_selection_health_plan is gone from both local
# scopes — challenge selection is now sealed at t=0 and materialized against the
# expanded route, so the release-plan health helper is no longer needed in either
# scope. This drops the duplicated/identical pair count from 37 to 36.
EXPECTED_DIVERGENT=""

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-parent-monitor-drift.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

run_json() {
  local parent="$1"
  local monitor="$2"
  npx tsx "$CLI" --parent "$parent" --monitor "$monitor" --json
}

print_human_report() {
  local parent="$1"
  local monitor="$2"
  npx tsx "$CLI" --parent "$parent" --monitor "$monitor" || true
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local parent="${4:-$MILL_SCRIPT}"
  local monitor="${5:-$MONITOR_SCRIPT_FILE}"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $message" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    echo "" >&2
    print_human_report "$parent" "$monitor" >&2
    exit 1
  fi
}

baseline_json="$work_dir/baseline.json"
run_json "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" > "$baseline_json"

duplicated_count="$(jq '.duplicated | length' "$baseline_json")"
identical_count="$(jq '.identical | length' "$baseline_json")"
divergent_count="$(jq '.divergent | length' "$baseline_json")"
divergent_names="$(jq -r '.divergent[].name' "$baseline_json" | sort)"

assert_eq "$duplicated_count" "36" "duplicated parent/monitor function count changed"
assert_eq "$identical_count" "36" "byte-identical parent/monitor function count changed"
assert_eq "$divergent_count" "0" "allowlisted divergent parent/monitor function count changed"
assert_eq "$divergent_names" "$EXPECTED_DIVERGENT" "allowlisted divergent parent/monitor function names changed"

mutated_monitor="$work_dir/mutated-identical-monitor.sh"
cp "$MONITOR_SCRIPT_FILE" "$mutated_monitor"
node - "$mutated_monitor" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
const marker = 'indent_block() {\n';
const text = readFileSync(file, 'utf8');
const index = text.indexOf(marker);
if (index === -1) throw new Error(`missing mutation marker ${marker}`);
writeFileSync(file, `${text.slice(0, index + marker.length)}  # monitor drift probe\n${text.slice(index + marker.length)}`);
NODE

mutated_json="$work_dir/mutated-identical.json"
run_json "$MILL_SCRIPT" "$mutated_monitor" > "$mutated_json"
mutated_divergent="$(jq -r '.divergent[].name' "$mutated_json" | sort)"
if ! grep -qx 'indent_block' <<< "$mutated_divergent"; then
  echo "FAIL: mutating one copy of an identical function was not detected" >&2
  print_human_report "$MILL_SCRIPT" "$mutated_monitor" >&2
  exit 1
fi

new_duplicate_parent="$work_dir/new-duplicate-parent.sh"
new_duplicate_monitor="$work_dir/new-duplicate-monitor.sh"
cp "$MILL_SCRIPT" "$new_duplicate_parent"
cp "$MONITOR_SCRIPT_FILE" "$new_duplicate_monitor"
probe_function=$'hok_2897_probe_duplicate() {\n  echo parent-monitor-drift-probe\n}\n'
printf '%s' "$probe_function" >> "$new_duplicate_parent"
printf '%s' "$probe_function" >> "$new_duplicate_monitor"

new_duplicate_json="$work_dir/new-duplicate.json"
run_json "$new_duplicate_parent" "$new_duplicate_monitor" > "$new_duplicate_json"
new_duplicate_count="$(jq '.duplicated | length' "$new_duplicate_json")"
assert_eq "$new_duplicate_count" "37" "introducing a new duplicated function was not detected" "$new_duplicate_parent" "$new_duplicate_monitor"

echo "parent-monitor-function-drift: ok"
