#!/usr/bin/env bash
# HOK-2814: lifecycle fixture — deferred challenger arm materialises after the
# primary's coding phase completes. Standalone (like tend_challenge_winner_
# merges_loser_cleanup.sh) because the shared lifecycle harness in
# lifecycle-scenarios.test.sh does not extract the fork trigger / materialiser
# and its call sites are `|| true` guarded, so a fork-only lifecycle would
# vanish silently there.
#
# What this fixture asserts, end-to-end against a scratch git repo:
#   1. A primary in coding=completed with an awaiting_fork arm has the
#      "pre-fork" state shape (arm state awaiting_fork, primary has no
#      challengerLaunched flag).
#   2. Driving the on-disk materialisation steps (branch + worktree at fork
#      commit, artifact copy loop, source=inherited stamp, fork descriptor
#      stamp) advances the arm through awaiting_fork → materializing →
#      materialized.
#   3. After materialisation, .tasks[<primary>].challengerLaunched = true.
#   4. The challenger appears as a first-class task at phase=review.
#
# The full-suite regression backstop is challenge-fork-materialisation.test.sh;
# this fixture ensures the shape survives the fixture pipeline the other
# lifecycle scenarios travel through.
set -euo pipefail

# Guard against being sourced.
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"
ARMS_SCRIPT="$REPO_ROOT/shared/lib/challenge-arms.sh"

TMP_DIR="$(mktemp -d "/tmp/wavemill-deferred-materialises.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_FILE="$TMP_DIR/workflow-state.json"
export STATE_FILE

state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../../../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"

log_route_lifecycle() { :; }
log() { :; }
log_warn() { :; }
log_error() { :; }

# ────────────────────────────────────────────────────────────────
# Scratch git repo — primary at coding=completed.
# ────────────────────────────────────────────────────────────────
SCRATCH_REPO="$TMP_DIR/repo"
WORKTREE_ROOT="$TMP_DIR/worktrees"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
git -C "$SCRATCH_REPO" init -q -b main
git -C "$SCRATCH_REPO" config user.email test@example.com
git -C "$SCRATCH_REPO" config user.name test
echo initial > "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'initial'
git -C "$SCRATCH_REPO" checkout -q -b task/deferred
echo more >> "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'primary coding work'
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

PRIMARY_FEATURE="$SCRATCH_REPO/features/deferred"
mkdir -p "$PRIMARY_FEATURE"
touch "$PRIMARY_FEATURE/.plan-approved" "$PRIMARY_FEATURE/.coding-complete"
cat > "$PRIMARY_FEATURE/plan.md" <<'PLAN'
Primary plan
PLAN
cat > "$PRIMARY_FEATURE/.planning-result.json" <<'JSON'
{"stage":"planning","status":"completed","model":"claude-sonnet-5","agent":"claude"}
JSON
cat > "$PRIMARY_FEATURE/.coding-result.json" <<'JSON'
{"stage":"coding","status":"completed","model":"claude-opus-4-7","agent":"claude"}
JSON
cat > "$PRIMARY_FEATURE/.challenge-intent.json" <<'JSON'
{"schemaVersion":1,"pairId":"HOK-DEFER","issueId":"HOK-DEFER","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-DEFER","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-DEFER","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}},"forkStage":null,"forkCommit":null,"sharedPrefix":false}
JSON
cp "$PRIMARY_FEATURE/.challenge-intent.json" "$PRIMARY_FEATURE/challenge-intent.json"

# ────────────────────────────────────────────────────────────────
# Seed state — primary at coding=completed with an awaiting_fork arm.
# ────────────────────────────────────────────────────────────────
printf '%s\n' '{"session":"lifecycle","tasks":{"HOK-DEFER":{"slug":"deferred","branch":"task/deferred","phase":"coding","status":"active","challenge":true,"challengeRole":"primary","challengePairId":"HOK-DEFER","challengeStage":"review"}}}' > "$STATE_FILE"

CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-DEFER","issueId":"HOK-DEFER","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-DEFER","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-DEFER","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}}}'
ARM_JSON="$(challenge_arm_json_build \
  "HOK-DEFER_c" "deferred-c" "task/deferred-c" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static" \
  "$CANONICAL_INTENT")"
challenge_arms_record_pending "HOK-DEFER" "$ARM_JSON"

# Sanity: shape before fork.
[[ "$(jq -r '.tasks["HOK-DEFER"].challengeArms[0].challengeArmState' "$STATE_FILE")" == "awaiting_fork" ]] \
  || { echo "FAIL: arm not awaiting_fork before fork trigger"; exit 1; }
[[ "$(jq -r '.tasks["HOK-DEFER"].challengerLaunched // ""' "$STATE_FILE")" == "" ]] \
  || { echo "FAIL: challengerLaunched should not be set pre-fork"; exit 1; }
[[ "$(jq -r 'has("tasks") and (.tasks | has("HOK-DEFER_c"))' "$STATE_FILE")" == "false" ]] \
  || { echo "FAIL: challenger task should not exist pre-fork"; exit 1; }

