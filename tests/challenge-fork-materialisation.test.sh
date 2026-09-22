#!/usr/bin/env bash
# HOK-2814: fork materialisation end-to-end coverage.
#
# Drives the reviewer-fork materialisation sequence end-to-end against a
# scratch git repo so the tests observe what actually lands on disk after the
# materialiser: a challenger worktree branched from the fork commit, inherited
# stage artifacts stamped source=inherited, the .wavemill-config.local.json
# overlay carried across when present, and .review-result.json NOT copied.
#
# The core materialisation function `challenge_materialize_challenger_arm` is
# too large to source in isolation, so this test extracts the helpers that ARE
# safely callable (`challenge_arm_json_build`, `challenge_arms_record_pending`,
# `challenge_arms_set_state`, `challenge_intent_stamp_fork_descriptor`) and
# replays the on-disk steps the materialiser drives (git worktree add, the
# artifact copy loop with its exclusions, the source=inherited stamp, and the
# .wavemill-config.local.json overlay). This mirrors the pattern established
# by challenge-deferred-arm.test.sh Test 3; here we add the sub-scenarios that
# test the branch-tolerance and mismatched-branch fail-closed branches of the
# real function.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
ARMS_SCRIPT="$REPO_DIR_ROOT/shared/lib/challenge-arms.sh"

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

extract_function() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MONITOR_SCRIPT_FILE"
}

# state_mutate stub must exist BEFORE sourcing challenge-arms.sh (late binding).
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

# shellcheck source=../shared/lib/challenge-arms.sh
source "$ARMS_SCRIPT"

log_route_lifecycle() { :; }
log() { :; }
log_warn() { :; }
log_error() { :; }

# Pull the fork-descriptor helper into this scope (already unit-tested in
# challenge-deferred-arm.test.sh; we call it here after the copy loop).
eval "$(extract_function challenge_intent_stamp_fork_descriptor)"

# The materialiser's copy loop is a straightforward for-loop over a fixed
# artifact list; encoding it here mirrors what the real function does so
# regressions in the exclusion list light up.
copy_primary_feature_dir() {
  local primary_feature_dir="$1" challenger_feature_dir="$2"
  local artifact
  mkdir -p "$challenger_feature_dir"
  for artifact in \
    plan.md .plan-approved .phase-config.json \
    .routing-complete .initial-route.json .post-expansion-route.json \
    selected-task.json \
    task-packet.md task-packet-header.md task-packet-details.md \
    challenge-intent.json .challenge-intent.json \
    .trace-context.json trace.jsonl routing.jsonl \
    .planning-result.json .coding-result.json .coding-complete; do
    if [[ -e "$primary_feature_dir/$artifact" ]]; then
      cp -R "$primary_feature_dir/$artifact" "$challenger_feature_dir/$artifact" 2>/dev/null || true
    fi
  done
  # Stamp source=inherited on the copied stage-result files.
  local stage_file tmp
  for stage_file in .planning-result.json .coding-result.json; do
    [[ -f "$challenger_feature_dir/$stage_file" ]] || continue
    tmp="$(mktemp)" || continue
    jq '.source = "inherited"' "$challenger_feature_dir/$stage_file" > "$tmp"
    mv "$tmp" "$challenger_feature_dir/$stage_file"
  done
}

TMP_ROOT="$(mktemp -d "/tmp/challenge-fork-materialisation.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

seed_scratch_repo() {
  local repo="$1"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  echo initial > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m 'initial'
  git -C "$repo" checkout -q -b task/foo
  echo more >> "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m 'primary coding work'
}

seed_primary_feature_dir() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/plan.md" <<'PLAN'
Primary plan
PLAN
  touch "$dir/.plan-approved" "$dir/.coding-complete"
  cat > "$dir/.planning-result.json" <<'JSON'
{"stage":"planning","status":"completed","model":"claude-sonnet-5","agent":"claude"}
JSON
  cat > "$dir/.coding-result.json" <<'JSON'
{"stage":"coding","status":"completed","model":"claude-opus-4-7","agent":"claude"}
JSON
  cat > "$dir/.challenge-intent.json" <<'JSON'
{"schemaVersion":1,"pairId":"HOK-1234","issueId":"HOK-1234","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-1234","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-1234","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}},"forkStage":null,"forkCommit":null,"sharedPrefix":false}
JSON
  cp "$dir/.challenge-intent.json" "$dir/challenge-intent.json"
}

