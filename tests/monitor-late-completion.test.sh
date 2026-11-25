#!/usr/bin/env bash
# Regression coverage for HOK-3137: the monitor declared a Claude coding
# agent dead while it was waiting on its own background task (a
# `run_in_background` test suite, `sleep 30 &`, ...), then ignored the valid
# `.coding-complete` the agent wrote minutes later once that task finished.
#
# HOK-3461: the private owner-loss predicate (`coding_stage_owner_lost`, with
# its pane command-name probe `mill_pane_has_live_blocking_process`) is gone.
# Whether an idle coding agent is still working is now the one stage-agent
# disposition (`decideStageAgentDisposition` / `stage_agent_disposition`),
# which holds a stage in flight on the task-progress primitive's ownership-
# only `agentBackgroundLive` fact. A settled stage is stamped interrupted by
# `_stage_stamp_settled_without_result`. This file covers what survives:
#   B1/B2  owned background work (real process chain → real task-progress
#          probe → real disposition) holds the coding stage in flight;
#   B3-B5  `coding_interrupted_late_completion_reconcile` accepts a valid,
#          newer `.coding-complete` on a clean tree after an interrupted
#          stamp, and every edge stays interrupted;
#   B6     the disposition's settled stamp carries factual exitEvidence and
#          the late reconcile recovers from that real stamp.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Brace-depth-aware extraction so functions with nested braces survive intact
# (same approach as tests/coding-dirty-handoff.test.sh).
extract_function() {
  local function_name="$1"
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
  ' "$MONITOR_SCRIPT_FILE"
}

# Real shared helpers: wavemill_collect_descendant_pids, wavemill_iso8601_to_epoch,
# portable_file_mtime_epoch.
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"
# Real HOK-3101 primitive: wavemill_hook_read, task_progress_json (the real
# CLI spawn path is exercised directly by REQ-F1's integration case).
# shellcheck source=../shared/lib/task-progress.sh
source "$REPO_DIR/shared/lib/task-progress.sh"

for fn in \
  _stage_stamp_settled_without_result \
  coding_interrupted_late_completion_reconcile \
  recover_misplaced_coding_complete_marker \
  coding_output_dirty_paths \
  wavemill_owned_feature_artifact_path \
  wavemill_owned_dirty_path \
  blocked_completion_auto_allowed_dirty_path \
  blocked_completion_commit_matches_head \
  seam_artifact_cli_path \
  wavemill_run_tsx_tool \
; do
  extracted="$(extract_function "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "Could not extract $fn() from $MONITOR_SCRIPT_FILE" >&2
    exit 1
  fi
  eval "$extracted"
done

# seam_validate_artifact is wrapped (not extracted verbatim) so tests can
# assert exactly how many times the real validator actually runs (B4's
# cache-prevents-a-second-spawn case) while every other test still exercises
# genuine seam validation end to end.
extracted_seam="$(extract_function seam_validate_artifact)"
[[ -n "$extracted_seam" ]] || { echo "Could not extract seam_validate_artifact()" >&2; exit 1; }
eval "${extracted_seam/seam_validate_artifact()/_real_seam_validate_artifact()}"
SEAM_CALLS=0
seam_validate_artifact() {
  SEAM_CALLS=$((SEAM_CALLS + 1))
  _real_seam_validate_artifact "$@"
}

TMP_ROOT="$(mktemp -d)"
WORKTREE_ROOT="$TMP_ROOT/worktrees"
mkdir -p "$WORKTREE_ROOT"
SESSION="latecompletion"
STATUS_LOG="$TMP_ROOT/status.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
HOOK_CALLS_FILE="$TMP_ROOT/hook-calls.txt"
BG_CHAIN_PIDS=()

cleanup() {
  for pid in "${BG_CHAIN_PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    for d in $(wavemill_collect_descendant_pids "$pid" 2>/dev/null || true); do
      kill -9 "$d" 2>/dev/null || true
    done
    kill -9 "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$TMP_ROOT"
  rm -f /tmp/wavemill-"${SESSION}"-*.hook /tmp/wavemill-"${SESSION}"-*.progress.json 2>/dev/null || true
}
trap cleanup EXIT

