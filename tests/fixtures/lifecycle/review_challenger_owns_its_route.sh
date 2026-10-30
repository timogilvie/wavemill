#!/usr/bin/env bash
# HOK-3156: lifecycle fixture — a review-stage challenger owns its own route.
#
# Standalone (like deferred_implementation_challenger_forks_at_plan_handoff.sh)
# and runs the REAL fork trigger, review-arm materialiser, route rewrite,
# stage-result model resolution and pre-review preflight against a scratch git
# repo. Only the phase launcher, task-state writer and arm teardown are stubbed.
#
# What this fixture asserts:
#   1. A review fork writes the challenger's OWN .phase-config.json review entry
#      and .routing-complete reviewer from the sealed intent; planning/coding
#      stay inherited; the primary's .review-result.json is never inherited.
#   2. challengeModel = challengeVariedModel = the challenger's reviewer, and
#      coderModel stays the shared coder. The review launch, the running stage
#      result and the completion-time stage-result model all name that reviewer.
#   3. End to end: with both arms' reviews completed, the comparison routing is
#      reviewer-only, provenance validation passes, and route reconciliation for
#      the challenger PR is complete (stampable).
#   4. A primary that drifted after sealing (planner + depths) collapses the pair
#      as route-drift at fork time: no challenger branch, worktree or launch.
#   5. The pre-review preflight collapses a non-deferred pair whose arms differ
#      beyond the varied stage as multiple-varied-roles, and records
#      invalid_challenge:multiple-varied-roles on both arms once a PR exists
#      instead. A review-stage pair differing only in the reviewer passes; one
#      that also differs in plan depth collapses.
set -euo pipefail

# Guard against being sourced.
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-review-own-route.XXXXXX")"
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
# shellcheck source=../../../shared/lib/task-identity.sh
source "$REPO_ROOT/shared/lib/task-identity.sh"

extract_function() {
  awk -v name="$2" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$1"
}
for fn in \
  challenge_maybe_materialize_deferred_arms \
  challenge_materialize_challenger_arm \
  challenge_write_review_arm_route \
  challenge_set_varied_model \
  challenge_assert_arms_diverge \
  challenge_compute_fork_identity \
  challenge_intent_stamp_fork_descriptor \
  challenge_intent_files_valid \
  challenge_intent_file_json \
  challenge_collapse_route_drift \
  challenge_pre_review_route_preflight \
  challenge_varied_stage_model \
  resolve_stage_result_model \
  read_phase_config; do
  eval "$(extract_function "$MONITOR_SCRIPT_FILE" "$fn")"
done
eval "$(extract_function "$COMMON_SCRIPT_FILE" phase_config_provider_for_agent)"
eval "$(extract_function "$COMMON_SCRIPT_FILE" pass_task_field)"
# The monitor spawns check-challenge-route.ts through wavemill_run_tool; run it
# directly so the real one-variable check executes.
wavemill_run_tool() {
  local tool="${1:?wavemill_run_tool requires a tool basename}"
  shift
  node "$TOOLS_DIR/$tool" "$@"
}
# The real helper seeds a default file through a heredoc (not extractable by
# brace matching); the fork always copies a phase config, so seed minimally.
ensure_phase_config_state_file() { [[ -f "$1/.phase-config.json" ]] || printf '{}\n' > "$1/.phase-config.json"; }