# ────────────────────────────────────────────────────────────────
# Scenario 1: happy path — fork commit, branch, worktree, inherited artifacts,
# challenger state entry, primary challengerLaunched=true.
# ────────────────────────────────────────────────────────────────
echo "=== fork materialisation happy path ==="

SCENARIO=1
SCRATCH_REPO="$TMP_ROOT/repo$SCENARIO"
WORKTREE_ROOT="$TMP_ROOT/worktrees$SCENARIO"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
seed_scratch_repo "$SCRATCH_REPO"
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

# .wavemill-config.local.json exists in the primary — assert it copies across.
printf '{"local":true}\n' > "$SCRATCH_REPO/.wavemill-config.local.json"

PRIMARY_FEATURE="$SCRATCH_REPO/features/foo"
seed_primary_feature_dir "$PRIMARY_FEATURE"

# Simulate a materialisation-after-review guard: primary already has a review
# artifact. The real materialiser refuses in this case (returns non-zero); we
# assert here that our test-side copy loop does not carry it across even if we
# ignore the guard (belt-and-braces regression).
cat > "$PRIMARY_FEATURE/.review-result.json" <<'JSON'
{"stage":"review","status":"completed","model":"claude-opus-4-7","agent":"claude"}
JSON

STATE_FILE="$TMP_ROOT/state$SCENARIO.json"
export STATE_FILE
printf '%s\n' '{"session":"test","tasks":{"HOK-1234":{"slug":"foo","branch":"task/foo","challenge":true,"challengeRole":"primary","challengePairId":"HOK-1234"}}}' > "$STATE_FILE"

CANONICAL_INTENT='{"schemaVersion":1,"pairId":"HOK-1234","issueId":"HOK-1234","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-1234","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-1234","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}}}'
ARM_JSON="$(challenge_arm_json_build \
  "HOK-1234_c" "foo-c" "task/foo-c" \
  "challenger" "review" \
  "claude-opus-4-7" "claude-sonnet-5" "claude-haiku-4-5-20251001" \
  "claude" "claude" "claude" \
  "light" "medium" "static" \
  "$CANONICAL_INTENT")"

challenge_arms_record_pending "HOK-1234" "$ARM_JSON"
challenge_arm_key=$(echo "$ARM_JSON" | jq -r '.key')
challenge_arm_slug=$(echo "$ARM_JSON" | jq -r '.slug')
challenge_arm_branch=$(echo "$ARM_JSON" | jq -r '.branch')

# Step 1: exactly-once claim → materializing.
if ! challenge_arms_set_state "HOK-1234" "$challenge_arm_key" "awaiting_fork" "materializing"; then
  fail "claim awaiting_fork → materializing"
  exit 1
fi
pass "claim awaiting_fork → materializing"

# Step 2: `git worktree add -b task/foo-c $wt_dir $fork_commit` — same call
# the real materialiser makes when neither branch nor worktree exist yet.
CHALLENGER_WT_DIR="$WORKTREE_ROOT/$challenge_arm_slug"
CHALLENGER_FEATURE="$CHALLENGER_WT_DIR/features/$challenge_arm_slug"

git -C "$SCRATCH_REPO" worktree add -b "$challenge_arm_branch" "$CHALLENGER_WT_DIR" "$FORK_COMMIT" >/dev/null 2>&1
if [[ -d "$CHALLENGER_WT_DIR" ]] && [[ "$(git -C "$CHALLENGER_WT_DIR" rev-parse HEAD)" == "$FORK_COMMIT" ]]; then
  pass "challenger worktree HEAD == fork commit"
else
  fail "challenger worktree HEAD != fork commit"
fi

if [[ "$(git -C "$SCRATCH_REPO" rev-parse "$challenge_arm_branch" 2>/dev/null)" == "$FORK_COMMIT" ]]; then
  pass "challenger branch $challenge_arm_branch points at fork commit"
else
  fail "challenger branch $challenge_arm_branch does not point at fork commit"
fi

# Step 2b: overlay copy — mirror what the real materialiser does.
if [[ -f "$SCRATCH_REPO/.wavemill-config.local.json" ]]; then
  cp "$SCRATCH_REPO/.wavemill-config.local.json" "$CHALLENGER_WT_DIR/.wavemill-config.local.json"
fi
if [[ -f "$CHALLENGER_WT_DIR/.wavemill-config.local.json" ]]; then
  pass ".wavemill-config.local.json overlay carried to challenger worktree"
else
  fail ".wavemill-config.local.json overlay not carried to challenger worktree"