: > "$STATUS_LOG"; : > "$WARN_FILE"; : > "$ATTENTION_FILE"; : > "$HOOK_CALLS_FILE"

log() { shift; printf '%s\n' "$*" >> "$STATUS_LOG"; }
log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
log_error() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
wavemill_hook_write() { printf '%s\n' "$*" >> "$HOOK_CALLS_FILE"; }
stage_result_field() { jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true; }
resolve_stage_result_model() { stage_result_field "$1" "$2" model; }

# Minimal write_stage_result stand-in (same shape as the production writer's
# observable contract): a fresh write replaces the whole result except
# startedAt (preserved), and artifacts are present only when supplied —
# mirroring tools/stage-result-cli.ts's "artifacts !== undefined" behavior so
# a reconciled "running" write naturally drops the old interrupted artifacts.
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  local result_file="$feature_dir/.${stage}-result.json" started_at="2026-01-01T00:00:00Z" finished_at="null"
  mkdir -p "$feature_dir"
  [[ -f "$result_file" ]] && started_at="$(jq -r '.startedAt // "2026-01-01T00:00:00Z"' "$result_file" 2>/dev/null)"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\""
  fi
  if [[ -n "$artifacts" ]]; then
    jq -n --arg stage "$stage" --arg status "$status" --arg startedAt "$started_at" --argjson finishedAt "$finished_at" \
      --arg agent "$agent" --arg model "$model" --arg notes "$notes" --argjson artifacts "$artifacts" \
      '{stage:$stage,status:$status,startedAt:$startedAt,finishedAt:$finishedAt,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
      > "$result_file"
  else
    jq -n --arg stage "$stage" --arg status "$status" --arg startedAt "$started_at" --argjson finishedAt "$finished_at" \
      --arg agent "$agent" --arg model "$model" --arg notes "$notes" \
      '{stage:$stage,status:$status,startedAt:$startedAt,finishedAt:$finishedAt,agent:$agent,model:$model,notes:$notes}' \
      > "$result_file"
  fi
}

# Portable epoch -> ISO and mtime-setting helpers (macOS BSD date/touch vs GNU).
iso_from_epoch() {
  date -u -r "$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$1" +"%Y-%m-%dT%H:%M:%SZ"
}
set_mtime_epoch() {
  local path="$1" epoch="$2"
  if touch -d "@$epoch" "$path" 2>/dev/null; then return 0; fi
  local ts
  ts="$(date -r "$epoch" +"%Y%m%d%H%M.%S")"
  touch -t "$ts" "$path"
}

seed_worktree() {
  local slug="$1" wt="$WORKTREE_ROOT/$1" fd
  rm -rf "$wt"
  mkdir -p "$wt"
  git -C "$wt" init -q
  git -C "$wt" config user.email tests@example.com
  git -C "$wt" config user.name "Wavemill Tests"
  git -C "$wt" checkout -q -b main
  printf 'initial\n' > "$wt/README.md"
  git -C "$wt" add README.md
  git -C "$wt" commit -q -m "Initial commit"
  git -C "$wt" checkout -q -b "task/$slug"
  printf 'change\n' >> "$wt/README.md"
  git -C "$wt" commit -qam "Task commit"
  fd="$wt/features/$slug"
  mkdir -p "$fd"
  : > "$STATUS_LOG"; : > "$WARN_FILE"; : > "$ATTENTION_FILE"; : > "$HOOK_CALLS_FILE"
  # NOTE: seed_worktree runs in a command-substitution subshell (`fd="$(seed_worktree ...)"`),
  # so a `SEAM_CALLS=0` reset here would never reach the parent shell's
  # variable. Callers that assert on SEAM_CALLS reset it themselves after
  # calling this function.
  printf '%s\n' "$fd"
}

write_interrupted_result() {
  local feature_dir="$1" finished_at="$2" agent="${3:-claude}" model="${4:-claude-opus-4-7}"
  jq -n --arg agent "$agent" --arg model "$model" --arg finishedAt "$finished_at" \
    '{stage:"coding", status:"failed", startedAt:"2026-01-01T00:00:00Z", finishedAt:$finishedAt, agent:$agent, model:$model,
      notes:"Interrupted: coding agent exited without recording a result - durable commits preserved",
      artifacts:{type:"coding", terminationClass:"interrupted", exitEvidence:"stub", lastDurableCommit:null,
                 validationState:"unknown", recoveryAction:"Relaunch the coding phase to resume from the last durable commit, or push the branch and open a PR manually if the work is already complete."}}' \
    > "$feature_dir/.coding-result.json"
}