LOG_FILE="$TMP_DIR/log.txt"
log() { echo "log: $*" >> "$LOG_FILE"; }
log_warn() { echo "warn: $*" >> "$LOG_FILE"; }
log_error() { echo "error: $*" >> "$LOG_FILE"; }
log_route_lifecycle() { echo "lifecycle: $*" >> "$LOG_FILE"; }
get_task_meta() { jq -r --arg i "$1" --arg f "$2" '.tasks[$i][$f] // empty' "$STATE_FILE" 2>/dev/null || true; }
get_linear_issue_id() { echo "$1"; }
read_state_value() {
  local default="$1"; shift
  local value
  value="$(jq -r "$@" "$STATE_FILE" 2>/dev/null || true)"
  [[ -n "$value" && "$value" != "null" ]] && printf '%s\n' "$value" || printf '%s\n' "$default"
}
persist_challenge_execution_intent() { :; }
read_stage_status() { jq -r '.status // empty' "$1/.${2}-result.json" 2>/dev/null || true; }
save_task_state() {
  state_mutate "$STATE_FILE" \
    '.tasks[$k] = ((.tasks[$k] // {}) + {slug: $slug, branch: $branch, worktree: $wt, challenge: true,
       challengePairId: $pair, challengeRole: $role, challengeModel: $cm, plannerModel: $planner,
       coderModel: $coder, reviewerModel: $reviewer, planDepth: $pd, codeDepth: $cd, reviewMode: $mode,
       challengeStage: $stage, phase: $phase})' \
    --arg k "$1" --arg slug "$2" --arg branch "$3" --arg wt "$4" --arg pair "${10}" --arg role "${11}" \
    --arg cm "${12}" --arg planner "${13}" --arg coder "${14}" --arg reviewer "${15}" \
    --arg pd "${16}" --arg cd "${17}" --arg mode "${18}" --arg stage "${19}" --arg phase "${20}"
}
set_task_phase() { echo "$1=$2" >> "$TMP_DIR/phases.txt"; }
write_stage_result_with_history() {
  jq -n --arg stage "$2" --arg status "$3" --arg agent "${4:-}" --arg model "${5:-}" \
    '{stage: $stage, status: $status, agent: $agent, model: $model, intendedModel: $model}' \
    > "$1/.$2-result.json"
}
_run_phase_launch() { printf '%s\n' "$*" >> "$TMP_DIR/launches.txt"; }
agent_resolve_from_model() {
  case "${1:-}" in
    gpt-*) echo codex ;;
    claude-*) echo claude ;;
    *) echo native-openrouter ;;
  esac
}
# Arm teardown is covered by its own tests; record the collapse request here.
challenge_cancel_challenger_arm() { local IFS='|'; printf '%s\n' "$*" >> "$TMP_DIR/cancelled.txt"; }
declare -A BRANCH_BY_ISSUE=() SLUG_BY_ISSUE=()

TOOLS_DIR="$REPO_ROOT/tools"
REPO_DIR="$TMP_DIR/repo"
WORKTREE_ROOT="$TMP_DIR/worktrees"
BASE_BRANCH=main
mkdir -p "$REPO_DIR" "$WORKTREE_ROOT"

git -C "$REPO_DIR" init -q -b main
git -C "$REPO_DIR" config user.email test@example.com
git -C "$REPO_DIR" config user.name test
echo initial > "$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" commit -q -m initial

# Seed a primary worktree at coding=completed with the sealed review-stage route
# (planner claude-opus-5-5, coder claude-opus-4-7, reviewer gpt-5.6-terra vs
# kimi-k2, depths deep) and the primary's own completed review.
seed_primary() {
  local key="$1" slug="$2" planner="$3" depth="$4"
  local wt="$WORKTREE_ROOT/$slug" feature
  git -C "$REPO_DIR" worktree add -q -b "task/$slug" "$wt" main
  echo "code for $key" >> "$wt/README.md"
  git -C "$wt" commit -q -am "primary coding work"
  feature="$wt/features/$slug"
  mkdir -p "$feature"
  printf 'Shared plan\n' > "$feature/plan.md"
  printf 'Task packet\n' > "$feature/task-packet.md"
  touch "$feature/.plan-approved" "$feature/.coding-complete"
  jq -n --arg p "$planner" --arg d "$depth" '{
    planning: {model: $p, agent: "claude", depth: $d},
    coding: {model: "claude-opus-4-7", agent: "claude", depth: $d},
    review: {model: "gpt-5.6-terra", agent: "codex", mode: "llm"}
  }' > "$feature/.phase-config.json"
  jq -n --arg p "$planner" --arg d "$depth" '{
    planner: $p, coder: "claude-opus-4-7", reviewer: "gpt-5.6-terra",
    planDepth: $d, codeDepth: $d, reviewMode: "llm", reviewRecommended: "llm"
  }' > "$feature/.routing-complete"
  jq -n --arg p "$planner" '{stage: "planning", status: "completed", agent: "claude", model: $p,
    intendedModel: $p, executedModel: $p, executionEvidence: {status: "direct", source: "provider-response"}}' \
    > "$feature/.planning-result.json"
  jq -n '{stage: "coding", status: "completed", agent: "claude", model: "claude-opus-4-7",
    intendedModel: "claude-opus-4-7", executedModel: "claude-opus-4-7",
    executionEvidence: {status: "direct", source: "provider-response"}}' > "$feature/.coding-result.json"
  # The primary's review ran with ITS reviewer. A fork must never inherit it.
  write_completed_review "$feature" "gpt-5.6-terra" "codex"
  node "$REPO_ROOT/tests/fixtures/build-challenge-intent.ts" --stage review \
    --pair-id "$key" --slug "$slug" \
    --primary-planner claude-opus-5-5 --challenger-planner claude-opus-5-5 \
    --primary-coder claude-opus-4-7 --challenger-coder claude-opus-4-7 \
    --primary-reviewer gpt-5.6-terra --primary-reviewer-agent codex \
    --challenger-reviewer kimi-k2 --challenger-reviewer-agent native-openrouter \
    --plan-depth deep --code-depth deep --review-mode llm > "$feature/challenge-intent.json"
  state_mutate "$STATE_FILE" \
    '.tasks[$k] = {slug: $slug, worktree: $wt, challenge: true, challengeRole: "primary", challengePairId: $k,
       challengeStage: "review", challengeModel: "gpt-5.6-terra", challengeVariedModel: "gpt-5.6-terra",
       plannerModel: $p, coderModel: "claude-opus-4-7", reviewerModel: "gpt-5.6-terra",
       planDepth: $d, codeDepth: $d, reviewMode: "llm", phase: "review"}' \
    --arg k "$key" --arg slug "$slug" --arg wt "$wt" --arg p "$planner" --arg d "$depth"
  local arm_json
  arm_json="$(challenge_arm_json_build \
    "${key}_c" "${slug}-challenger" "task/${slug}-challenger" "challenger" "review" \
    "claude-opus-4-7" "claude-opus-5-5" "kimi-k2" \
    "claude" "claude" "native-openrouter" \
    "deep" "deep" "llm" "$(cat "$feature/challenge-intent.json")")"
  challenge_arms_record_pending "$key" "$arm_json"
}

