#!/usr/bin/env bash
# HOK-2811 (Arbiter P2.4a) — Deferred arm materialisation and fork triggers
# for reviewer-stage challenges.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
ARMS_SCRIPT="$REPO_DIR/shared/lib/challenge-arms.sh"
BOUNDED_RETRY_SCRIPT="$REPO_DIR/shared/lib/bounded-retry.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

# Provide a stub state_mutate BEFORE sourcing challenge-arms.sh (its helpers
# call it via the shell's late binding).
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"
# shellcheck source=../shared/lib/bounded-retry.sh
source "$BOUNDED_RETRY_SCRIPT"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STATE_FILE="$TMP_ROOT/state.json"
: > "$STATE_FILE"
printf '%s\n' '{"session":"test","tasks":{"HOK-1234":{"slug":"foo","challenge":true,"challengeRole":"primary","challengePairId":"HOK-1234"}}}' > "$STATE_FILE"

log_route_lifecycle() { :; }

# ────────────────────────────────────────────────────────────────
# Test 1: arm helpers - build, record, list, get, transition, cancel
# ────────────────────────────────────────────────────────────────
echo "=== challenge-arms.sh helpers ==="

ARM_JSON="$(challenge_arm_json_build \
  "HOK-1234_c" "foo-challenger" "task/foo-challenger" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static")"

if echo "$ARM_JSON" | jq -e '.key == "HOK-1234_c" and .challengeArmState == "awaiting_fork" and .variedStage == "review" and .models.reviewer == "claude-haiku-4-5-20251001"' >/dev/null; then
  pass "challenge_arm_json_build produces well-formed record"
else
  echo "$ARM_JSON"
  fail "challenge_arm_json_build produces well-formed record"
fi
check_eq "14-arg arm build keeps executionIntent null" "null" "$(echo "$ARM_JSON" | jq -r '.executionIntent | type')"

CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-1234","issueId":"HOK-1234","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-1234","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-1234","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}}}'
ARM_WITH_INTENT="$(challenge_arm_json_build \
  "HOK-1234_c" "foo-challenger" "task/foo-challenger" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static" \
  "$CANONICAL_INTENT")"
if echo "$ARM_WITH_INTENT" | jq -e '.executionIntent.schemaVersion == 1 and .executionIntent.pairId == "HOK-1234"' >/dev/null; then
  pass "challenge_arm_json_build embeds canonical execution intent"
else
  echo "$ARM_WITH_INTENT"
  fail "challenge_arm_json_build embeds canonical execution intent"
fi

challenge_intent_record_selection "HOK-1234" "HOK-1234_c" "$CANONICAL_INTENT"
if jq -e '.tasks["HOK-1234"].challengeExecutionIntent.pairId == "HOK-1234" and .tasks["HOK-1234"].challengeStage == "review"' "$STATE_FILE" >/dev/null; then
  pass "challenge_intent_record_selection promotes canonical intent to state"
else
  fail "challenge_intent_record_selection promotes canonical intent to state"
fi

challenge_arms_record_pending "HOK-1234" "$ARM_JSON"
PENDING_COUNT=$(challenge_arms_list_pending "HOK-1234" | jq -r 'length')
check_eq "one pending arm after record_pending" "1" "$PENDING_COUNT"

# Idempotent replace-by-key
challenge_arms_record_pending "HOK-1234" "$ARM_JSON"
PENDING_COUNT=$(challenge_arms_list_pending "HOK-1234" | jq -r 'length')
check_eq "record_pending is idempotent by key" "1" "$PENDING_COUNT"

FETCHED=$(challenge_arms_get "HOK-1234" "HOK-1234_c")
if echo "$FETCHED" | jq -e '.slug == "foo-challenger"' >/dev/null; then
  pass "challenge_arms_get returns the arm"
else
  fail "challenge_arms_get returns the arm"
fi

# Checked-and-set: correct predecessor transitions
if challenge_arms_set_state "HOK-1234" "HOK-1234_c" "awaiting_fork" "materializing"; then
  pass "awaiting_fork → materializing succeeds"
else
  fail "awaiting_fork → materializing succeeds"
fi

