#!/usr/bin/env bash
# HOK-3086: lifecycle fixture — a deferred implementation-stage challenger forks
# from the primary's single shared plan at the plan→coding handoff.
#
# Standalone (like deferred_challenger_materialises_after_coding.sh) and runs the
# REAL fork-point recorder, fork trigger, materialiser, fork-identity producer,
# and fork-descriptor stamp against a scratch git repo. Only the phase launcher
# and task-state writer are stubbed.
#
# What this fixture asserts:
#   1. Before the handoff there is no fork point, and the trigger leaves the arm
#      in awaiting_fork (nothing to fork from yet).
#   2. The handoff records the plan-time commit and snapshots the plan.
#   3. RACE: the primary's coder then commits and rewrites plan.md before the
#      trigger runs. The challenger still branches at the pre-coding commit and
#      inherits the snapshotted plan byte-for-byte, not the rewritten one.
#   4. The challenger inherits only planning (.planning-result.json is
#      source=inherited; no coding artifacts), its phase config names its own
#      coder, and it launches CODING with its own coder model.
#   5. Both arms' intents carry forkIdentity(stage=implementation) with a
#      commit, tree, and all four input hashes, and inherited stages ["plan"].
#   6. An implementation arm with no fork point once the primary's coding has
#      started is terminalised (exhausted/missing_fork_point), never forked
#      from the moved HEAD.
set -euo pipefail

# Guard against being sourced.
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"

TMP_DIR="$(mktemp -d "/tmp/wavemill-impl-fork.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
check_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else echo "    expected: $2"; echo "    actual:   $3"; fail "$1"; fi
}

STATE_FILE="$TMP_DIR/workflow-state.json"
export STATE_FILE
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}

# shellcheck source=../../../shared/lib/challenge-arms.sh
source "$REPO_ROOT/shared/lib/challenge-arms.sh"
# shellcheck source=../../../shared/lib/bounded-retry.sh
source "$REPO_ROOT/shared/lib/bounded-retry.sh"

extract_function() {
  awk -v name="$1" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MONITOR_SCRIPT_FILE"
}
for fn in \
  challenge_record_implementation_fork_point \
  challenge_maybe_materialize_deferred_arms \
  challenge_materialize_implementation_arm \
  challenge_compute_fork_identity \
  challenge_intent_stamp_fork_descriptor \
  challenge_intent_files_valid \
  challenge_intent_file_json; do
  eval "$(extract_function "$fn")"
done

LOG_FILE="$TMP_DIR/log.txt"
log() { echo "log: $*" >> "$LOG_FILE"; }
log_warn() { echo "warn: $*" >> "$LOG_FILE"; }
log_error() { echo "error: $*" >> "$LOG_FILE"; }
log_route_lifecycle() { echo "lifecycle: $*" >> "$LOG_FILE"; }
get_task_meta() { echo "primary"; }
get_linear_issue_id() { echo "$1"; }
read_state_value() { echo "${1:-}"; }
persist_challenge_execution_intent() { :; }
read_stage_status() {
  jq -r '.status // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
save_task_state() {
  state_mutate "$STATE_FILE" \
    '.tasks[$k] = {slug: $slug, branch: $branch, worktree: $wt, challengeRole: $role,
       challengeModel: $cm, plannerModel: $planner, coderModel: $coder, reviewerModel: $reviewer,
       reviewMode: $mode, challengeStage: $stage, phase: $phase}' \
    --arg k "$1" --arg slug "$2" --arg branch "$3" --arg wt "$4" --arg role "${11}" \
    --arg cm "${12}" --arg planner "${13}" --arg coder "${14}" --arg reviewer "${15}" \
    --arg mode "${18}" --arg stage "${19}" --arg phase "${20}"
}
set_task_phase() { echo "$1=$2" >> "$TMP_DIR/phases.txt"; }
write_stage_result_with_history() { :; }
_run_phase_launch() { printf '%s\n' "$*" >> "$TMP_DIR/launches.txt"; }
declare -A BRANCH_BY_ISSUE=() SLUG_BY_ISSUE=()

