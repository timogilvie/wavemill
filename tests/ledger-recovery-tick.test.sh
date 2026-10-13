#!/usr/bin/env bash
# HOK-3185: Ledger F recovery loop — monitor wiring and CLI behaviour.
#
#   * monitor_ledger_recovery_tick: kill switches, DRY_RUN, cadence stamp,
#     throttle, invocation payload, and its place in the main tick (after
#     conditionReconcile, before the post-wake resume)
#   * reconcile_ledger_waiting_on: spawns nothing in shadow mode
#   * tools/ledger-recovery-tick.ts end to end against a temp repo:
#     shadow logs a decision and mutates nothing; live spends the bounded-retry
#     bucket and hands the row back; an exhausted bucket escalates once as a
#     waiting_on operator-event row; an operator event clears it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$ROOT/shared/lib/wavemill-monitor.sh"
RECONCILER_FILE="$ROOT/shared/lib/condition-reconciler.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local function_name="$1" file="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$file"
}

for fn in _monitor_terminal_cleanup_write ledger_recovery_tick_enabled monitor_ledger_recovery_interval monitor_ledger_recovery_tick; do
  extracted="$(extract_function "$fn" "$MONITOR_SCRIPT_FILE")"
  [[ -n "$extracted" ]] || { echo "Could not extract $fn()" >&2; exit 1; }
  eval "$extracted"
done
eval "$(extract_function reconcile_ledger_waiting_on "$RECONCILER_FILE")"

TMP_ROOT="$(mktemp -d /tmp/wavemill-ledger-recovery.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ── Part 1: monitor wiring ──────────────────────────────────────────────────
STATE_DIR="$TMP_ROOT/state"
REPO_DIR="$TMP_ROOT/repo"
STATE_FILE="$TMP_ROOT/workflow-state.json"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
MILL_LOG_FILE="$TMP_ROOT/mill.log"
mkdir -p "$STATE_DIR" "$REPO_DIR"
export REPO_DIR STATE_DIR STATE_FILE WORKTREE_ROOT MILL_LOG_FILE
DRY_RUN=false
STAMP="$STATE_DIR/.ledger-recovery-last-at"

INVOCATION_LOG="$TMP_ROOT/invocations.log"
: > "$INVOCATION_LOG"
wavemill_run_tool() { printf '%s\n' "$*" >> "$INVOCATION_LOG"; }
export -f wavemill_run_tool

wait_for_invocation() {
  local i
  for i in $(seq 1 50); do
    [[ -s "$INVOCATION_LOG" ]] && return 0
    sleep 0.1
  done
  return 1
}

[[ "$(monitor_ledger_recovery_interval)" == "120" ]] && pass "default interval is 120s" || fail "default interval"
LEDGER_RECOVERY_INTERVAL_SECONDS=junk
[[ "$(monitor_ledger_recovery_interval)" == "120" ]] && pass "garbage interval falls back" || fail "garbage interval"
unset LEDGER_RECOVERY_INTERVAL_SECONDS

for switch in WAVEMILL_LEDGER_RECOVERY_DISABLED WAVEMILL_LEDGER_SHADOW_DISABLED; do
  rm -f "$STAMP"; : > "$INVOCATION_LOG"
  export "$switch=1"
  monitor_ledger_recovery_tick
  unset "$switch"
  [[ ! -f "$STAMP" && ! -s "$INVOCATION_LOG" ]] && pass "$switch=1 disables the tick" || fail "$switch=1 should disable the tick"
done

rm -f "$STAMP"
DRY_RUN=true
monitor_ledger_recovery_tick
DRY_RUN=false
[[ ! -f "$STAMP" ]] && pass "DRY_RUN skips the tick" || fail "DRY_RUN should skip the tick"

rm -f "$STAMP"; : > "$INVOCATION_LOG"
monitor_ledger_recovery_tick
[[ -f "$STAMP" ]] && pass "first tick writes the cadence stamp" || fail "missing cadence stamp"
expected="ledger-recovery-tick.ts --repo-dir $REPO_DIR --state-file $STATE_FILE --worktree-root $WORKTREE_ROOT"
if wait_for_invocation && grep -qxF "$expected" "$INVOCATION_LOG"; then
  pass "tick invokes the recovery CLI with repo, state file and worktree root"
else
  fail "tick invocation payload is wrong: $(cat "$INVOCATION_LOG")"
fi

: > "$INVOCATION_LOG"
monitor_ledger_recovery_tick
sleep 0.3
[[ ! -s "$INVOCATION_LOG" ]] && pass "tick inside the interval is throttled" || fail "throttled tick spawned"

: > "$INVOCATION_LOG"
unset WAVEMILL_LEDGER_RECOVERY_LIVE || true
reconcile_ledger_waiting_on
sleep 0.3
[[ ! -s "$INVOCATION_LOG" ]] && pass "ledger waiting_on reconcile spawns nothing in shadow mode" || fail "shadow reconcile spawned"
WAVEMILL_LEDGER_RECOVERY_LIVE=1 reconcile_ledger_waiting_on
if wait_for_invocation && grep -q -- "ledger-recovery-tick.ts --reconcile --repo-dir $REPO_DIR" "$INVOCATION_LOG"; then
  pass "live mode reconciles ledger escalations"
else
  fail "live reconcile invocation wrong: $(cat "$INVOCATION_LOG")"