# A completed review with direct, provider-reported evidence for <model>.
write_completed_review() {
  local feature="$1" model="$2" agent="$3"
  jq -n --arg m "$model" --arg a "$agent" '{
    stage: "review", status: "completed", agent: $a, model: $m, intendedModel: $m, executedModel: $m,
    executionEvidence: {status: "direct", source: "provider-response"},
    modelAttributionEligible: true,
    artifacts: {reviewExecutedIdentity: {
      orchestrator: {role: "orchestrator", requestedModel: $m, resolvedModel: $m, agent: $a, source: "provider-response", pinned: true},
      substantiveAnalysis: {role: "substantiveAnalysis", requestedModel: $m, resolvedModel: $m, agent: $a, source: "provider-response", pinned: true}
    }}
  }' > "$feature/.review-result.json"
}

printf '{"tasks":{}}\n' > "$STATE_FILE"

echo "=== 1-2. review fork writes the challenger's own route and records ==="
seed_primary "HOK-9101" "own-route" "claude-opus-5-5" "deep"
PRIMARY_WT="$WORKTREE_ROOT/own-route"
PRIMARY_FEATURE="$PRIMARY_WT/features/own-route"
CH_KEY="HOK-9101_c"
CH_WT="$WORKTREE_ROOT/own-route-challenger"
CH_FEATURE="$CH_WT/features/own-route-challenger"

challenge_maybe_materialize_deferred_arms "HOK-9101" "own-route" "$PRIMARY_FEATURE" "$PRIMARY_WT"
arm_state="$(jq -r '.tasks["HOK-9101"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "arm materialized" "materialized" "$arm_state"
check_eq "challenger phase-config review.model is its own reviewer" "kimi-k2" "$(jq -r '.review.model' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger phase-config review.agent is its own agent" "native-openrouter" "$(jq -r '.review.agent' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger phase-config review.challengeSide" "challenger" "$(jq -r '.review.challengeSide' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger phase-config planning stays inherited" "claude-opus-5-5" "$(jq -r '.planning.model' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger phase-config coding stays inherited" "claude-opus-4-7" "$(jq -r '.coding.model' "$CH_FEATURE/.phase-config.json")"
check_eq "challenger .routing-complete reviewer is its own" "kimi-k2" "$(jq -r '.reviewer' "$CH_FEATURE/.routing-complete")"
check_eq "primary phase-config untouched" "gpt-5.6-terra" "$(jq -r '.review.model' "$PRIMARY_FEATURE/.phase-config.json")"
check_eq "running review result names the challenger reviewer (not the primary's)" "kimi-k2" \
  "$(jq -r '.intendedModel' "$CH_FEATURE/.review-result.json")"