TOOLS_DIR="$REPO_ROOT/tools"
REPO_DIR="$TMP_DIR/repo"
WORKTREE_ROOT="$TMP_DIR/worktrees"
BASE_BRANCH=main
mkdir -p "$REPO_DIR" "$WORKTREE_ROOT"

# ── Scratch repo: primary worktree after planning, before coding ─────────────
git -C "$REPO_DIR" init -q -b main
git -C "$REPO_DIR" config user.email test@example.com
git -C "$REPO_DIR" config user.name test
echo initial > "$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" commit -q -m initial
PRIMARY_WT="$WORKTREE_ROOT/impl"
git -C "$REPO_DIR" worktree add -q -b task/impl "$PRIMARY_WT" main
PLAN_COMMIT="$(git -C "$PRIMARY_WT" rev-parse HEAD)"

PRIMARY_FEATURE="$PRIMARY_WT/features/impl"
mkdir -p "$PRIMARY_FEATURE"
printf 'Shared plan: do the thing\n' > "$PRIMARY_FEATURE/plan.md"
printf 'Task packet\n' > "$PRIMARY_FEATURE/task-packet.md"
printf '{"issue":"HOK-9001"}\n' > "$PRIMARY_FEATURE/selected-task.json"
touch "$PRIMARY_FEATURE/.plan-approved"
printf '{"planning":{"model":"claude-sonnet-5"},"coding":{"model":"claude-opus-4-7","agent":"claude","depth":"medium"},"review":{"model":"claude-sonnet-5","mode":"static+llm"}}\n' \
  > "$PRIMARY_FEATURE/.phase-config.json"
printf '{"stage":"planning","status":"completed","model":"claude-sonnet-5","agent":"claude"}\n' \
  > "$PRIMARY_FEATURE/.planning-result.json"
CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-9001","issueId":"HOK-9001","selectedStage":"implementation","challengeStage":"implementation","primary":{"pairId":"HOK-9001","side":"primary","challengeStage":"implementation","expectedStageModel":"claude-opus-4-7","expectedRoute":{}},"challenger":{"pairId":"HOK-9001","side":"challenger","challengeStage":"implementation","expectedStageModel":"qwen-3-coder","expectedRoute":{}}}'
printf '%s\n' "$CANONICAL_INTENT" > "$PRIMARY_FEATURE/challenge-intent.json"

printf '%s\n' '{"tasks":{"HOK-9001":{"slug":"impl","challengeRole":"primary","challengePairId":"HOK-9001"}}}' > "$STATE_FILE"
ARM_JSON="$(challenge_arm_json_build \
  "HOK-9001_c" "impl-challenger" "task/impl-challenger" "challenger" "implementation" \
  "qwen-3-coder" "claude-sonnet-5" "claude-haiku-4-5" \
  "native-openrouter" "claude" "claude" \
  "medium" "high" "static" "$CANONICAL_INTENT")"
challenge_arms_record_pending "HOK-9001" "$ARM_JSON"

arm_field() { jq -r --arg f "$1" '.tasks["HOK-9001"].challengeArms[0][$f] // ""' "$STATE_FILE"; }

echo "=== 1. no fork point before the handoff ==="
challenge_maybe_materialize_deferred_arms "HOK-9001" "impl" "$PRIMARY_FEATURE" "$PRIMARY_WT"
check_eq "arm still awaiting_fork before handoff" "awaiting_fork" "$(arm_field challengeArmState)"
check_eq "no challenger launched before handoff" "absent" "$([[ -f "$TMP_DIR/launches.txt" ]] && echo present || echo absent)"