# ────────────────────────────────────────────────────────────────
# Drive materialisation. The fork-trigger's on-disk steps are: claim the arm
# (checked-and-set awaiting_fork → materializing), create branch + worktree
# at the fork commit, copy the primary's feature dir minus the review
# artifact, stamp source=inherited on the stage results, stamp the fork
# descriptor on both intent files, save the challenger's task state, and
# flip the arm to materialized.
# ────────────────────────────────────────────────────────────────
challenge_arms_set_state "HOK-DEFER" "HOK-DEFER_c" "awaiting_fork" "materializing" \
  || { echo "FAIL: could not claim arm"; exit 1; }

CHALLENGER_WT_DIR="$WORKTREE_ROOT/deferred-c"
CHALLENGER_FEATURE="$CHALLENGER_WT_DIR/features/deferred-c"
git -C "$SCRATCH_REPO" worktree add -b task/deferred-c "$CHALLENGER_WT_DIR" "$FORK_COMMIT" >/dev/null 2>&1

mkdir -p "$CHALLENGER_FEATURE"
for artifact in \
  plan.md .plan-approved .phase-config.json \
  .routing-complete .initial-route.json .post-expansion-route.json \
  selected-task.json \
  task-packet.md task-packet-header.md task-packet-details.md \
  challenge-intent.json .challenge-intent.json \
  .trace-context.json trace.jsonl routing.jsonl \
  .planning-result.json .coding-result.json .coding-complete; do
  [[ -e "$PRIMARY_FEATURE/$artifact" ]] \
    && cp -R "$PRIMARY_FEATURE/$artifact" "$CHALLENGER_FEATURE/$artifact" 2>/dev/null || true
done

for stage_file in .planning-result.json .coding-result.json; do
  [[ -f "$CHALLENGER_FEATURE/$stage_file" ]] || continue
  tmp="$(mktemp)"
  jq '.source = "inherited"' "$CHALLENGER_FEATURE/$stage_file" > "$tmp"
  mv "$tmp" "$CHALLENGER_FEATURE/$stage_file"
done

eval "$(awk '/^challenge_intent_stamp_fork_descriptor\(\) \{/{c=1} c{print} /^}/ && c{exit}' "$MONITOR_SCRIPT_FILE")"
challenge_intent_stamp_fork_descriptor \
  "HOK-DEFER" "HOK-DEFER_c" \
  "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE" \
  "review" "$FORK_COMMIT" '["plan","implementation"]' >/dev/null 2>&1

# Save the challenger task and flip primary.challengerLaunched.
state_mutate "$STATE_FILE" \
  '.tasks["HOK-DEFER_c"] = {slug:"deferred-c", branch:"task/deferred-c", worktree:$wt,
      challenge:true, challengePairId:"HOK-DEFER", challengeRole:"challenger",
      challengeStage:"review", phase:"review",
      plannerModel:"claude-sonnet-5", coderModel:"claude-opus-4-7", reviewerModel:"claude-haiku-4-5-20251001"}
   | .tasks["HOK-DEFER"].challengerLaunched = true' \
  --arg wt "$CHALLENGER_WT_DIR"

challenge_arms_set_state "HOK-DEFER" "HOK-DEFER_c" "materializing" "materialized" \
  "$(jq -cn --arg fc "$FORK_COMMIT" '{materializedAt: (now | todate), forkCommit: $fc}')"

# ────────────────────────────────────────────────────────────────
# Assertions
# ────────────────────────────────────────────────────────────────
fail_count=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label — expected=$expected actual=$actual"
    fail_count=$((fail_count + 1))
  fi
}

assert_eq "arm transitions awaiting_fork → materialized" \
  "materialized" \
  "$(jq -r '.tasks["HOK-DEFER"].challengeArms[0].challengeArmState' "$STATE_FILE")"

assert_eq "arm forkCommit stamped" \
  "$FORK_COMMIT" \
  "$(jq -r '.tasks["HOK-DEFER"].challengeArms[0].forkCommit' "$STATE_FILE")"

assert_eq "primary challengerLaunched=true" \
  "true" \
  "$(jq -r '.tasks["HOK-DEFER"].challengerLaunched' "$STATE_FILE")"

assert_eq "challenger task appears at phase=review" \
  "review" \
  "$(jq -r '.tasks["HOK-DEFER_c"].phase' "$STATE_FILE")"

assert_eq "challenger task has role=challenger" \
  "challenger" \
  "$(jq -r '.tasks["HOK-DEFER_c"].challengeRole' "$STATE_FILE")"

assert_eq "challenger worktree at fork commit" \
  "$FORK_COMMIT" \
  "$(git -C "$CHALLENGER_WT_DIR" rev-parse HEAD)"

assert_eq "challenger .planning-result.json source=inherited" \
  "inherited" \
  "$(jq -r '.source' "$CHALLENGER_FEATURE/.planning-result.json")"

assert_eq "challenger .coding-result.json source=inherited" \
  "inherited" \
  "$(jq -r '.source' "$CHALLENGER_FEATURE/.coding-result.json")"

assert_eq "challenger .challenge-intent.json forkStage" \
  "review" \
  "$(jq -r '.forkStage' "$CHALLENGER_FEATURE/.challenge-intent.json")"

assert_eq "challenger .challenge-intent.json forkCommit" \
  "$FORK_COMMIT" \
  "$(jq -r '.forkCommit' "$CHALLENGER_FEATURE/.challenge-intent.json")"

if [[ "$fail_count" -gt 0 ]]; then
  echo ""
  echo "$fail_count assertions failed"
  exit 1
fi

echo "deferred_challenger_materialises_after_coding OK"
exit 0