write_marker() {
  local feature_dir="$1" commit="${2:-}"
  if [[ -n "$commit" ]]; then
    jq -n --arg commit "$commit" '{stage:"coding", confidence:"high", commit:$commit}' > "$feature_dir/.coding-complete"
  else
    printf '{"stage":"coding","confidence":"high"}\n' > "$feature_dir/.coding-complete"
  fi
}

echo "=== Monitor late .coding-complete reconciliation + owned background work holds the coding disposition (HOK-3137, HOK-3461) ==="

# ─────────────────────────────────────────────────────────────────────────
# B1 — owned background work holds the stage: the canonical disposition
# decides the HOK-3137 shape (agent idle and stalled after launch) from the
# task-progress primitive's agentBackgroundLive fact alone.
# ─────────────────────────────────────────────────────────────────────────

# decide_coding_disposition <agentBackgroundLive json> [agentExited json]
# Runs the real decideStageAgentDisposition for a running coding stage
# launched an hour ago whose agent recorded an idle stop a minute ago and is
# stalled. Prints "<kind> <reason>".
decide_coding_disposition() {
  local background="$1" exited="${2:-null}"
  node --input-type=module -e '
    const [modulePath, background, exited] = process.argv.slice(1);
    const { decideStageAgentDisposition } = await import(modulePath);
    const now = Date.now();
    const d = decideStageAgentDisposition({
      stage: "coding", stageStatus: "running",
      hasCompletionArtifact: false, hasResultVerdict: false,
      launch: { sessionRef: "sess-1", harness: "claude-code", launchedAt: new Date(now - 3600e3).toISOString(),
                attemptId: "coding#1", kind: "coding", stage: "coding" },
      currentHead: null, launchHead: null,
      progress: {
        agentRecord: { state: "idle", event: "Stop", agent: "claude", timestamp: Math.floor(now / 1000) - 60 },
        agentState: "idle", agentIdle: true, agentExited: JSON.parse(exited),
        agentBackgroundLive: JSON.parse(background), blockingPrompt: null,
        stalled: true, ownedSessionIdleAt: null,
      },
    });
    console.log(`${d.kind} ${d.reason}`);
  ' "$REPO_DIR/shared/lib/stage-agent-disposition.ts" "$background" "$exited"
}

out="$(decide_coding_disposition true)"
if [[ "$out" == "in-flight background-work" ]]; then
  pass "idle+stalled+owned background work holds the coding stage in flight"
else
  fail "idle+stalled+owned background work did not hold the stage (got '$out')"
fi

out="$(decide_coding_disposition true '{"at":"2099-01-01T00:00:00Z","source":"launcher"}')"
if [[ "$out" == "in-flight background-work" ]]; then
  pass "owned background work still holds the stage when an exit fact is also recorded"
else
  fail "owned background work lost to an exit fact (got '$out')"
fi

out="$(decide_coding_disposition false)"
if [[ "$out" == settled\ * ]]; then
  pass "idle+stalled with no background work settles (got '$out')"
else
  fail "idle+stalled with no background work did not settle (got '$out')"
fi

out="$(decide_coding_disposition null)"
if [[ "$out" == settled\ * ]]; then
  pass "an unknown background-work probe does not by itself hold an idle agent (got '$out')"
else
  fail "unknown background-work probe wrongly held an idle agent (got '$out')"
fi

# ─────────────────────────────────────────────────────────────────────────
# B2 — REQ-F1 (integration, real primitive): a real process chain
# (bash pane root -> node agent stand-in -> sleep background child), probed
# through the real tools/task-progress.ts CLI.
# ─────────────────────────────────────────────────────────────────────────

