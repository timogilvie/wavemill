#!/usr/bin/env bash
# Shared harness for the HOK-3206 async ready-check tests.
#
# Sources the real async-jobs library plus the monitor functions it consumes,
# and replaces the monitor's side-effect collaborators (tracked-job
# registration, attention markers, logging, tool spawns) with recorders under
# $HARNESS_DIR so tests can assert on what the gates did. Every write goes to
# the mkdtemp dir the caller passes (HOK-3157: never tracked repo paths).
#
# Usage: HARNESS_DIR=$(mktemp -d) source tests/fixtures/monitor-perf/async-harness.sh

HARNESS_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS_MONITOR="$HARNESS_REPO_DIR/shared/lib/wavemill-monitor.sh"

: "${HARNESS_DIR:?HARNESS_DIR must be set to a temp dir}"
mkdir -p "$HARNESS_DIR"

source "$HARNESS_REPO_DIR/shared/lib/wavemill-common.sh"
source "$HARNESS_REPO_DIR/shared/lib/transient-marker.sh"
source "$HARNESS_REPO_DIR/shared/lib/condition-reconciler.sh"
source "$HARNESS_REPO_DIR/shared/lib/monitor-async-jobs.sh"

harness_extract_function() {
  local name="$1"
  awk -v name="$name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }
    $0 ~ "^" name "\\(\\) \\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$HARNESS_MONITOR"
}

for _harness_fn in sanitize_job_token cross_pr_revert_gate_apply_result ready_watchdog_dispatch_findings; do
  eval "$(harness_extract_function "$_harness_fn")"
done
unset _harness_fn

SESSION="async-harness"
STATE_DIR="$HARNESS_DIR/mill-state"
STATE_FILE="$HARNESS_DIR/workflow-state.json"
TOOLS_DIR="$HARNESS_REPO_DIR/tools"
REPO_DIR="$HARNESS_DIR/repo"
API_TIMEOUT=20
WAVEMILL_LEDGER_SHADOW_DISABLED=1
mkdir -p "$STATE_DIR" "$REPO_DIR"
git -C "$REPO_DIR" init -q 2>/dev/null || true
[[ -f "$STATE_FILE" ]] || printf '{"tasks":{}}\n' > "$STATE_FILE"
export SESSION STATE_DIR STATE_FILE TOOLS_DIR REPO_DIR WAVEMILL_LEDGER_SHADOW_DISABLED
export MONITOR_PR_CACHE="$HARNESS_DIR/pr-cache.json"

# ── Recorders ────────────────────────────────────────────────────────────────

HARNESS_LOG="$HARNESS_DIR/calls.log"
: > "$HARNESS_LOG"
harness_record() { printf '%s\n' "$*" >> "$HARNESS_LOG"; }
harness_count() { grep -c -- "$1" "$HARNESS_LOG" 2>/dev/null || true; }

log() { harness_record "log $*"; }
log_warn() { harness_record "warn $*"; }
log_error() { harness_record "error $*"; }
log_task() { harness_record "log_task $*"; }

launch_tracked_job() { harness_record "launch_tracked_job kind=$1 id=$2 issue=$3 pr=$6 pid=$7 timeout=$8"; }
settle_tracked_job() { harness_record "settle_tracked_job $1"; }

write_cross_pr_guard_ready_result() { harness_record "guard_result pr=$2 head=$3 verdict=$4"; }
clear_cross_pr_guard_ready_evidence() { harness_record "guard_evidence_cleared $1"; }
_write_cross_pr_diagnostic() { harness_record "guard_diagnostic ref=$2 cmd=$3"; }
write_ready_attention_file() { harness_record "attention $2"; }
launch_ready_phase() { harness_record "launch_ready_phase $1 pr=$7"; }
pass_task_field() { jq -r --arg i "$1" --arg f "$2" '.tasks[$i][$f] // empty' "$STATE_FILE" 2>/dev/null; }
read_state_value() { local d="$1"; shift; jq -r "$@" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$d"; }
ready_state_dir() { printf '%s/features/%s\n' "$1" "$2"; }

# Tool stubs: behaviour comes from files under $HARNESS_DIR/tools/<name>.
#   <name>.rc      exit code (default 0)
#   <name>.out     stdout
#   <name>.err     stderr
#   <name>.sleep   seconds to sleep first
# Every invocation is recorded as "tool <name> <args>".
harness_tool_set() {
  local name="$1" rc="$2" out="${3-}" err="${4-}"
  mkdir -p "$HARNESS_DIR/tools"
  printf '%s\n' "$rc" > "$HARNESS_DIR/tools/$name.rc"
  printf '%s' "$out" > "$HARNESS_DIR/tools/$name.out"
  printf '%s' "$err" > "$HARNESS_DIR/tools/$name.err"
}

_harness_tool() {
  local name
  name="$(basename "$1")"
  shift
  harness_record "tool $name $*"
  local dir="$HARNESS_DIR/tools"
  [[ -f "$dir/$name.sleep" ]] && sleep "$(cat "$dir/$name.sleep")"
  [[ -f "$dir/$name.out" ]] && cat "$dir/$name.out"
  [[ -f "$dir/$name.err" ]] && cat "$dir/$name.err" >&2
  return "$(cat "$dir/$name.rc" 2>/dev/null || echo 0)"
}
wavemill_run_tool() { _harness_tool "$@"; }
wavemill_run_tsx_tool() { _harness_tool "$@"; }

# Wait (max ~30 s) for a background async job to exit.
harness_wait_job() {
  local job_id="$1" i
  for (( i = 0; i < 300; i++ )); do
    monitor_async_job_running "$job_id" || return 0
    sleep 0.1
  done
  echo "harness: job $job_id still running after 30s" >&2
  return 1
}

# A git worktree with two commits; prints nothing, sets WT, OLD_HEAD, HEAD_SHA.
harness_new_worktree() {
  WT="$HARNESS_DIR/wt-$RANDOM$RANDOM"
  mkdir -p "$WT"
  git -C "$WT" init -q
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
  OLD_HEAD="$(git -C "$WT" rev-parse HEAD)"
  git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m two
  HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
}

harness_commit() {
  git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "${2:-next}"
  git -C "$1" rev-parse HEAD
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else fail "$label (expected '$expected', got '$actual')"; fi
}
harness_finish() {
  echo
  echo "Results: $PASS passed, $FAIL failed"
  (( FAIL == 0 ))
}