fi

# Step 3: artifact copy loop (excluding .review-result.json by omission).
copy_primary_feature_dir "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE"

for f in plan.md .plan-approved .planning-result.json .coding-result.json .coding-complete challenge-intent.json .challenge-intent.json; do
  if [[ -e "$CHALLENGER_FEATURE/$f" ]]; then
    pass "inherited artifact: $f"
  else
    fail "inherited artifact missing: $f"
  fi
done

if [[ ! -f "$CHALLENGER_FEATURE/.review-result.json" ]]; then
  pass ".review-result.json is NOT inherited (excluded by materialiser)"
else
  fail ".review-result.json was incorrectly inherited"
fi

INHERIT_PLAN=$(jq -r '.source' "$CHALLENGER_FEATURE/.planning-result.json")
INHERIT_CODE=$(jq -r '.source' "$CHALLENGER_FEATURE/.coding-result.json")
check_eq ".planning-result.json source=inherited stamp" "inherited" "$INHERIT_PLAN"
check_eq ".coding-result.json source=inherited stamp" "inherited" "$INHERIT_CODE"

# Step 5: fork-descriptor stamp on both intent files.
challenge_intent_stamp_fork_descriptor \
  "HOK-1234" "$challenge_arm_key" \
  "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE" \
  "review" "$FORK_COMMIT" \
  '["plan","implementation"]'

for dir in "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE"; do
  fs=$(jq -r '.forkStage' "$dir/.challenge-intent.json")
  fc=$(jq -r '.forkCommit' "$dir/.challenge-intent.json")
  sp=$(jq -r '.sharedPrefix' "$dir/.challenge-intent.json")
  [[ "$fs" == "review" && "$fc" == "$FORK_COMMIT" && "$sp" == "true" ]] \
    && pass "fork descriptor on $(basename "$dir")" \
    || fail "fork descriptor on $(basename "$dir") ($fs / $fc / $sp)"
done

CH_INHERITED=$(jq -c '.challenger.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")
PR_INHERITED=$(jq -c '.primary.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")
check_eq "challenger inheritedStages populated" '["plan","implementation"]' "$CH_INHERITED"
check_eq "primary inheritedStages empty" "[]" "$PR_INHERITED"

# Step 7 (test-side): the real materialiser calls save_task_state; here we
# apply the state changes it would produce directly, mirroring the writes it
# performs, and assert the expected shape lands.
state_mutate "$STATE_FILE" \
  '.tasks[$challenger] = {
      slug: $slug, branch: $branch, worktree: $wt,
      challenge: true, challengePairId: $issue,
      challengeRole: "challenger", challengeStage: "review",
      plannerModel: $planner, coderModel: $coder, reviewerModel: $reviewer,
      phase: "review"
    }
    | .tasks[$issue].challengerLaunched = true
    | .tasks[$issue].updated = (now | todate)' \
  --arg issue "HOK-1234" \
  --arg challenger "$challenge_arm_key" \
  --arg slug "$challenge_arm_slug" \
  --arg branch "$challenge_arm_branch" \
  --arg wt "$CHALLENGER_WT_DIR" \
  --arg planner "claude-sonnet-5" \
  --arg coder "claude-opus-4-7" \
  --arg reviewer "claude-haiku-4-5-20251001"

check_eq "challenger state entry role" "challenger" "$(jq -r '.tasks["HOK-1234_c"].challengeRole' "$STATE_FILE")"
check_eq "challenger state entry phase" "review" "$(jq -r '.tasks["HOK-1234_c"].phase' "$STATE_FILE")"
check_eq "challenger state entry challengeStage" "review" "$(jq -r '.tasks["HOK-1234_c"].challengeStage' "$STATE_FILE")"
check_eq "challenger state entry plannerModel" "claude-sonnet-5" "$(jq -r '.tasks["HOK-1234_c"].plannerModel' "$STATE_FILE")"
check_eq "challenger state entry coderModel" "claude-opus-4-7" "$(jq -r '.tasks["HOK-1234_c"].coderModel' "$STATE_FILE")"
check_eq "challenger state entry reviewerModel" "claude-haiku-4-5-20251001" "$(jq -r '.tasks["HOK-1234_c"].reviewerModel' "$STATE_FILE")"
check_eq "primary challengerLaunched=true" "true" "$(jq -r '.tasks["HOK-1234"].challengerLaunched' "$STATE_FILE")"

# Step 8 (state-side): flip the arm to materialized after the fork completes.
challenge_arms_set_state "HOK-1234" "$challenge_arm_key" "materializing" "materialized" \
  "$(jq -cn --arg fc "$FORK_COMMIT" '{materializedAt: (now | todate), forkCommit: $fc}')"
check_eq "arm state after materialization" "materialized" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].challengeArmState' "$STATE_FILE")"
check_eq "arm forkCommit stamped" "$FORK_COMMIT" \
  "$(jq -r '.tasks["HOK-1234"].challengeArms[0].forkCommit' "$STATE_FILE")"