# Checked-and-set: wrong predecessor fails (would-be race)
if challenge_arms_set_state "HOK-1234" "HOK-1234_c" "awaiting_fork" "materializing" 2>/dev/null; then
  fail "second awaiting_fork → materializing should fail (checked-and-set)"
else
  pass "second awaiting_fork → materializing fails (checked-and-set)"
fi

# Extra JSON merged in
if challenge_arms_set_state "HOK-1234" "HOK-1234_c" "materializing" "materialized" \
  '{"forkCommit":"abc123","materializedAt":"2026-01-01T00:00:00Z"}'; then
  pass "materializing → materialized succeeds with extras"
else
  fail "materializing → materialized succeeds with extras"
fi
FORK=$(jq -r '.tasks["HOK-1234"].challengeArms[0].forkCommit' "$STATE_FILE")
check_eq "forkCommit stamped by extra_object" "abc123" "$FORK"

# cancel_pending on a materialized arm is a no-op (not in awaiting_fork)
challenge_arms_cancel_pending "HOK-1234" "test_reason" || true
STATE_AFTER=$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")
check_eq "cancel_pending skips non-pending arms" "materialized" "$STATE_AFTER"

# Now cancel a fresh pending arm
printf '%s\n' '{"session":"test","tasks":{"HOK-1234":{"slug":"foo","challenge":true,"challengeRole":"primary","challengePairId":"HOK-1234"}}}' > "$STATE_FILE"
challenge_arms_record_pending "HOK-1234" "$ARM_JSON"
challenge_arms_cancel_pending "HOK-1234" "primary_aborted_pre_fork"
CANCEL_STATE=$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")
check_eq "cancel_pending flips awaiting_fork → cancelled" "cancelled" "$CANCEL_STATE"
CANCEL_REASON=$(jq -r '.tasks["HOK-1234"].challengeArms[0].cancelReason' "$STATE_FILE")
check_eq "cancel_pending stamps cancelReason" "primary_aborted_pre_fork" "$CANCEL_REASON"
CHALLENGE_AFTER=$(jq -r '.tasks["HOK-1234"].challenge' "$STATE_FILE")
check_eq "cancel_pending clears .challenge on primary" "false" "$CHALLENGE_AFTER"
if jq -e '.tasks["HOK-1234"].challengePairId' "$STATE_FILE" >/dev/null; then
  fail "cancel_pending clears challengePairId"
else
  pass "cancel_pending clears challengePairId"
fi

# ────────────────────────────────────────────────────────────────
# Test 2: launch-site source verification (static — no runtime)
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== launch-site deferral hooks ==="