echo "=== 2. handoff records the plan-time fork point ==="
challenge_record_implementation_fork_point "HOK-9001" "$PRIMARY_FEATURE" "$PRIMARY_WT"
check_eq "planForkCommit is the plan-time HEAD" "$PLAN_COMMIT" "$(arm_field planForkCommit)"
SNAPSHOT="$(arm_field planForkSnapshot)"
check_eq "plan snapshotted" "Shared plan: do the thing" "$(cat "$SNAPSHOT/plan.md")"
challenge_record_implementation_fork_point "HOK-9001" "$PRIMARY_FEATURE" "$PRIMARY_WT"
check_eq "recording is idempotent (fork point kept)" "$PLAN_COMMIT" "$(arm_field planForkCommit)"

echo "=== 3. race: primary codes and rewrites the plan before the fork runs ==="
echo "primary code" >> "$PRIMARY_WT/README.md"
git -C "$PRIMARY_WT" commit -q -am "primary coding work"
printf 'Rewritten after handoff\n' > "$PRIMARY_FEATURE/plan.md"
printf '{"stage":"coding","status":"running"}\n' > "$PRIMARY_FEATURE/.coding-result.json"

# First attempt: the challenger's coding launch fails after its stage result
# was written as running. The arm must return to awaiting_fork and retry.
_run_phase_launch() { printf '{"status":"running"}\n' > "$CH_FEATURE/.coding-result.json"; return 1; }
CH_WT="$WORKTREE_ROOT/impl-challenger"
CH_FEATURE="$CH_WT/features/impl-challenger"
challenge_maybe_materialize_deferred_arms "HOK-9001" "impl" "$PRIMARY_FEATURE" "$PRIMARY_WT"
check_eq "failed launch leaves the arm retryable" "awaiting_fork" "$(arm_field challengeArmState)"
_run_phase_launch() { printf '%s\n' "$*" >> "$TMP_DIR/launches.txt"; }
# Clear the bounded-retry backoff so the retry is due now.
rm -f "$PRIMARY_FEATURE"/.retry-challenger-materialize-*-last-at 2>/dev/null || true
challenge_maybe_materialize_deferred_arms "HOK-9001" "impl" "$PRIMARY_FEATURE" "$PRIMARY_WT"
CH_FEATURE="$CH_WT/features/impl-challenger"
check_eq "arm materialized" "materialized" "$(arm_field challengeArmState)"
check_eq "arm forkCommit is the plan-time commit" "$PLAN_COMMIT" "$(arm_field forkCommit)"
check_eq "challenger HEAD is the pre-coding commit" "$PLAN_COMMIT" "$(git -C "$CH_WT" rev-parse HEAD 2>/dev/null || echo missing)"
check_eq "challenger inherits the snapshotted plan, not the rewrite" "Shared plan: do the thing" "$(cat "$CH_FEATURE/plan.md" 2>/dev/null || echo missing)"

echo "=== 4. challenger inherits planning only and codes with its own coder ==="
check_eq "planning result stamped inherited" "inherited" "$(jq -r '.source' "$CH_FEATURE/.planning-result.json")"
check_eq "fork snapshot carries no coding result" "absent" "$([[ -f "$SNAPSHOT/.coding-result.json" ]] && echo present || echo absent)"
check_eq "challenger coding result is never inherited" "not-inherited" \
  "$([[ "$(jq -r '.source // ""' "$CH_FEATURE/.coding-result.json" 2>/dev/null)" == "inherited" ]] && echo inherited || echo not-inherited)"
check_eq "challenger phase config names its own coder" "qwen-3-coder" "$(jq -r '.coding.model' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger phase config names its own coding agent" "native-openrouter" "$(jq -r '.coding.agent' "$CH_FEATURE/.phase-config.json")"
LAUNCH="$(cat "$TMP_DIR/launches.txt" 2>/dev/null || true)"
check_eq "challenger launched coding (not planning/review)" "coding launch_coding_phase HOK-9001_c" "$(awk '{print $1, $2, $3}' <<<"$LAUNCH")"
check_eq "challenger codes with its own coder model" "qwen-3-coder" "$(awk '{print $(NF-2)}' <<<"$LAUNCH")"
check_eq "challenger task state at phase=coding" "coding" "$(jq -r '.tasks["HOK-9001_c"].phase' "$STATE_FILE")"
check_eq "challenger task state challengeStage=implementation" "implementation" "$(jq -r '.tasks["HOK-9001_c"].challengeStage' "$STATE_FILE")"
check_eq "shared reviewer comes from the plan-time route, not the stale arm record" "claude-sonnet-5" \
  "$(jq -r '.tasks["HOK-9001_c"].reviewerModel' "$STATE_FILE")"