check_eq "running review result is the challenger's own run" "running" "$(jq -r '.status' "$CH_FEATURE/.review-result.json")"
check_eq "challengeModel is the varied reviewer" "kimi-k2" "$(jq -r --arg k "$CH_KEY" '.tasks[$k].challengeModel' "$STATE_FILE")"
check_eq "challengeVariedModel is the varied reviewer" "kimi-k2" "$(jq -r --arg k "$CH_KEY" '.tasks[$k].challengeVariedModel' "$STATE_FILE")"
check_eq "coderModel stays the shared coder" "claude-opus-4-7" "$(jq -r --arg k "$CH_KEY" '.tasks[$k].coderModel' "$STATE_FILE")"
check_eq "review launch uses the challenger reviewer" "kimi-k2" "$(awk '{print $(NF-2)}' "$TMP_DIR/launches.txt")"
check_eq "planning/coding results stamped inherited" "inherited inherited" \
  "$(jq -r '.source' "$CH_FEATURE/.planning-result.json") $(jq -r '.source' "$CH_FEATURE/.coding-result.json")"
ISSUE="$CH_KEY"
check_eq "completion-time stage-result model resolves to the challenger reviewer" "kimi-k2" \
  "$(resolve_stage_result_model "$CH_FEATURE" "review" "claude-sonnet-5")"
ISSUE="HOK-9101"
check_eq "primary completion-time stage-result model stays its own reviewer" "gpt-5.6-terra" \
  "$(resolve_stage_result_model "$PRIMARY_FEATURE" "review" "claude-sonnet-5")"
set +e
node "$TOOLS_DIR/check-challenge-route.ts" --stage review --repo-dir "$REPO_ROOT" \
  --primary-feature-dir "$PRIMARY_FEATURE" --challenger-feature-dir "$CH_FEATURE" > "$TMP_DIR/check.json" 2>/dev/null
check_rc=$?
set -e
check_eq "materialised arms differ only at review" "0 []" "$check_rc $(jq -c '.driftedFields' "$TMP_DIR/check.json")"

echo "=== 3. completed pair: reviewer-only, provenance valid, route stampable ==="
write_completed_review "$CH_FEATURE" "kimi-k2" "native-openrouter"
CH_HEAD="$(git -C "$CH_WT" rev-parse HEAD)"
cat > "$TMP_DIR/e2e.mts" <<TS
import {
  buildComparisonRoutingMeta,
  classifyChallengeType,
  detectVariedDimensions,
  resolveChallengeSideExecutionProvenance,
  validateChallengeExecutionProvenance,
} from '$REPO_ROOT/shared/lib/challenge-comparison.ts';
import { reconcilePrRoute } from '$REPO_ROOT/shared/lib/pr-route-provenance.ts';
import { readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync('$STATE_FILE', 'utf-8'));
// Mirror the monitor's compare-prs launch: --<side>-model = challengeModel
// (varied), --<side>-coder = coderModel.
const routing = (key: string) => {
  const t = state.tasks[key];
  return buildComparisonRoutingMeta({
    planner: t.plannerModel, coder: t.coderModel, reviewer: t.reviewerModel,
    planDepth: t.planDepth, codeDepth: t.codeDepth, reviewMode: t.reviewMode,
    variedModelFallback: t.challengeModel,
  });
};
const primaryRouting = routing('HOK-9101');
const challengerRouting = routing('$CH_KEY');
const varied = detectVariedDimensions(primaryRouting, challengerRouting)!;
const validation = validateChallengeExecutionProvenance({
  primaryExecution: resolveChallengeSideExecutionProvenance({ featureDir: '$PRIMARY_FEATURE', repoDir: '$REPO_ROOT' }),
  challengerExecution: resolveChallengeSideExecutionProvenance({ featureDir: '$CH_FEATURE', repoDir: '$REPO_ROOT' }),
  primaryRouting,
  challengerRouting,
  primaryModel: state.tasks['HOK-9101'].challengeModel,
  challengerModel: state.tasks['$CH_KEY'].challengeModel,
  variedDimensions: varied,
  variedStage: 'review',
  repoDir: '$REPO_ROOT',
});
const reconciliation = await reconcilePrRoute({ issue: 'HOK-9101', featureDir: '$CH_FEATURE', currentHeadSha: '$CH_HEAD' });
console.log(JSON.stringify({
  challengeType: classifyChallengeType(varied),
  valid: validation.valid,
  outcome: validation.outcome ?? null,
  routeComplete: reconciliation.complete,
  reviewer: reconciliation.route.reviewer.substantiveAnalysis?.resolved_model ?? null,
  planner: reconciliation.route.planner.status,
  coder: reconciliation.route.coder.status,
}));
TS
E2E="$(node "$TMP_DIR/e2e.mts" 2>"$TMP_DIR/e2e.err" || true)"
[[ -n "$E2E" ]] || { echo "e2e script failed:"; cat "$TMP_DIR/e2e.err"; }
check_eq "comparison routing varies only the reviewer" "reviewer-only" "$(jq -r '.challengeType' <<<"$E2E" 2>/dev/null || echo "error: $(cat "$TMP_DIR/e2e.err")")"
check_eq "provenance validation accepts the pair" "true" "$(jq -r '.valid' <<<"$E2E" 2>/dev/null || echo error)"
check_eq "challenger route reconciliation is complete (stampable)" "true" "$(jq -r '.routeComplete' <<<"$E2E" 2>/dev/null || echo error)"
check_eq "stamped reviewer is the challenger's own" "kimi-k2" "$(jq -r '.reviewer' <<<"$E2E" 2>/dev/null || echo error)"
check_eq "inherited planner/coder are stampable" "inherited inherited" "$(jq -r '"\(.planner) \(.coder)"' <<<"$E2E" 2>/dev/null || echo error)"