# ────────────────────────────────────────────────────────────────
# Scenario 2: overlay absent — the challenger does NOT get a
# .wavemill-config.local.json (regression guard).
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== fork materialisation without overlay ==="

SCENARIO=2
SCRATCH_REPO="$TMP_ROOT/repo$SCENARIO"
WORKTREE_ROOT="$TMP_ROOT/worktrees$SCENARIO"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
seed_scratch_repo "$SCRATCH_REPO"
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"
PRIMARY_FEATURE="$SCRATCH_REPO/features/foo"
seed_primary_feature_dir "$PRIMARY_FEATURE"

CHALLENGER_WT_DIR="$WORKTREE_ROOT/foo-c"
git -C "$SCRATCH_REPO" worktree add -b task/foo-c "$CHALLENGER_WT_DIR" "$FORK_COMMIT" >/dev/null 2>&1

if [[ -f "$SCRATCH_REPO/.wavemill-config.local.json" ]]; then
  cp "$SCRATCH_REPO/.wavemill-config.local.json" "$CHALLENGER_WT_DIR/.wavemill-config.local.json"
fi

if [[ ! -f "$CHALLENGER_WT_DIR/.wavemill-config.local.json" ]]; then
  pass "no overlay in primary → no overlay in challenger"
else
  fail "overlay leaked into challenger despite absent primary overlay"
fi

# ────────────────────────────────────────────────────────────────
# Scenario 3: partial prior attempt — branch already exists at the fork
# commit but the worktree directory is missing. Materialiser must attach
# via ensure_worktree, not error.
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== fork materialisation attaches to pre-existing branch at fork commit ==="

SCENARIO=3
SCRATCH_REPO="$TMP_ROOT/repo$SCENARIO"
WORKTREE_ROOT="$TMP_ROOT/worktrees$SCENARIO"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
seed_scratch_repo "$SCRATCH_REPO"
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

# Simulate a prior partial attempt: branch was created but the worktree wasn't.
git -C "$SCRATCH_REPO" branch task/foo-c "$FORK_COMMIT" >/dev/null

# The materialiser's tolerance branch is: `if show-ref refs/heads/$branch AND
# existing_sha == fork_commit AND !dir -d $wt`, then attach via ensure_worktree.
# We replay that with a plain `git worktree add` (attach existing branch — no
# -b) which mirrors ensure_worktree's happy-path behaviour.
CHALLENGER_WT_DIR="$WORKTREE_ROOT/foo-c"
if git -C "$SCRATCH_REPO" show-ref --verify --quiet "refs/heads/task/foo-c"; then
  existing_sha="$(git -C "$SCRATCH_REPO" rev-parse task/foo-c)"
  if [[ "$existing_sha" == "$FORK_COMMIT" && ! -d "$CHALLENGER_WT_DIR" ]]; then
    git -C "$SCRATCH_REPO" worktree add "$CHALLENGER_WT_DIR" task/foo-c >/dev/null 2>&1
  fi
fi

if [[ -d "$CHALLENGER_WT_DIR" ]] && [[ "$(git -C "$CHALLENGER_WT_DIR" rev-parse HEAD)" == "$FORK_COMMIT" ]]; then
  pass "attach to pre-existing branch at fork commit succeeds"
else
  fail "attach to pre-existing branch at fork commit failed"
fi

# Assert the tolerance path DID NOT try to create a new branch (which would
# have failed) — checked by grepping the real materialiser for the guard.
if grep -q 'if git -C "\$REPO_DIR" show-ref --verify --quiet "refs/heads/\$arm_branch"' "$MONITOR_SCRIPT_FILE" \
  && grep -q 'ensure_worktree "\$arm_branch" "\$challenger_wt_dir"' "$MONITOR_SCRIPT_FILE"; then
  pass "materialiser source has branch-tolerance ensure_worktree branch"
else
  fail "materialiser source is missing the branch-tolerance branch"
fi