spawn_bg_chain() {
  # stdout/stderr MUST be redirected away from the inherited command-
  # substitution pipe: a detached node process that never exits otherwise
  # keeps that pipe's write end open forever, and `$(spawn_bg_chain)` would
  # hang waiting for EOF even though `echo $!` already produced its line.
  bash -c 'node -e "
    const { spawn } = require(\"child_process\");
    spawn(\"sleep\", [\"30\"], { stdio: \"ignore\" });
    setInterval(() => {}, 1e6);
  "' >/dev/null 2>&1 &
  echo $!
}

pane_pid="$(spawn_bg_chain)"
BG_CHAIN_PIDS+=("$pane_pid")
# Give node a moment to actually spawn its child before probing.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -n "$(wavemill_collect_descendant_pids "$pane_pid" 2>/dev/null || true)" ]] && break
  sleep 0.3
done

progress_json="$(WAVEMILL_BG_CHILD_LAG_SECONDS=0 node "$TOOLS_DIR/task-progress.ts" --issue UNIT-BG --pane-pid "$pane_pid" --stall-minutes 60 2>/dev/null || true)"
bg_live="$(jq -r 'if .agentBackgroundLive == null then "null" else (.agentBackgroundLive | tostring) end' <<<"$progress_json" 2>/dev/null || echo "null")"
if [[ "$bg_live" == "true" ]]; then
  pass "real process chain: live background task detected (agentBackgroundLive=true)"
else
  fail "real process chain: background work not detected ($progress_json)"
fi
out="$(decide_coding_disposition "$bg_live")"
if [[ "$out" == "in-flight background-work" ]]; then
  pass "real process chain: the probed background task holds the coding stage in flight"
else
  fail "real process chain: probed background task did not hold the stage (got '$out')"
fi

# Kill the chain; a fresh probe must no longer see a live descendant.
for d in $(wavemill_collect_descendant_pids "$pane_pid" 2>/dev/null || true); do kill -9 "$d" 2>/dev/null || true; done
kill -9 "$pane_pid" 2>/dev/null || true
wait "$pane_pid" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -z "$(wavemill_collect_descendant_pids "$pane_pid" 2>/dev/null || true)" ]] && break
  sleep 0.2
done
progress_json2="$(WAVEMILL_BG_CHILD_LAG_SECONDS=0 node "$TOOLS_DIR/task-progress.ts" --issue UNIT-BG --pane-pid "$pane_pid" --stall-minutes 60 2>/dev/null || true)"
bg_live2="$(jq -r 'if .agentBackgroundLive == null then "null" else (.agentBackgroundLive | tostring) end' <<<"$progress_json2" 2>/dev/null || echo "null")"
if [[ "$bg_live2" == "false" ]]; then
  pass "real process chain: killing the background task clears agentBackgroundLive"
else
  fail "real process chain: agentBackgroundLive did not clear after kill ($progress_json2)"
fi
out="$(decide_coding_disposition "$bg_live2")"
if [[ "$out" == settled\ * ]]; then
  pass "real process chain: once the background task is gone the idle stage settles"
else
  fail "real process chain: stage did not settle after the background task ended (got '$out')"
fi

# Edge: a 1s child that has already exited by probe time is simply absent —
# not live.
short_chain_pid="$(bash -c 'sleep 1' >/dev/null 2>&1 & echo $!)"
BG_CHAIN_PIDS+=("$short_chain_pid")
wait "$short_chain_pid" 2>/dev/null || true
progress_json3="$(WAVEMILL_BG_CHILD_LAG_SECONDS=0 node "$TOOLS_DIR/task-progress.ts" --issue UNIT-BG --pane-pid "$short_chain_pid" --stall-minutes 60 2>/dev/null || true)"
bg_live3="$(jq -r 'if .agentBackgroundLive == null then "null" else (.agentBackgroundLive | tostring) end' <<<"$progress_json3" 2>/dev/null || echo "null")"
if [[ "$bg_live3" == "false" ]]; then
  pass "a short-lived (already-exited) child is not live by probe time"
else
  fail "exited short-lived child wrongly reported live ($progress_json3)"
fi

# ─────────────────────────────────────────────────────────────────────────
# B3/B4 — REQ-F2: interrupted stage recovers with a valid, newer
# .coding-complete on a clean tree; edges stay interrupted.
# ─────────────────────────────────────────────────────────────────────────

now_epoch="$(date +%s)"
finished_epoch=$((now_epoch - 120))
finished_iso="$(iso_from_epoch "$finished_epoch")"