echo "=== 4. a primary that drifted after sealing collapses the pair at fork time ==="
rm -f "$TMP_DIR/launches.txt"
seed_primary "HOK-9102" "drifted" "claude-opus-4-7" "medium"
challenge_maybe_materialize_deferred_arms "HOK-9102" "drifted" "$WORKTREE_ROOT/drifted/features/drifted" "$WORKTREE_ROOT/drifted"
check_eq "drifted arm cancelled" "cancelled" "$(jq -r '.tasks["HOK-9102"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "drifted arm cancel reason" "route-drift" "$(jq -r '.tasks["HOK-9102"].challengeArms[0].cancelReason' "$STATE_FILE")"
check_eq "drift detail names the dimensions" "dimensions=planner,planDepth,codeDepth" "$(jq -r '.tasks["HOK-9102"].challengeArms[0].cancelDetail' "$STATE_FILE")"
check_eq "primary released as a solo run" "false route-drift" \
  "$(jq -r '"\(.tasks["HOK-9102"].challenge) \(.tasks["HOK-9102"].challengeCollapseReason)"' "$STATE_FILE")"
check_eq "challenge_collapsed reason=route-drift emitted" "yes" \
  "$(grep -q 'challenge_collapsed issue=HOK-9102 .*reason=route-drift' "$LOG_FILE" && echo yes || echo no)"
check_eq "no challenger branch cut" "absent" \
  "$(git -C "$REPO_DIR" show-ref --verify --quiet refs/heads/task/drifted-challenger && echo present || echo absent)"
check_eq "no challenger launched" "absent" "$([[ -s "$TMP_DIR/launches.txt" ]] && echo present || echo absent)"

echo "=== 5. pre-review preflight for a non-deferred pair ==="
# Two live arms (plan-stage pair) whose coders drifted apart after sealing.
mk_arm_dir() {
  local slug="$1" planner="$2" coder="$3" feature="$WORKTREE_ROOT/$1/features/$1"
  mkdir -p "$feature"
  jq -n --arg p "$planner" --arg c "$coder" '{planning: {model: $p, depth: "deep"},
    coding: {model: $c, depth: "deep"}, review: {model: "gpt-5.6-terra", mode: "llm"}}' > "$feature/.phase-config.json"
  printf '%s\n' "$feature"
}
P_DIR="$(mk_arm_dir plan-pair claude-opus-5-5 claude-opus-4-7)"
C_DIR="$(mk_arm_dir plan-pair-c glm-5.2 gpt-5.6-terra)"
state_mutate "$STATE_FILE" \
  '.tasks["HOK-9103"] = {slug: "plan-pair", worktree: $pw, challenge: true, challengeRole: "primary",
     challengePairId: "HOK-9103", challengeStage: "plan"}
   | .tasks["HOK-9103_c"] = {slug: "plan-pair-c", worktree: $cw, challenge: true, challengeRole: "challenger",
     challengePairId: "HOK-9103", challengeStage: "plan"}' \
  --arg pw "$WORKTREE_ROOT/plan-pair" --arg cw "$WORKTREE_ROOT/plan-pair-c"