# ────────────────────────────────────────────────────────────────
# Scenario 4: mismatched pre-existing branch — the branch exists at a
# DIFFERENT commit than the fork commit. Materialiser must fail closed and
# not create a worktree.
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== fork materialisation refuses mismatched pre-existing branch ==="

SCENARIO=4
SCRATCH_REPO="$TMP_ROOT/repo$SCENARIO"
WORKTREE_ROOT="$TMP_ROOT/worktrees$SCENARIO"
mkdir -p "$SCRATCH_REPO" "$WORKTREE_ROOT"
seed_scratch_repo "$SCRATCH_REPO"
FORK_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

# Add a fresh commit on main so we have a different sha to peg the stale
# branch to.
git -C "$SCRATCH_REPO" checkout -q main
echo other > "$SCRATCH_REPO/OTHER.md"
git -C "$SCRATCH_REPO" add OTHER.md
git -C "$SCRATCH_REPO" commit -q -m 'unrelated'
OTHER_COMMIT="$(git -C "$SCRATCH_REPO" rev-parse HEAD)"

# Pre-existing branch at the wrong sha (typical operator artefact from an
# aborted previous attempt).
git -C "$SCRATCH_REPO" branch task/foo-c "$OTHER_COMMIT" >/dev/null

# The materialiser's guard: if the branch exists at a non-fork commit, error
# and do NOT create the worktree.
CHALLENGER_WT_DIR="$WORKTREE_ROOT/foo-c"
materialiser_would_refuse="false"
if git -C "$SCRATCH_REPO" show-ref --verify --quiet "refs/heads/task/foo-c"; then
  existing_sha="$(git -C "$SCRATCH_REPO" rev-parse task/foo-c)"
  if [[ "$existing_sha" != "$FORK_COMMIT" ]]; then
    materialiser_would_refuse="true"
  fi
fi

if [[ "$materialiser_would_refuse" == "true" && ! -d "$CHALLENGER_WT_DIR" ]]; then
  pass "materialiser refuses mismatched branch and creates no worktree"
else
  fail "materialiser should refuse mismatched branch (worktree=$([ -d "$CHALLENGER_WT_DIR" ] && echo present || echo absent))"
fi

# Source-side guard: the real function does return 1 in this branch.
GUARD_BLOCK=$(awk '
  /if git -C "\$REPO_DIR" show-ref --verify --quiet "refs\/heads\/\$arm_branch"/ { capture=1 }
  capture { print }
  /^  else$/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")
check_contains "materialiser source refuses on branch/fork sha mismatch" "$GUARD_BLOCK" 'branch $arm_branch already exists at $existing_sha, not at fork commit $fork_commit'

# ────────────────────────────────────────────────────────────────
# Guard: the artifact-copy list in the source stays in lockstep with the
# list this test replays. If a new artifact is added to the materialiser
# without being added here, the exclusion assertions above become stale.
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== copy-list source parity ==="

MATERIALIZE_BLOCK=$(awk '
  /^challenge_materialize_challenger_arm\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")

for expected in \
  "plan.md" ".plan-approved" ".phase-config.json" \
  ".routing-complete" ".initial-route.json" ".post-expansion-route.json" \
  "selected-task.json" \
  "task-packet.md" "task-packet-header.md" "task-packet-details.md" \
  "challenge-intent.json" ".challenge-intent.json" \
  ".trace-context.json" "trace.jsonl" "routing.jsonl" \
  ".planning-result.json" ".coding-result.json" ".coding-complete"; do
  if grep -qF "$expected" <<< "$MATERIALIZE_BLOCK"; then
    pass "materialiser copies $expected"
  else
    fail "materialiser no longer copies $expected — update this test's copy loop"
  fi
done

# The most important non-inheritance guarantee is .review-result.json — a
# challenger must never inherit the primary's review. Isolate the artifact
# copy loop and assert .review-result.json is not one of its entries; the
# guard block that refuses to materialise if a review artifact already
# exists on the challenger side is expected to mention the filename.
COPY_LOOP=$(awk '
  /^  for artifact in \\/ { capture=1 }
  capture { print }
  /^  do$/ && capture { exit }
' <<< "$MATERIALIZE_BLOCK")
if [[ -n "$COPY_LOOP" ]] && ! grep -qF ".review-result.json" <<< "$COPY_LOOP"; then
  pass "materialiser copy loop does NOT include .review-result.json"
else
  fail "materialiser copy loop now includes .review-result.json"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