fd="$(seed_worktree "reconcile-success")"
wt="$WORKTREE_ROOT/reconcile-success"
head="$(git -C "$wt" rev-parse HEAD)"
write_interrupted_result "$fd" "$finished_iso"
write_marker "$fd"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-success" || rc=$?
if [[ "$rc" == "0" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "running" ]] \
  && grep -q "late_completion_reconciled" "$STATUS_LOG" \
  && [[ "$(stage_result_field "$fd" coding notes)" == "Reconciled: late .coding-complete accepted after interrupted stamp" ]] \
  && [[ "$(stage_result_field "$fd" coding agent)" == "claude" ]] \
  && [[ "$(jq 'has("artifacts")' "$fd/.coding-result.json")" == "false" ]] \
  && grep -q "HOK-1-reconcile-success=clear" "$ATTENTION_FILE"; then
  pass "a valid newer .coding-complete on a clean tree reconciles to running"
else
  fail "reconcile success path wrong (rc=$rc status=$(stage_result_field "$fd" coding status) log=$(cat "$STATUS_LOG"))"
fi

fd="$(seed_worktree "reconcile-commit-match")"
wt="$WORKTREE_ROOT/reconcile-commit-match"
head="$(git -C "$wt" rev-parse HEAD)"
write_interrupted_result "$fd" "$finished_iso"
write_marker "$fd" "${head:0:9}"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-commit-match" || rc=$?
if [[ "$rc" == "0" ]] && [[ "$(stage_result_field "$fd" coding status)" == "running" ]]; then
  pass "a marker commit prefix matching HEAD reconciles"
else
  fail "commit-match reconcile wrong (rc=$rc)"
fi

fd="$(seed_worktree "reconcile-commit-mismatch")"
wt="$WORKTREE_ROOT/reconcile-commit-mismatch"
write_interrupted_result "$fd" "$finished_iso"
write_marker "$fd" "0000000000000000000000000000000000000000"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-commit-mismatch" || rc=$?
if [[ "$rc" == "1" ]] && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]]; then
  pass "a marker commit that does not match HEAD stays interrupted"
else
  fail "commit-mismatch edge wrong (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

fd="$(seed_worktree "reconcile-old-marker")"
wt="$WORKTREE_ROOT/reconcile-old-marker"
write_interrupted_result "$fd" "$finished_iso"
write_marker "$fd"
set_mtime_epoch "$fd/.coding-complete" $((finished_epoch - 60))
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-old-marker" || rc=$?
if [[ "$rc" == "1" ]] && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]]; then
  pass "a marker older than finishedAt stays interrupted"
else
  fail "old-marker edge wrong (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

fd="$(seed_worktree "reconcile-dirty-tree")"
wt="$WORKTREE_ROOT/reconcile-dirty-tree"
write_interrupted_result "$fd" "$finished_iso"
write_marker "$fd"
printf 'wip\n' >> "$wt/README.md"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-dirty-tree" || rc=$?
if [[ "$rc" == "1" ]] && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]]; then
  pass "a dirty worktree stays interrupted (HOK-3128 dirty-handoff machinery applies to live arms, not reconciled ones)"
else
  fail "dirty-tree edge wrong (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

# B4: a seam-invalid marker stays interrupted, and the cached verdict
# prevents a second real validator spawn on the next tick.
fd="$(seed_worktree "reconcile-invalid-marker")"
wt="$WORKTREE_ROOT/reconcile-invalid-marker"
write_interrupted_result "$fd" "$finished_iso"
printf '{"stage":"coding","confidence":"not-a-real-confidence-level"}\n' > "$fd/.coding-complete"
SEAM_CALLS=0
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-invalid-marker" || rc=$?
calls_after_first="$SEAM_CALLS"
rc2=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-reconcile-invalid-marker" || rc2=$?
if [[ "$rc" == "1" ]] && [[ "$rc2" == "1" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]] \
  && [[ "$calls_after_first" == "1" ]] \
  && [[ "$SEAM_CALLS" == "1" ]]; then
  pass "a seam-invalid marker stays interrupted; the cached verdict skips a second real validator spawn"
else
  fail "seam-invalid caching wrong (rc=$rc rc2=$rc2 calls=$calls_after_first/$SEAM_CALLS)"
fi