rm -f "$TMP_DIR/cancelled.txt"
preflight_rc=0
challenge_pre_review_route_preflight "HOK-9103" "$P_DIR" "$WORKTREE_ROOT/plan-pair" || preflight_rc=$?
check_eq "primary continues after collapsing its drifted challenger" "0" "$preflight_rc"
check_eq "challenger torn down with multiple-varied-roles" "multiple-varied-roles dimensions=coder" \
  "$(cut -d'|' -f7,8 "$TMP_DIR/cancelled.txt" 2>/dev/null | tr '|' ' ' || echo none)"
check_eq "preflight verdict cached" "drift" "$(jq -r '.status' "$P_DIR/.challenge-route-preflight.json")"

rm -f "$TMP_DIR/cancelled.txt" "$C_DIR/.challenge-route-preflight.json"
state_mutate "$STATE_FILE" '.tasks["HOK-9103"].pr = "4242"'
challenge_pre_review_route_preflight "HOK-9103_c" "$C_DIR" "$WORKTREE_ROOT/plan-pair-c"
check_eq "with a PR open the pair is not torn down" "absent" "$([[ -f "$TMP_DIR/cancelled.txt" ]] && echo present || echo absent)"
check_eq "both arms record invalid_challenge:multiple-varied-roles" "multiple-varied-roles multiple-varied-roles" \
  "$(jq -r '"\(.tasks["HOK-9103"].challengeDivergenceReason) \(.tasks["HOK-9103_c"].challengeDivergenceReason)"' "$STATE_FILE")"

# Review-stage pair: arms that differ only in the reviewer pass the preflight.
mk_review_arm() {
  local slug="$1" reviewer="$2" plan_depth="$3" feature="$WORKTREE_ROOT/$1/features/$1"
  mkdir -p "$feature"
  jq -n --arg r "$reviewer" --arg d "$plan_depth" '{planning: {model: "claude-opus-5-5", depth: $d},
    coding: {model: "claude-opus-4-7", depth: "deep"}, review: {model: $r, mode: "llm"}}' > "$feature/.phase-config.json"
  printf '%s\n' "$feature"
}
RP_DIR="$(mk_review_arm rev-pair gpt-5.6-terra deep)"
RC_DIR="$(mk_review_arm rev-pair-c kimi-k2 deep)"
state_mutate "$STATE_FILE" \
  '.tasks["HOK-9104"] = {slug: "rev-pair", worktree: $pw, challenge: true, challengeRole: "primary",
     challengePairId: "HOK-9104", challengeStage: "review"}
   | .tasks["HOK-9104_c"] = {slug: "rev-pair-c", worktree: $cw, challenge: true, challengeRole: "challenger",
     challengePairId: "HOK-9104", challengeStage: "review"}' \
  --arg pw "$WORKTREE_ROOT/rev-pair" --arg cw "$WORKTREE_ROOT/rev-pair-c"
rm -f "$TMP_DIR/cancelled.txt"
preflight_rc=0
challenge_pre_review_route_preflight "HOK-9104_c" "$RC_DIR" "$WORKTREE_ROOT/rev-pair-c" || preflight_rc=$?
check_eq "reviewer-only pair passes the preflight" "0" "$preflight_rc"
check_eq "reviewer-only pair is not torn down" "absent" "$([[ -f "$TMP_DIR/cancelled.txt" ]] && echo present || echo absent)"
check_eq "reviewer-only verdict cached as ok" "ok" "$(jq -r '.status' "$RC_DIR/.challenge-route-preflight.json")"

# Same pair after the challenger's plan depth drifted: reviewer + planDepth.
rm -f "$RC_DIR/.challenge-route-preflight.json"
state_mutate "$RC_DIR/.phase-config.json" '.planning.depth = "shallow"'
preflight_rc=0
challenge_pre_review_route_preflight "HOK-9104" "$RP_DIR" "$WORKTREE_ROOT/rev-pair" || preflight_rc=$?
check_eq "primary continues after collapsing reviewer+planDepth drift" "0" "$preflight_rc"
check_eq "reviewer+planDepth pair collapses as multiple-varied-roles" "multiple-varied-roles" \
  "$(cut -d'|' -f7 "$TMP_DIR/cancelled.txt" 2>/dev/null || echo none)"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  echo "--- log ---"; cat "$LOG_FILE" 2>/dev/null || true
  exit 1
fi
echo "review_challenger_owns_its_route OK"
