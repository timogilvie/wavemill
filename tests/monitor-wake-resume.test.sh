#!/usr/bin/env bash
# Regression coverage for HOK-3174: after the host slept, a Claude coding
# agent whose response was cut off ("Your computer went to sleep
# mid-response") sat idle at its prompt for ~18h while the monitor logged
# "coding stalled" and took no action.
#
# The fix: the monitor records wall-clock time at each tick; a gap far larger
# than the tick interval logs `host slept ~Nm` once and re-checks every
# running stage through the HOK-3101 progress primitive. An agent idle (or
# errored) at its prompt with no completion signal gets one resume message,
# bounded through bounded-retry.sh bucket `agent-resume-after-wake` — one
# attempt per wake episode per head.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local source_file="$1" function_name="$2"
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

# Real helpers: wavemill_iso8601_to_epoch and the bounded-retry invariant.
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$REPO_DIR/shared/lib/bounded-retry.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FUNCS_FILE="$TMP_DIR/funcs.sh"
: > "$FUNCS_FILE"
for fn in \
  read_stage_status \
  wake_gap_threshold_seconds \
  monitor_detect_host_wake \
  monitor_record_tick_epoch \
  wake_resume_interrupted_agent \
  monitor_resume_agents_after_wake; do
  body="$(extract_function "$MONITOR_SCRIPT_FILE" "$fn")"
  if [[ -z "$body" ]]; then
    echo "FAIL: could not extract $fn" >&2
    exit 1
  fi
  printf '%s\n\n' "$body" >> "$FUNCS_FILE"
done
extract_function "$REPO_DIR/shared/lib/agent-adapters.sh" agent_is_native_cmd >> "$FUNCS_FILE"
grep -E '^(WAKE_RESUME_MESSAGE|MONITOR_LAST_TICK_EPOCH)=' "$MONITOR_SCRIPT_FILE" >> "$FUNCS_FILE"
# shellcheck disable=SC1090
source "$FUNCS_FILE"

# ── Fixture ───────────────────────────────────────────────────────────────
SESSION="wm-test"
POLL_SECONDS=10
WORKTREE_ROOT="$TMP_DIR/worktrees"
LOG_FILE="$TMP_DIR/monitor.log"
SEND_LOG="$TMP_DIR/send.log"
: > "$LOG_FILE"
: > "$SEND_LOG"

declare -A BRANCH_BY_ISSUE=() SLUG_BY_ISSUE=() CLEANED=() TASK_PHASE=() TASK_PROGRESS=()

log() { printf '%s %s\n' "$1" "${*:2}" >> "$LOG_FILE"; }
read_state_value() { printf '\n'; }
get_task_phase() { printf '%s\n' "${TASK_PHASE[$1]:-coding}"; }
_tmux_task_window_target() { printf "%s:%s\n" "$SESSION" "$3"; }
task_progress_json() { printf '%s\n' "${TASK_PROGRESS[$1]:-{\}}"; }
PANE_CMD="claude"
tmux() {
  case "${1:-}" in
    display-message) printf '%s\n' "$PANE_CMD" ;;
    *) return 0 ;;
  esac
}
wavemill_pane_send_message() {
  printf '%s|%s\n' "$1" "$2" >> "$SEND_LOG"
  WAVEMILL_PANE_MESSAGE_LAST_SIGNAL="hook"
  return 0
}

STARTED_AT="2026-10-07T08:00:00Z"
STARTED_EPOCH="$(wavemill_iso8601_to_epoch "$STARTED_AT")"
AFTER_START=$((STARTED_EPOCH + 600))

make_task() {
  local issue="$1" slug="$2" phase="${3:-coding}" agent="${4:-claude}"
  local wt="$WORKTREE_ROOT/$slug"
  mkdir -p "$wt/features/$slug"
  if [[ ! -d "$wt/.git" ]]; then
    git -C "$wt" init -q
    git -C "$wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  fi
  jq -n --arg a "$agent" --arg s "$STARTED_AT" '{status:"running", agent:$a, startedAt:$s}' \
    > "$wt/features/$slug/.${phase}-result.json"
  BRANCH_BY_ISSUE[$issue]="task/$slug"
  SLUG_BY_ISSUE[$issue]="$slug"
  TASK_PHASE[$issue]="$phase"
}

idle_progress() {
  local state="${1:-idle}" ts="${2:-$AFTER_START}"
  jq -cn --arg st "$state" --argjson ts "$ts" '{
    terminal:false, blockingPrompt:null, agentBackgroundLive:false,
    agentIdle:($st == "idle"),
    agentRecord:{state:$st, event:"Stop", agent:"claude", timestamp:$ts}
  }'
}

sends_for() { grep -c "^$SESSION:$1|" "$SEND_LOG" 2>/dev/null || true; }

# ── Wake detection ────────────────────────────────────────────────────────
MONITOR_LAST_TICK_EPOCH=""
episode="$(monitor_detect_host_wake 1000)"
[[ -z "$episode" ]] && pass "first tick never reports a wake" || fail "first tick reported a wake"

monitor_record_tick_epoch 1000
episode="$(monitor_detect_host_wake 1012)"
[[ -z "$episode" ]] && pass "normal tick gap is not a wake" || fail "normal tick gap reported a wake"