fi

order="$(grep -nE 'monitor_step_begin (conditionReconcile|ledgerRecovery)|monitor_resume_agents_after_wake "\$monitor_wake_episode"' "$MONITOR_SCRIPT_FILE" | cut -d: -f1 | tr '\n' ' ')"
read -r l_cond l_rec l_wake <<< "$order"
if [[ -n "${l_wake:-}" ]] && (( l_cond < l_rec && l_rec < l_wake )); then
  pass "ledgerRecovery runs after conditionReconcile and before the post-wake resume"
else
  fail "ledgerRecovery tick order wrong: $order"
fi
unset -f wavemill_run_tool

# ── Part 2: CLI end to end ──────────────────────────────────────────────────
cd "$ROOT"
E2E="$TMP_ROOT/e2e"
WT="$E2E/worktrees/demo"
SD="$WT/features/demo"
mkdir -p "$E2E/repo" "$SD"
git -C "$WT" init -q
git -C "$WT" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
jq -n --arg wt "$WT" '{tasks: {"HOK-9001": {slug: "demo", worktree: $wt, phase: "review", status: "active"}}}' > "$E2E/state.json"
printf '%s\n' '{"status":"failed","failureReason":"socket hang up while streaming review"}' > "$SD/.review-result.json"
unset WAVEMILL_LEDGER_RECOVERY_LIVE || true

ledger() { npx tsx tools/ledger.ts "$@" --repo-dir "$E2E/repo" --strict --json; }
tick() { npx tsx tools/ledger-recovery-tick.ts --repo-dir "$E2E/repo" --state-file "$E2E/state.json" --session ledger-recovery-test --strict "$@"; }

STEP_ID="$(ledger step-upsert --issue HOK-9001 --kind review --head "$HEAD_SHA" --deadline 2020-01-01T00:00:00Z | jq -r '.id')"
[[ -n "$STEP_ID" && "$STEP_ID" != null ]] && pass "seeded a review step past its deadline" || fail "step seed failed"

tick >/dev/null
AUDIT="$E2E/repo/.wavemill/ledger-recovery.jsonl"
line="$(tail -n 1 "$AUDIT" 2>/dev/null || true)"
if [[ "$(jq -r '[.mode, .action, .stepId, .failureClass, .retryBucket, .attempt] | join(",")' <<< "$line" 2>/dev/null)" == "shadow,bounded-relaunch,$STEP_ID,retryable,stage-failure-review,1" ]]; then
  pass "shadow tick logs the bounded-relaunch decision"
else
  fail "unexpected shadow audit line: $line"
fi
inspect="$(ledger inspect "$STEP_ID")"
if [[ "$(jq -r '.task.state' <<< "$inspect")" == running && "$(jq '.evidence | length' <<< "$inspect")" == 0 ]] \
  && ! compgen -G "$SD/.retry-stage-failure-review-*" >/dev/null; then
  pass "shadow tick mutates neither the ledger nor the retry bucket"
else
  fail "shadow tick mutated state: $inspect"
fi

tick --live >/dev/null
inspect="$(ledger inspect "$STEP_ID")"
if [[ "$(jq -r '.task.state' <<< "$inspect")" == pending && "$(cat "$SD/.retry-stage-failure-review-count" 2>/dev/null)" == 1 ]] \
  && jq -e '.evidence | any(.event == "recovery-relaunch-requested")' <<< "$inspect" >/dev/null; then
  pass "live tick spends the stage-failure bucket and hands the row back as pending"
else
  fail "live relaunch state wrong: $inspect"
fi

# Second step on a spent budget: escalates once, then an operator event clears it.
ledger step-settle --id "$STEP_ID" --as done >/dev/null
STEP2="$(ledger step-upsert --issue HOK-9001 --kind review --head "$HEAD_SHA" --prompt second --deadline 2020-01-01T00:00:00Z | jq -r '.id')"
printf '3\n' > "$SD/.retry-stage-failure-review-count"
tick --live >/dev/null
tick --live >/dev/null
inspect="$(ledger inspect "$STEP2")"
if [[ "$(jq -r '.task.state' <<< "$inspect")" == waiting ]] \
  && [[ "$(jq '[.waiting_on[] | select(.trigger == "operator-event")] | length' <<< "$inspect")" == 1 ]] \
  && [[ "$(jq '[.evidence[] | select(.event == "recovery-escalated")] | length' <<< "$inspect")" == 1 ]]; then
  pass "exhausted budget escalates exactly once as a waiting_on operator-event row"
else
  fail "escalation state wrong: $inspect"
fi

tick --reconcile >/dev/null
[[ "$(ledger inspect "$STEP2" | jq '.waiting_on | length')" == 1 ]] && pass "escalation holds with no operator event" || fail "escalation cleared without a cause"

printf '%s\n' '{"seq":1,"command":"re-review","issue":"HOK-9001"}' >> "$SD/.operator-events.jsonl"
tick --reconcile >/dev/null
inspect="$(ledger inspect "$STEP2")"
if [[ "$(jq '.waiting_on | length' <<< "$inspect")" == 0 && "$(jq -r '.task.state' <<< "$inspect")" == pending ]]; then
  pass "an operator event clears the escalation and re-opens the step"
else
  fail "operator event did not clear the escalation: $inspect"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