check_eq "shared review mode comes from the plan-time route" "static+llm" \
  "$(jq -r '.tasks["HOK-9001_c"].reviewMode' "$STATE_FILE")"
check_eq "challenger coding provider reset for its own coder" "absent" \
  "$(jq -r '.coding.provider // "absent"' "$CH_FEATURE/.phase-config.json")"
check_eq "primary marked challengerLaunched" "true" "$(jq -r '.tasks["HOK-9001"].challengerLaunched' "$STATE_FILE")"

echo "=== 5. fork identity proves matched pre-stage inputs ==="
for dir in "$PRIMARY_FEATURE" "$CH_FEATURE"; do
  side="$(basename "$dir")"
  check_eq "$side intent forkStage" "implementation" "$(jq -r '.forkStage' "$dir/challenge-intent.json")"
  check_eq "$side intent forkCommit" "$PLAN_COMMIT" "$(jq -r '.forkCommit' "$dir/challenge-intent.json")"
  check_eq "$side challenger inheritedStages" '["plan"]' "$(jq -c '.challenger.inheritedStages' "$dir/challenge-intent.json")"
  check_eq "$side forkIdentity stage" "implementation" "$(jq -r '.forkIdentity.stage' "$dir/challenge-intent.json")"
  check_eq "$side forkIdentity tree" "$(git -C "$REPO_DIR" rev-parse "$PLAN_COMMIT^{tree}")" "$(jq -r '.forkIdentity.tree' "$dir/challenge-intent.json")"
  check_eq "$side forkIdentity has all four hashes" "4" \
    "$(jq '[.forkIdentity | .taskPacketHash, .planHash, .promptHash, .toolConfigHash | select(type == "string" and test("^[0-9a-f]{64}$"))] | length' "$dir/challenge-intent.json")"
done
check_eq "fork identity mirrored into primary state intent" "implementation" \
  "$(jq -r '.tasks["HOK-9001"].challengeExecutionIntent.forkIdentity.stage' "$STATE_FILE")"

echo "=== 6. no fork point after coding started → terminal, never forks a moved HEAD ==="
ARM2_JSON="$(challenge_arm_json_build \
  "HOK-9002_c" "late-challenger" "task/late-challenger" "challenger" "implementation" \
  "qwen-3-coder" "claude-sonnet-5" "claude-sonnet-5" "native-openrouter" "claude" "claude" \
  "medium" "high" "static" "$CANONICAL_INTENT")"
state_mutate "$STATE_FILE" '.tasks["HOK-9002"] = {slug: "late"}'
challenge_arms_record_pending "HOK-9002" "$ARM2_JSON"
challenge_maybe_materialize_deferred_arms "HOK-9002" "impl" "$PRIMARY_FEATURE" "$PRIMARY_WT"
check_eq "late arm exhausted" "exhausted" "$(jq -r '.tasks["HOK-9002"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "late arm reason missing_fork_point" "missing_fork_point" "$(jq -r '.tasks["HOK-9002"].challengeArms[0].exhaustReason' "$STATE_FILE")"
check_eq "late arm never branched" "absent" "$(git -C "$REPO_DIR" show-ref --verify --quiet refs/heads/task/late-challenger && echo present || echo absent)"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  echo "--- log ---"; cat "$LOG_FILE" 2>/dev/null || true
  exit 1
fi
echo "deferred_implementation_challenger_forks_at_plan_handoff OK"