# The monitor's launch_task must defer challenger creation on review-stage,
# and the pre-fork /tmp packet fan-out must be gated on defer_challenger.
MONITOR_LAUNCH_BLOCK=$(awk '
  /HOK-2811 \/ HOK-3086: review- and implementation-stage challenges defer the/ { capture=1 }
  capture { print }
  /should_launch_challenger="false"/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "monitor guards packet mirror on defer_challenger" "$MONITOR_LAUNCH_BLOCK" 'if [[ "$defer_challenger" != "true" ]]; then'
check_contains "monitor sets defer_challenger for fork stages (review, implementation)" "$MONITOR_LAUNCH_BLOCK" 'if challenge_stage_defers_to_fork "$challenge_stage"; then'
check_contains "monitor skips recursion by clearing should_launch_challenger" "$MONITOR_LAUNCH_BLOCK" 'should_launch_challenger="false"'

MONITOR_PENDING_BLOCK=$(awk '
  /HOK-2811: Review-stage — record the challenger as a pending arm/,/persist_challenge_execution_intent "\$issue" "\$challenger_key" \\/
' "$MONITOR_SCRIPT_FILE")
check_contains "monitor calls challenge_arms_record_pending on defer" "$MONITOR_PENDING_BLOCK" 'challenge_arms_record_pending "$issue"'

# The mill startup Phase 5 must skip challenger from FINAL_LAUNCH_ARGS and
# record a pending arm.
MILL_BLOCK=$(awk '
  /HOK-2811 \/ HOK-3086: review- and implementation-stage challenges defer the/,/log "warn" "  \$ISSUE: failed to record pending challenger arm/
' "$MILL_SCRIPT")
check_contains "mill sets defer_challenger for fork stages (review, implementation)" "$MILL_BLOCK" 'if challenge_stage_defers_to_fork "$challenge_stage"; then'
check_contains "mill skips FINAL_LAUNCH_ARGS challenger entry when deferring" "$MILL_BLOCK" 'if [[ "$defer_challenger" != "true" ]]; then'
check_contains "mill records pending arm on defer" "$MILL_BLOCK" 'challenge_arms_record_pending "$ISSUE"'

# The pending arm build must pass the challenger's *reviewer* agent for the
# reviewer slot — not the planner-agent fallback (which would defeat the whole
# point of a reviewer-varied challenge).
MILL_EXTRACT_BLOCK=$(awk '
  /challenger_entry_planner_agent=\$\(echo "\$challenge_plan"/,/challenge_intent=/
' "$MILL_SCRIPT")
check_contains "mill extracts challenger reviewer agent from plan" "$MILL_EXTRACT_BLOCK" 'challenger_entry_reviewer_agent=$(echo "$challenge_plan"'
check_contains "mill passes challenger reviewer agent to arm builder" "$MILL_BLOCK" '"${challenger_entry_reviewer_agent:-${challenger_agent:-$AGENT_CMD}}"'

# The materialiser must mirror launch_task's post-worktree seeding: copy the
# .wavemill-config.local.json overlay if present, and prime node_modules from
# the primary (plan §Phase C step 3).
MATERIALIZE_BLOCK=$(awk '
  /^challenge_materialize_challenger_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "materialiser copies .wavemill-config.local.json overlay" "$MATERIALIZE_BLOCK" '.wavemill-config.local.json'
check_contains "materialiser primes deps via worktree_deps_ensure" "$MATERIALIZE_BLOCK" 'worktree_deps_ensure "$challenger_wt_dir" "$primary_wt_dir"'
check_contains "materialiser backfills missing challenge intent" "$MATERIALIZE_BLOCK" 'challenge intent backfilled during materialisation'
check_contains "materialiser validates primary challenge intent before review" "$MATERIALIZE_BLOCK" 'challenge_intent_files_valid "$primary_feature_dir"'
check_contains "materialiser returns terminal rc for missing intent" "$MATERIALIZE_BLOCK" 'return 2'

FORK_TRIGGER_BLOCK=$(awk '
  /^challenge_maybe_materialize_deferred_arms\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "fork trigger treats missing intent as terminal" "$FORK_TRIGGER_BLOCK" 'materialise_rc == 2'
check_contains "fork trigger records missing_challenge_intent exhaustion" "$FORK_TRIGGER_BLOCK" 'exhaustReason: $r'
check_contains "fork trigger emits invalid intent lifecycle event" "$FORK_TRIGGER_BLOCK" 'challenge_arm_invalid_intent'

# ────────────────────────────────────────────────────────────────
# Test 2b (HOK-3065): plan-stage seal + expanded-route materialisation wiring
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== HOK-3065 launch-site seal + materialise wiring ==="

# The mill and monitor must SEAL a plan-stage challenge rather than coerce it to
# single mode; the pending arm is recorded in awaiting_expanded_route.
check_contains "mill seals plan-stage instead of coercing to single" \
  "$(cat "$MILL_SCRIPT")" \
  'plan_awaits_expanded_route="true"'
check_contains "mill no longer coerces plan-stage challenge to single" \
  "$([[ $(grep -c 'plan_stage_expanded_route_unavailable' "$MILL_SCRIPT") == "0" ]] && echo absent || echo present)" \
  'absent'
check_contains "mill passes awaiting_expanded_route pending state to arm builder" \
  "$(grep -B2 -A2 'pending_arm_state="awaiting_expanded_route"' "$MILL_SCRIPT")" \
  'pending_arm_state="awaiting_expanded_route"'
check_contains "mill forwards pending_arm_state to challenge_arm_json_build" \
  "$(cat "$MILL_SCRIPT")" \
  '"$pending_arm_state")"'

check_contains "monitor seals plan-stage instead of retargeting" \
  "$(cat "$MONITOR_SCRIPT_FILE")" \
  'plan_awaits_expanded_route="true"'
check_contains "monitor no longer retargets plan-stage to implementation" \
  "$([[ $(grep -c 'retargeted to implementation stage' "$MONITOR_SCRIPT_FILE") == "0" ]] && echo absent || echo present)" \
  'absent'
check_contains "monitor forwards pending_arm_state to challenge_arm_json_build" \
  "$(cat "$MONITOR_SCRIPT_FILE")" \
  '"${pending_arm_state:-awaiting_fork}")"'

# finalize (plan→code handoff) must materialise awaiting_expanded_route arms.
FINALIZE_BLOCK=$(awk '
  /^finalize_challenge_execution_intent_before_coding\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "finalize lists awaiting_expanded_route arms" "$FINALIZE_BLOCK" 'challenge_arms_list_awaiting_expanded_route "$issue"'
check_contains "finalize invokes the expanded-route materialiser" "$FINALIZE_BLOCK" 'challenge_maybe_materialize_expanded_route_arms "$issue"'

# The plan-stage materialiser forks at t=0 (base) and launches planning — not
# the reviewer-stage coding-HEAD fork that launches review.
MAT_EXPANDED_BLOCK=$(awk '
  /^challenge_materialize_expanded_route_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "expanded-route materialiser forks at the base (t=0)" "$MAT_EXPANDED_BLOCK" 'git -C "$REPO_DIR" worktree add -b "$arm_branch" "$challenger_wt_dir" "$fork_ref"'
check_contains "expanded-route materialiser launches planning, not review" "$MAT_EXPANDED_BLOCK" 'launch_planning_phase "$arm_key"'
check_contains "expanded-route materialiser resolves the sealed decision" "$MAT_EXPANDED_BLOCK" '--resolve-sealed --sealed-intent'
check_contains "expanded-route materialiser returns terminal rc for ineligible sealed challenger" "$MAT_EXPANDED_BLOCK" 'return 2'
check_contains "expanded-route materialiser excludes plan/coding artifacts (plans from t=0)" \
  "$([[ "$MAT_EXPANDED_BLOCK" == *".coding-complete"* ]] && echo present || echo absent)" \
  'absent'

# The expanded-route trigger drives only awaiting_expanded_route arms, uses the
# checked-and-set transition, and collapses (never substitutes) on terminal rc.
TRIGGER_EXPANDED_BLOCK=$(awk '
  /^challenge_maybe_materialize_expanded_route_arms\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "expanded-route trigger lists only its own pending arms" "$TRIGGER_EXPANDED_BLOCK" 'challenge_arms_list_awaiting_expanded_route "$primary_issue"'
check_contains "expanded-route trigger waits for the expanded route" "$TRIGGER_EXPANDED_BLOCK" '.post-expansion-route.json'
check_contains "expanded-route trigger uses checked-and-set exactly-once" "$TRIGGER_EXPANDED_BLOCK" 'challenge_arms_set_state "$primary_issue" "$arm_key" "awaiting_expanded_route" "materializing"'
check_contains "expanded-route trigger collapses (never substitutes) on terminal rc" "$TRIGGER_EXPANDED_BLOCK" 'challenge_cancel_challenger_arm "$primary_issue"'

# ────────────────────────────────────────────────────────────────
# Test 3: materialisation happy path (scratch git repo)
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== challenge_materialize_challenger_arm happy path ==="

# We test the artifact-copy + stage-result stamping + intent-descriptor
# stamping portions of the materialiser end-to-end. Steps that require the
# monitor's larger context (launch_review_phase, save_task_state trace-id
# machinery) are validated via inline snippets so this shell test remains
# hermetic.

SCRATCH_REPO="$TMP_ROOT/repo"
mkdir -p "$SCRATCH_REPO"
git -C "$SCRATCH_REPO" init -q -b main
git -C "$SCRATCH_REPO" config user.email test@example.com
git -C "$SCRATCH_REPO" config user.name test
echo initial > "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'initial'

git -C "$SCRATCH_REPO" checkout -q -b task/foo
echo more >> "$SCRATCH_REPO/README.md"
git -C "$SCRATCH_REPO" add README.md
git -C "$SCRATCH_REPO" commit -q -m 'primary coding work'
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

PRIMARY_FEATURE="$SCRATCH_REPO/features/foo"
mkdir -p "$PRIMARY_FEATURE"
# Seed the artifacts materialiser copies
cat > "$PRIMARY_FEATURE/plan.md" <<'PLAN'
Primary plan
PLAN
touch "$PRIMARY_FEATURE/.plan-approved" "$PRIMARY_FEATURE/.coding-complete"
cat > "$PRIMARY_FEATURE/.planning-result.json" <<'JSON'
{"stage":"planning","status":"completed","model":"claude-sonnet-5","agent":"claude"}
JSON
cat > "$PRIMARY_FEATURE/.coding-result.json" <<'JSON'
{"stage":"coding","status":"completed","model":"claude-opus-4-7","agent":"claude"}
JSON
cat > "$PRIMARY_FEATURE/.challenge-intent.json" <<'JSON'
{"schemaVersion":1,"pairId":"HOK-1234","issueId":"HOK-1234","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-1234","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-1234","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}},"forkStage":null,"forkCommit":null,"sharedPrefix":false}
JSON
cp "$PRIMARY_FEATURE/.challenge-intent.json" "$PRIMARY_FEATURE/challenge-intent.json"

# Extract the artifact-copy loop and the fork-descriptor stamp helper. We
# invoke the stamp helper directly (it's a self-contained jq rewrite) and
# simulate the copy loop.
extract_function() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MONITOR_SCRIPT_FILE"
}

eval "$(extract_function challenge_intent_stamp_fork_descriptor)"

CHALLENGER_FEATURE="$SCRATCH_REPO/features/foo-challenger"
mkdir -p "$CHALLENGER_FEATURE"

# Emulate step 3 (feature-dir copy). Exclusions verified below.
for artifact in \
  plan.md .plan-approved .phase-config.json \
  .routing-complete .initial-route.json .post-expansion-route.json \
  selected-task.json \
  task-packet.md task-packet-header.md task-packet-details.md \
  challenge-intent.json .challenge-intent.json \
  .trace-context.json trace.jsonl routing.jsonl \
  .planning-result.json .coding-result.json .coding-complete; do
  if [[ -e "$PRIMARY_FEATURE/$artifact" ]]; then
    cp -R "$PRIMARY_FEATURE/$artifact" "$CHALLENGER_FEATURE/$artifact" 2>/dev/null || true
  fi
done

# Stamp source=inherited on the copied stage results.
for stage_file in .planning-result.json .coding-result.json; do
  tmp=$(mktemp)
  jq '.source = "inherited"' "$CHALLENGER_FEATURE/$stage_file" > "$tmp"
  mv "$tmp" "$CHALLENGER_FEATURE/$stage_file"
done

INHERIT_PLAN=$(jq -r '.source' "$CHALLENGER_FEATURE/.planning-result.json")
INHERIT_CODE=$(jq -r '.source' "$CHALLENGER_FEATURE/.coding-result.json")
check_eq ".planning-result.json carries source=inherited" "inherited" "$INHERIT_PLAN"
check_eq ".coding-result.json carries source=inherited" "inherited" "$INHERIT_CODE"

# Exclusions: .review-result.json must NOT be in the copy list.
if [[ ! -f "$CHALLENGER_FEATURE/.review-result.json" ]]; then
  pass ".review-result.json is not inherited (excluded)"
else
  fail ".review-result.json is not inherited (excluded)"
fi

# Fork-descriptor stamping
challenge_intent_stamp_fork_descriptor \
  "HOK-1234" "HOK-1234_c" \
  "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE" \
  "review" "$FORK_COMMIT" \
  '["plan","implementation"]'

FORK_STAGE=$(jq -r '.forkStage' "$CHALLENGER_FEATURE/.challenge-intent.json")
FORK_COMMIT_FILE=$(jq -r '.forkCommit' "$CHALLENGER_FEATURE/.challenge-intent.json")
SHARED=$(jq -r '.sharedPrefix' "$CHALLENGER_FEATURE/.challenge-intent.json")
CH_INHERITED=$(jq -c '.challenger.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")
PR_INHERITED=$(jq -c '.primary.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")
check_eq "forkStage stamped on challenger intent" "review" "$FORK_STAGE"
check_eq "forkCommit stamped on challenger intent" "$FORK_COMMIT" "$FORK_COMMIT_FILE"
check_eq "sharedPrefix=true stamped" "true" "$SHARED"
check_eq "challenger inheritedStages populated" '["plan","implementation"]' "$CH_INHERITED"
check_eq "primary inheritedStages empty" "[]" "$PR_INHERITED"

# Fork descriptor should also land on the primary's intent (both arms see the
# same fork).
PR_FORK_STAGE=$(jq -r '.forkStage' "$PRIMARY_FEATURE/.challenge-intent.json")
check_eq "forkStage stamped on primary intent too" "review" "$PR_FORK_STAGE"

# ────────────────────────────────────────────────────────────────
# Test 4: bounded-retry gate at ceiling terminalises to exhausted
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== materialise bounded retry ceiling ==="

RETRY_STATE="$TMP_ROOT/retry-state"
mkdir -p "$RETRY_STATE"
BUCKET="challenger-materialize-HOK-9999_c"
LIMIT=3
HEAD="deadbeef"

DISP=$(bounded_retry_gate "$RETRY_STATE" "$BUCKET" "$HEAD" "$LIMIT")
check_eq "first gate = proceed" "proceed" "$DISP"
bounded_retry_increment "$RETRY_STATE" "$BUCKET" "$HEAD" >/dev/null

# Force `due` via WAVEMILL_RETRY_BACKOFF_*_BASE=0 so we don't sleep in tests.
export WAVEMILL_RETRY_BACKOFF_BASE_SECONDS=0
DISP=$(bounded_retry_gate "$RETRY_STATE" "$BUCKET" "$HEAD" "$LIMIT")
check_eq "second gate after increment = proceed" "proceed" "$DISP"
bounded_retry_increment "$RETRY_STATE" "$BUCKET" "$HEAD" >/dev/null
bounded_retry_increment "$RETRY_STATE" "$BUCKET" "$HEAD" >/dev/null

DISP=$(bounded_retry_gate "$RETRY_STATE" "$BUCKET" "$HEAD" "$LIMIT")
check_eq "gate at ceiling = exhausted" "exhausted" "$DISP"

bounded_retry_mark_exhausted "$RETRY_STATE" "$BUCKET" "test ceiling reason" || true
if bounded_retry_is_exhausted "$RETRY_STATE" "$BUCKET"; then
  pass "sentinel written after exhaustion"
else
  fail "sentinel written after exhaustion"
fi
REASON=$(bounded_retry_exhaustion_reason "$RETRY_STATE" "$BUCKET")
check_contains "exhaustion reason is greppable" "$REASON" "ceiling"

# ────────────────────────────────────────────────────────────────
# Test 4b (HOK-2813): restart recovery + pre-fork collapse
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== HOK-2813 pending-arm restart and pre-fork collapse ==="

# A restart with an arm stuck in `materializing` resets it to awaiting_fork,
# preserving the rest of the record verbatim.
printf '%s\n' '{"session":"test","tasks":{"HOK-1234":{"slug":"foo","challenge":true,"challengeRole":"primary","challengePairId":"HOK-1234"}}}' > "$STATE_FILE"
challenge_arms_record_pending "HOK-1234" "$ARM_JSON"
challenge_arms_set_state "HOK-1234" "HOK-1234_c" "awaiting_fork" "materializing"
challenge_arms_recover_interrupted "HOK-1234"
RECOVERED_STATE=$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")
check_eq "recover_interrupted resets materializing → awaiting_fork" "awaiting_fork" "$RECOVERED_STATE"
RECOVERED_FROM=$(jq -r '.tasks["HOK-1234"].challengeArms[0].recoveredFrom' "$STATE_FILE")
check_eq "recover_interrupted stamps recoveredFrom" "materializing" "$RECOVERED_FROM"
RECOVERED_MODEL=$(jq -r '.tasks["HOK-1234"].challengeArms[0].models.reviewer' "$STATE_FILE")
check_eq "recover_interrupted preserves the arm record" "claude-haiku-4-5-20251001" "$RECOVERED_MODEL"
# Idempotent, and never touches an awaiting_fork/materialized arm.
challenge_arms_recover_interrupted "HOK-1234"
check_eq "recover_interrupted is idempotent" "awaiting_fork" "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"

# The rehydrate loop must only enumerate .tasks rows: a nested pending arm
# never becomes a slug/branch entry of its own.
REHYDRATE_ROWS=$(jq -r '.tasks | to_entries[]
  | select(((.value.lifecycle.workflowOutcome // "active") == "active") or
      ((.value.lifecycle.resourceDisposition // "") != "reaped"))
  | "\(.key)|\(.value.slug // "")|\(.value.branch // "")|\(.value.pr // "")"' "$STATE_FILE")
check_eq "rehydration enumerates only the primary" "1" "$(printf '%s\n' "$REHYDRATE_ROWS" | grep -c 'HOK-1234')"
check_contains "rehydration row is the primary, not the arm" "$REHYDRATE_ROWS" "HOK-1234|foo"
if printf '%s\n' "$REHYDRATE_ROWS" | grep -q '_c|'; then
  fail "pending arm does not rehydrate as a task"
else
  pass "pending arm does not rehydrate as a task"
fi

# Pre-fork primary failure collapses the challenge under the typed reason,
# keeping the free-text cause as detail and retaining the cancelled arm.
challenge_arms_cancel_pending "HOK-1234" "pre_fork_primary_failure" "quarantined coding: agent exited"
check_eq "typed cancelReason recorded on arm" "pre_fork_primary_failure" "$(jq -r '.tasks["HOK-1234"].challengeArms[0].cancelReason' "$STATE_FILE")"
check_eq "cancel detail carries the cause" "quarantined coding: agent exited" "$(jq -r '.tasks["HOK-1234"].challengeArms[0].cancelDetail' "$STATE_FILE")"
check_eq "collapse reason on primary is typed" "pre_fork_primary_failure" "$(jq -r '.tasks["HOK-1234"].challengeCollapseReason' "$STATE_FILE")"
check_eq "cancelled arm retained for audit" "cancelled" "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "pair selection cleared from primary" "false" "$(jq -r '.tasks["HOK-1234"].challenge' "$STATE_FILE")"
if jq -e '.tasks["HOK-1234_c"]' "$STATE_FILE" >/dev/null 2>&1; then
  fail "collapse never creates a challenger task"
else
  pass "collapse never creates a challenger task"
fi

# Source checks: the monitor wires the pieces at the right seams.
check_contains "rehydrate loop recovers interrupted arms" \
  "$(sed -n '/Rehydrate tracked tasks from persisted state/,/^fi$/p' "$MONITOR_SCRIPT_FILE")" \
  'challenge_arms_recover_interrupted "$ISSUE"'
CLEANUP_BLOCK=$(awk '/^cleanup_aborted_challenge_arm\(\) \{/{capture=1} capture{print} /^}/ && capture{exit}' "$MONITOR_SCRIPT_FILE")
check_contains "pre-fork cleanup cancels with typed reason" "$CLEANUP_BLOCK" 'challenge_arms_cancel_pending "$issue" "pre_fork_primary_failure" "$reason"'
PR_OPEN_BLOCK=$(awk '
  /PR open but not merged/ { capture=1 }
  capture && lines < 20 { print; lines++ }
  capture && lines >= 20 { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "PR-open tick re-enters the fork trigger" "$PR_OPEN_BLOCK" 'challenge_maybe_materialize_deferred_arms "$ISSUE"'

# Taxonomy: pre_fork_primary_failure is a registered no-comparison reason.
check_contains "NO_COMPARISON_REASONS carries pre_fork_primary_failure" \
  "$(grep -A 30 'NO_COMPARISON_REASONS = \[' "$REPO_DIR/shared/lib/challenge-comparison.ts")" \
  "'pre_fork_primary_failure'"
check_contains "eval-schema.json carries pre_fork_primary_failure" \
  "$(cat "$REPO_DIR/shared/lib/eval-schema.json")" \
  '"pre_fork_primary_failure"'

# ────────────────────────────────────────────────────────────────
# Test 4c (HOK-3065): awaiting_expanded_route planner-stage arms
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== HOK-3065 awaiting_expanded_route pending arm ==="

# A planner-stage arm is sealed at launch in awaiting_expanded_route, distinct
# from a reviewer arm's awaiting_fork. The 16th builder arg picks the state.
PLAN_ARM_JSON="$(challenge_arm_json_build \
  "HOK-1234_c" "foo-challenger" "task/foo-challenger" \
  "challenger" "plan" \
  "bootstrap-coder" "glm-5.2" "bootstrap-reviewer" \
  "claude" "native-openrouter" "claude" \
  "light" "medium" "static" \
  "" "awaiting_expanded_route")"
check_eq "planner arm starts in awaiting_expanded_route" "awaiting_expanded_route" \
  "$(echo "$PLAN_ARM_JSON" | jq -r '.challengeArmState')"
check_eq "planner arm records pendingState marker" "awaiting_expanded_route" \
  "$(echo "$PLAN_ARM_JSON" | jq -r '.pendingState')"
check_eq "planner arm keeps the sealed varied planner" "glm-5.2" \
  "$(echo "$PLAN_ARM_JSON" | jq -r '.models.planner')"

# An unrecognized state falls back to awaiting_fork rather than pinning junk.
BOGUS_STATE_ARM="$(challenge_arm_json_build \
  "HOK-1234_c" "foo-challenger" "task/foo-challenger" \
  "challenger" "plan" \
  "bootstrap-coder" "glm-5.2" "bootstrap-reviewer" \
  "claude" "native-openrouter" "claude" \
  "light" "medium" "static" \
  "" "not-a-state")"
check_eq "unrecognized pending state falls back to awaiting_fork" "awaiting_fork" \
  "$(echo "$BOGUS_STATE_ARM" | jq -r '.challengeArmState')"

printf '%s\n' '{"session":"test","tasks":{"HOK-1234":{"slug":"foo","challenge":true,"challengeRole":"primary","challengePairId":"HOK-1234"}}}' > "$STATE_FILE"
challenge_arms_record_pending "HOK-1234" "$PLAN_ARM_JSON"

# The reviewer-stage fork trigger must NOT see a planner arm.
check_eq "list_pending ignores awaiting_expanded_route arms" "0" \
  "$(challenge_arms_list_pending "HOK-1234" | jq -r 'length')"
check_eq "list_awaiting_expanded_route finds the planner arm" "1" \
  "$(challenge_arms_list_awaiting_expanded_route "HOK-1234" | jq -r 'length')"

# Restart recovery returns an interrupted planner arm to awaiting_expanded_route,
# not to the reviewer-stage awaiting_fork.
challenge_arms_set_state "HOK-1234" "HOK-1234_c" "awaiting_expanded_route" "materializing"
challenge_arms_recover_interrupted "HOK-1234"
check_eq "recover returns planner arm to awaiting_expanded_route" "awaiting_expanded_route" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "recover stamps recoveredTo origin" "awaiting_expanded_route" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].recoveredTo' "$STATE_FILE")"
# Restart recovery is exactly-once: a second pass leaves the arm untouched.
challenge_arms_recover_interrupted "HOK-1234"
check_eq "recover is idempotent for planner arms" "awaiting_expanded_route" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"

# Pre-materialization cancellation collapses a planner arm too.
challenge_arms_cancel_pending "HOK-1234" "pre_materialization_failure" "expanded route invalid"
check_eq "cancel collapses awaiting_expanded_route arm" "cancelled" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "cancel stamps typed reason on planner arm" "pre_materialization_failure" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].cancelReason' "$STATE_FILE")"
check_eq "cancel clears .challenge on primary for planner arm" "false" \
  "$(jq -r '.tasks["HOK-1234"].challenge' "$STATE_FILE")"
if jq -e '.tasks["HOK-1234_c"]' "$STATE_FILE" >/dev/null 2>&1; then
  fail "planner arm collapse never creates a challenger task"
else
  pass "planner arm collapse never creates a challenger task"
fi

# ────────────────────────────────────────────────────────────────
# Test 5: schema allows source=inherited on stage-result files
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== stage-result schema accepts source=inherited ==="
INHERIT_CHECK=$(jq -r '.properties.source.enum[0] // ""' "$REPO_DIR/shared/schemas/stage-result.schema.json")
check_eq "schema declares source.enum[0]=inherited" "inherited" "$INHERIT_CHECK"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