# ─────────────────────────────────────────────────────────────────────────
# B5 — REQ-F3: no .coding-complete at all leaves the task interrupted.
# ─────────────────────────────────────────────────────────────────────────

fd="$(seed_worktree "no-marker")"
wt="$WORKTREE_ROOT/no-marker"
write_interrupted_result "$fd" "$finished_iso"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-no-marker" || rc=$?
if [[ "$rc" == "1" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]] \
  && [[ "$(jq -r '.artifacts.terminationClass' "$fd/.coding-result.json")" == "interrupted" ]] \
  && [[ -z "$(cat "$ATTENTION_FILE")" ]]; then
  pass "no .coding-complete leaves the task interrupted"
else
  fail "no-marker REQ-F3 case wrong (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

# A non-interrupted failure (different terminationClass, or none at all)
# must never be touched by the reconciler.
fd="$(seed_worktree "non-interrupted-failure")"
wt="$WORKTREE_ROOT/non-interrupted-failure"
jq -n '{stage:"coding", status:"failed", startedAt:"2026-01-01T00:00:00Z", finishedAt:"2026-01-01T01:00:00Z", agent:"claude", model:"claude-opus-4-7", notes:"some other failure"}' \
  > "$fd/.coding-result.json"
write_marker "$fd"
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-non-interrupted-failure" || rc=$?
if [[ "$rc" == "1" ]] && [[ "$(stage_result_field "$fd" coding status)" == "failed" ]]; then
  pass "a failure with no interrupted terminationClass is never reconciled"
else
  fail "non-interrupted failure scope leak (rc=$rc)"
fi

# ─────────────────────────────────────────────────────────────────────────
# B6 — the disposition's settled stamp carries factual exitEvidence, and a
# late marker written after that real stamp reconciles.
# ─────────────────────────────────────────────────────────────────────────

fd="$(seed_worktree "settled-stamp")"
wt="$WORKTREE_ROOT/settled-stamp"
head="$(git -C "$wt" rev-parse HEAD)"
cat > "$fd/.coding-result.json" <<'JSON'
{"stage":"coding","status":"running","startedAt":"2020-01-01T00:00:00Z","agent":"claude","model":"claude-opus-4-7"}
JSON
_stage_stamp_settled_without_result "HOK-1" "$fd" coding "agent-exited" "$head"
notes="$(stage_result_field "$fd" coding notes)"
if [[ "$(stage_result_field "$fd" coding status)" == "failed" ]] \
  && [[ "$(stage_result_field "$fd" coding agent)" == "claude" ]] \
  && [[ "$(jq -r '.artifacts.terminationClass' "$fd/.coding-result.json")" == "interrupted" ]] \
  && [[ "$(jq -r '.artifacts.exitEvidence.reason' "$fd/.coding-result.json")" == "agent-exited" ]] \
  && [[ "$(jq -r '.artifacts.exitEvidence.observedHead' "$fd/.coding-result.json")" == "$head" ]] \
  && [[ "$notes" == *"agent settled without a result (agent-exited)"* ]]; then
  pass "a settled stamp records interrupted with the observed reason and head as exitEvidence"
else
  fail "settled stamp evidence wrong ($(cat "$fd/.coding-result.json"))"
fi

# The stamp's finishedAt has one-second resolution; make the marker strictly newer.
stamp_epoch="$(wavemill_iso8601_to_epoch "$(stage_result_field "$fd" coding finishedAt)")"
write_marker "$fd" "$head"
set_mtime_epoch "$fd/.coding-complete" $((stamp_epoch + 5))
rc=0
coding_interrupted_late_completion_reconcile "HOK-1" "$fd" "$wt" "HOK-1-settled-stamp" || rc=$?
if [[ "$rc" == "0" ]] \
  && [[ "$(stage_result_field "$fd" coding status)" == "running" ]] \
  && [[ "$(stage_result_field "$fd" coding agent)" == "claude" ]] \
  && [[ "$(jq 'has("artifacts")' "$fd/.coding-result.json")" == "false" ]]; then
  pass "a valid .coding-complete written after the disposition's settled stamp reconciles to running"
else
  fail "late marker after settled stamp not reconciled (rc=$rc status=$(stage_result_field "$fd" coding status))"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