: > "$LOG_FILE"
monitor_record_tick_epoch 1000
episode="$(monitor_detect_host_wake $((1000 + 18 * 3600)))"
if [[ "$episode" == "$((1000 + 18 * 3600))" ]]; then
  pass "large tick gap yields a wake episode"
else
  fail "large tick gap did not yield a wake episode (got '$episode')"
fi
if [[ "$(grep -c 'host slept ~1080m' "$LOG_FILE" || true)" == "1" ]]; then
  pass "wake logs 'host slept ~Nm' once"
else
  fail "expected one 'host slept ~1080m' line: $(cat "$LOG_FILE")"
fi

POLL_SECONDS=60
monitor_record_tick_epoch 1000
episode="$(monitor_detect_host_wake 1400)"
[[ -z "$episode" ]] && pass "threshold scales to ten poll intervals" || fail "400s gap with 60s poll reported a wake"
POLL_SECONDS=10

# ── Resume after wake ─────────────────────────────────────────────────────
make_task HOK-1 idle-agent
TASK_PROGRESS[HOK-1]="$(idle_progress idle)"
make_task HOK-2 errored-agent
TASK_PROGRESS[HOK-2]="$(idle_progress error)"
make_task HOK-3 completed-agent
touch "$WORKTREE_ROOT/completed-agent/features/completed-agent/.coding-complete"
TASK_PROGRESS[HOK-3]="$(idle_progress idle)"
make_task HOK-4 working-agent
TASK_PROGRESS[HOK-4]="$(jq -cn '{terminal:false, blockingPrompt:null, agentIdle:false, agentRecord:{state:"working", timestamp:0}}')"
make_task HOK-5 prompt-agent
TASK_PROGRESS[HOK-5]="$(idle_progress idle | jq -c '.blockingPrompt = {id:"trust-folder"}')"
make_task HOK-6 native-agent coding native-openrouter
TASK_PROGRESS[HOK-6]="$(idle_progress idle)"
make_task HOK-7 stale-record
TASK_PROGRESS[HOK-7]="$(idle_progress idle $((STARTED_EPOCH - 60)))"
make_task HOK-8 cleaned-agent
TASK_PROGRESS[HOK-8]="$(idle_progress idle)"
CLEANED[HOK-8]=1
make_task HOK-9 terminal-agent
TASK_PROGRESS[HOK-9]="$(idle_progress idle | jq -c '.terminal = true')"

monitor_resume_agents_after_wake 50000

[[ "$(sends_for idle-agent)" == "1" ]] && pass "idle agent resumed once" || fail "idle agent sends: $(sends_for idle-agent)"
[[ "$(sends_for errored-agent)" == "1" ]] && pass "agent cut off mid-response (error) resumed once" || fail "errored agent sends: $(sends_for errored-agent)"
if grep -q "|$WAKE_RESUME_MESSAGE\$" "$SEND_LOG" && [[ "$WAKE_RESUME_MESSAGE" == *"interrupted; continue and complete the task"* ]]; then
  pass "resume message is the specified text"
else
  fail "resume message mismatch: $(cat "$SEND_LOG")"
fi
for slug in completed-agent working-agent prompt-agent native-agent stale-record cleaned-agent terminal-agent; do
  [[ "$(sends_for "$slug")" == "0" ]] && pass "no resume for $slug" || fail "unexpected resume for $slug"
done

# Same wake episode on the next tick: bounded, no duplicate.
monitor_resume_agents_after_wake 50000
[[ "$(sends_for idle-agent)" == "1" ]] && pass "same wake episode does not resume twice" || fail "duplicate resume within one wake episode"

state_dir="$WORKTREE_ROOT/idle-agent/features/idle-agent"
head_sha="$(git -C "$WORKTREE_ROOT/idle-agent" rev-parse HEAD)"
if [[ "$(bounded_retry_count "$state_dir" agent-resume-after-wake)" == "1" \
  && "$(bounded_retry_head "$state_dir" agent-resume-after-wake)" == "$head_sha:wake-50000" ]]; then
  pass "attempt recorded in agent-resume-after-wake keyed on head + wake episode"
else
  fail "bounded retry state: count=$(bounded_retry_count "$state_dir" agent-resume-after-wake) head=$(bounded_retry_head "$state_dir" agent-resume-after-wake)"
fi
if ! bounded_retry_is_exhausted "$state_dir" agent-resume-after-wake \
  && ! ls "$state_dir" | grep -q 'exhausted'; then
  pass "no terminal marker written"
else
  fail "a terminal/exhausted marker was written"
fi

# A later, distinct wake episode is eligible again.
monitor_resume_agents_after_wake 90000
[[ "$(sends_for idle-agent)" == "2" ]] && pass "a new wake episode earns one more resume" || fail "new wake episode sends: $(sends_for idle-agent)"

# An exited agent leaves a shell: never type into it.
make_task HOK-10 shell-pane
TASK_PROGRESS[HOK-10]="$(idle_progress idle)"
PANE_CMD="zsh"
monitor_resume_agents_after_wake 95000
[[ "$(sends_for shell-pane)" == "0" ]] && pass "no resume into a bare shell" || fail "resumed into a shell pane"
PANE_CMD="claude"

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
