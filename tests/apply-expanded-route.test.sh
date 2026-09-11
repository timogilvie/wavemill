#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source the shared helpers under test.
source "$REPO_DIR/shared/lib/wavemill-common.sh"

log() {
  local level="${1:-}" message="${2:-}"
  if [[ "$level" == "warn" ]]; then
    printf '%s\n' "$message" >&2
  else
    printf '%s\n' "$message"
  fi
}

log_warn() {
  printf '%s\n' "$*" >&2
}

agent_resolve_from_model() {
  local model="${1:-}"
  case "$model" in
    gpt-*|o*|codex*) printf 'codex\n' ;;
    claude-*) printf 'claude\n' ;;
    *) printf '\n' ;;
  esac
}

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

new_fixture() {
  local name="$1"
  local root
  root="$(mktemp -d "/tmp/${name}.XXXXXX")"
  local wt_dir="$root/worktree"
  local feature_dir="$wt_dir/features/test-slug"
  local state_file="$root/workflow-state.json"

  mkdir -p "$feature_dir"

  cat > "$feature_dir/.routing-complete" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "static",
  "reviewRecommended": "static",
  "provenance": {
    "source": "bootstrap"
  }
}
EOF

  cat > "$feature_dir/.phase-config.json" <<'EOF'
{
  "planning": {
    "model": "bootstrap-planner",
    "agent": "claude",
    "depth": "light"
  },
  "coding": {
    "model": "bootstrap-coder",
    "agent": "claude",
    "depth": "medium"
  },
  "review": {
    "model": "bootstrap-reviewer",
    "agent": "claude",
    "mode": "static"
  },
  "resolvedAt": "2026-05-01T00:00:00Z",
  "forceModel": null
}
EOF

  cat > "$state_file" <<EOF
{
  "tasks": {
    "HOK-1512": {
      "slug": "test-slug",
      "worktree": "$wt_dir",
      "phase": "planning",
      "plannerModel": "bootstrap-planner",
      "coderModel": "bootstrap-coder",
      "reviewerModel": "bootstrap-reviewer",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static"
    }
  }
}
EOF

  printf '%s\n%s\n%s\n' "$root" "$wt_dir" "$state_file"
}

run_apply() {
  local feature_dir="$1" state_file="$2"
  local issue="${3:-HOK-1512}"
  apply_expanded_route_if_present "$feature_dir" "$issue" "test-slug" "$(dirname "$(dirname "$feature_dir")")" "$state_file"
}

# Build a challenge intent with the production builder.
#
# Shell fixtures must never hand-write this object. Every argument is forwarded
# to tests/fixtures/build-challenge-intent.ts, which calls the same
# buildChallengeExecutionIntent the mill uses, so a schema change breaks these
# tests instead of silently diverging from them.
real_challenge_intent() {
  npx tsx "$REPO_DIR/tests/fixtures/build-challenge-intent.ts" "$@"
}

echo "=== Expanded Route Apply Helper ==="

{
  mapfile -t fixture < <(new_fixture "expanded-route-valid")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  rm -f "$feature_dir/.initial-route.json"
  cp "$feature_dir/.routing-complete" "$root/bootstrap-route.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewRecommended": "static+llm",
  "cache_hit": true,
  "route_source": "cache",
  "packet_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "provenance": {
    "inputHash": "abc123"
  }
}
EOF

  if run_apply "$feature_dir" "$state_file"; then
    if [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.codeDepth' "$feature_dir/.routing-complete")" == "deep" ]] \
      && [[ "$(jq -r '.reviewMode' "$feature_dir/.routing-complete")" == "static+llm" ]] \
      && [[ "$(jq -r '.coding.model' "$feature_dir/.phase-config.json")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.review.mode' "$feature_dir/.phase-config.json")" == "static+llm" ]] \
      && [[ "$(jq -r '.tasks["HOK-1512"].coderModel' "$state_file")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.tasks["HOK-1512"].reviewMode' "$state_file")" == "static+llm" ]] \
      && [[ "$(jq -r '.cache_hit' "$feature_dir/.routing-complete")" == "true" ]] \
      && [[ "$(jq -r '.route_source' "$feature_dir/.routing-complete")" == "cache" ]] \
      && [[ "$(jq -r '.packet_hash' "$feature_dir/.routing-complete")" == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]] \
      && [[ "$(jq -r '.provenance.source' "$feature_dir/.routing-complete")" == "expanded" ]] \
      && cmp -s "$feature_dir/.initial-route.json" "$root/bootstrap-route.json"; then
      pass "valid post-expansion route updates execution state and preserves bootstrap snapshot"
    else
      fail "valid post-expansion route did not update expected fields"
    fi
  else
    fail "valid post-expansion route should apply successfully"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-summary")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "claude-sonnet-5",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "medium",
  "reviewMode": "llm"
}
EOF
  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]] && grep -q '\[HOK-1512\] \[router\] planner=claude-sonnet-5' <<< "$output"; then
    pass "default mode emits concise single-line route summary"
  else
    fail "default mode should emit concise route summary"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-precedence")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"post-coder","codeDepth":"deep","reviewer":"post-reviewer","reviewMode":"llm"}
EOF
  cat > "$feature_dir/.expanded-route.json" <<'EOF'
{"coder":"fallback-coder","codeDepth":"light","reviewer":"fallback-reviewer","reviewMode":"static"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "post-coder" ]]; then
    pass ".post-expansion-route.json takes precedence over .expanded-route.json"
  else
    fail "expanded route precedence is incorrect"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-fallback")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.expanded-route.json" <<'EOF'
{"coder":"fallback-coder","codeDepth":"light","reviewer":"fallback-reviewer","reviewMode":"static"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "fallback-coder" ]]; then
    pass ".expanded-route.json applies when post-expansion route is absent"
  else
    fail "expanded-route fallback did not apply"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-missing")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cp "$feature_dir/.routing-complete" "$root/routing-before.json"
  cp "$feature_dir/.phase-config.json" "$root/phase-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"bad-coder","reviewMode":"llm"}
EOF

  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne 0 ]] \
    && grep -q 'expanded route invalid' <<< "$output" \
    && cmp -s "$feature_dir/.routing-complete" "$root/routing-before.json" \
    && cmp -s "$feature_dir/.phase-config.json" "$root/phase-before.json"; then
    pass "missing required fields fail closed without mutating execution state"
  else
    fail "missing-field expanded route did not fail closed"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-malformed")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cp "$feature_dir/.routing-complete" "$root/routing-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":
EOF

  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne 0 ]] \
    && grep -q 'expanded route invalid' <<< "$output" \
    && cmp -s "$feature_dir/.routing-complete" "$root/routing-before.json"; then
    pass "malformed JSON fails closed with warning"
  else
    fail "malformed expanded route did not fail closed"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-preserve-initial")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  printf '{"preserved":true}\n' > "$feature_dir/.initial-route.json"
  cp "$feature_dir/.initial-route.json" "$root/initial-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-5","reviewMode":"llm"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && cmp -s "$feature_dir/.initial-route.json" "$root/initial-before.json"; then
    pass "existing .initial-route.json remains unchanged"
  else
    fail "existing .initial-route.json was modified"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-idempotent")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-5","reviewRecommended":"llm"}
EOF

  if run_apply "$feature_dir" "$state_file"; then
    cp "$feature_dir/.phase-config.json" "$root/phase-after-first.json"
    cp "$feature_dir/.initial-route.json" "$root/initial-after-first.json"
    if run_apply "$feature_dir" "$state_file" \
      && cmp -s "$feature_dir/.phase-config.json" "$root/phase-after-first.json" \
      && cmp -s "$feature_dir/.initial-route.json" "$root/initial-after-first.json"; then
      pass "reapplying the same route is idempotent for phase config and initial route"
    else
      fail "reapplying the same route was not idempotent"
    fi
  else
    fail "initial idempotence apply should succeed"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-challenge-review-contract")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  # Legacy projection-schema intent, still produced by the contract builder.
  real_challenge_intent --stage review \
    --primary-reviewer bootstrap-reviewer \
    --challenger-reviewer glm-5.2 --challenger-reviewer-agent native-openrouter \
    > "$feature_dir/challenge-intent.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "gpt-5.5",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "llm"
}
EOF

  jq '.tasks["HOK-1512_c"] = (.tasks["HOK-1512"] + {challengePairId:"HOK-1512", challengeRole:"challenger"})' "$state_file" > "$root/state.tmp"
  mv "$root/state.tmp" "$state_file"

  if run_apply "$feature_dir" "$state_file" "HOK-1512_c" \
    && [[ "$(jq -r '.reviewer' "$feature_dir/.routing-complete")" == "glm-5.2" ]] \
    && [[ "$(jq -r '.review.model' "$feature_dir/.phase-config.json")" == "glm-5.2" ]] \
    && [[ "$(jq -r '.tasks["HOK-1512_c"].reviewerModel' "$state_file")" == "glm-5.2" ]] \
    && [[ "$(jq -r '.challengeIntentApplied' "$feature_dir/.routing-complete")" == "true" ]] \
    && [[ "$(jq -r '.rawExpandedRoute.reviewer' "$feature_dir/.routing-complete")" == "gpt-5.5" ]]; then
    pass "challenger review intent survives expanded route overwrite"
  else
    fail "challenger review intent was not preserved during expanded route promotion"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-execution-intent-fallback")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"

  # Model the runtime state after a launch that persisted only the canonical
  # execution intent.  There is deliberately no feature-local intent file and
  # no legacy challengeIntent field.
  #
  # The intent is generated by the production builder, never hand-written: the
  # original version of this fixture was authored from an assumption about the
  # schema and passed while production silently discarded the arm.
  intent="$(real_challenge_intent --stage review \
    --primary-reviewer bootstrap-reviewer \
    --challenger-reviewer qwen-3-coder --challenger-reviewer-agent native-openrouter)"
  jq --argjson intent "$intent" '.tasks["HOK-1512_c"] = (.tasks["HOK-1512"] + {
    challengePairId: "HOK-1512",
    challengeRole: "challenger",
    challengeExecutionIntent: $intent
  })' "$state_file" > "$root/state.tmp"
  mv "$root/state.tmp" "$state_file"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "gpt-5.5",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "llm"
}
EOF

  if run_apply "$feature_dir" "$state_file" "HOK-1512_c" \
    && [[ "$(jq -r '.reviewer' "$feature_dir/.routing-complete")" == "qwen-3-coder" ]] \
    && [[ "$(jq -r '.review.model' "$feature_dir/.phase-config.json")" == "qwen-3-coder" ]] \
    && [[ "$(jq -r '.tasks["HOK-1512_c"].reviewerModel' "$state_file")" == "qwen-3-coder" ]] \
    && [[ "$(jq -r '.challengeIntentApplied' "$feature_dir/.routing-complete")" == "true" ]]; then
    pass "canonical execution intent preserves a Qwen reviewer through rerouting"
  else
    fail "canonical execution intent did not preserve the Qwen reviewer"
  fi
  rm -rf "$root"
}

{
  # The envelope schema actually emitted by challenge-mode.ts
  # buildChallengeExecutionIntent: selectedStage (not challengeStage) and sides
  # of {key, role, planner|coder|reviewer: {model, agent}} with NO expectedRoute.
  # This is what persist_challenge_execution_intent writes to disk, so it is the
  # shape the merge sees in production.
  mapfile -t fixture < <(new_fixture "expanded-route-envelope-intent")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"

  cat > "$feature_dir/.challenge-intent.json" <<'EOF'
{
  "schemaVersion": 1,
  "pairId": "HOK-1512",
  "issueId": "HOK-1512",
  "createdAt": "2026-08-11T17:58:58.334Z",
  "decisionSource": "bootstrap",
  "selectedStage": "review",
  "selectionPath": "random-roll",
  "primary": {
    "key": "HOK-1512",
    "role": "primary",
    "planner":  {"model": "bootstrap-planner", "agent": "claude"},
    "coder":    {"model": "bootstrap-coder",   "agent": "claude"},
    "reviewer": {"model": "gpt-5.6-terra",     "agent": "codex"}
  },
  "challenger": {
    "key": "HOK-1512_c",
    "role": "challenger",
    "planner":  {"model": "bootstrap-planner", "agent": "claude"},
    "coder":    {"model": "bootstrap-coder",   "agent": "claude"},
    "reviewer": {"model": "kimi-k2", "agent": "native-openrouter"}
  }
}
EOF

  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "claude-opus-4-7",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "llm"
}
EOF

  if run_apply "$feature_dir" "$state_file" "HOK-1512" \
    && [[ "$(jq -r '.reviewer' "$feature_dir/.routing-complete")" == "gpt-5.6-terra" ]] \
    && [[ "$(jq -r '.intendedStage' "$feature_dir/.routing-complete")" == "review" ]] \
    && [[ "$(jq -r '.challengeIntentApplied' "$feature_dir/.routing-complete")" == "true" ]] \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "bootstrap-coder" ]]; then
    pass "envelope-schema intent preserves the primary's varied reviewer"
  else
    fail "envelope-schema intent did not preserve the primary's varied reviewer"
  fi
  rm -rf "$root"
}

{
  # Same envelope schema, challenger side, varying the coder. Guards the case
  # the mill was actually losing: an open-weight coder replaced by the
  # expanded route's incumbent.
  mapfile -t fixture < <(new_fixture "expanded-route-envelope-coder")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"

  jq '.tasks["HOK-1512_c"] = (.tasks["HOK-1512"] + {
    challengePairId: "HOK-1512",
    challengeRole: "challenger",
    challengeExecutionIntent: {
      schemaVersion: 1,
      pairId: "HOK-1512",
      issueId: "HOK-1512",
      selectedStage: "implementation",
      primary: {
        key: "HOK-1512", role: "primary",
        planner:  {model: "bootstrap-planner", agent: "claude"},
        coder:    {model: "gpt-5.5",           agent: "codex"},
        reviewer: {model: "bootstrap-reviewer", agent: "claude"}
      },
      challenger: {
        key: "HOK-1512_c", role: "challenger",
        planner:  {model: "bootstrap-planner", agent: "claude"},
        coder:    {model: "qwen-2.5-coder-32b", agent: "native-openrouter"},
        reviewer: {model: "bootstrap-reviewer", agent: "claude"}
      }
    }
  })' "$state_file" > "$root/state.tmp"
  mv "$root/state.tmp" "$state_file"

  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "gpt-5.5",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "deep",
  "reviewMode": "llm"
}
EOF

  if run_apply "$feature_dir" "$state_file" "HOK-1512_c" \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "qwen-2.5-coder-32b" ]] \
    && [[ "$(jq -r '.coding.model' "$feature_dir/.phase-config.json")" == "qwen-2.5-coder-32b" ]] \
    && [[ "$(jq -r '.tasks["HOK-1512_c"].coderModel' "$state_file")" == "qwen-2.5-coder-32b" ]] \
    && [[ "$(jq -r '.challengeIntentApplied' "$feature_dir/.routing-complete")" == "true" ]]; then
    pass "envelope-schema intent preserves a Qwen coder through rerouting"
  else
    fail "envelope-schema intent did not preserve the Qwen coder"
  fi
  rm -rf "$root"
}

{
  # An intent the merge cannot read must fail loudly, not stamp a success.
  mapfile -t fixture < <(new_fixture "expanded-route-unreadable-intent")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"

  cat > "$feature_dir/.challenge-intent.json" <<'EOF'
{
  "pairId": "HOK-1512",
  "primary": {"role": "primary"},
  "challenger": {"role": "challenger"}
}
EOF

  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.5",
  "reviewer": "claude-opus-4-7",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "llm"
}
EOF

  if run_apply "$feature_dir" "$state_file" "HOK-1512" 2>/dev/null \
    && [[ "$(jq -r '.challengeIntentApplied // "unset"' "$feature_dir/.routing-complete")" == "unset" ]]; then
    pass "unreadable intent is not reported as applied"
  else
    fail "unreadable intent was reported as applied"
  fi
  rm -rf "$root"
}

{
  # Rerouting must not author the selection record.
  mapfile -t fixture < <(new_fixture "expanded-route-intent-readonly")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"

  jq '.tasks["HOK-1512"].challengeIntent = {
    pairId: "HOK-1512",
    challengeStage: "review",
    primary: {
      pairId: "HOK-1512", side: "primary", challengeStage: "review",
      expectedStageModel: "gpt-5.6-terra",
      expectedRoute: {planner: "bootstrap-planner", coder: "bootstrap-coder", reviewer: "gpt-5.6-terra", planDepth: "light", codeDepth: "medium", reviewMode: "llm"}
    },
    challenger: {
      pairId: "HOK-1512", side: "challenger", challengeStage: "review",
      expectedStageModel: "kimi-k2",
      expectedRoute: {planner: "bootstrap-planner", coder: "bootstrap-coder", reviewer: "kimi-k2", planDepth: "light", codeDepth: "medium", reviewMode: "llm"}
    }
  }' "$state_file" > "$root/state.tmp"
  mv "$root/state.tmp" "$state_file"
  before="$(jq -cS '.tasks["HOK-1512"].challengeIntent' "$state_file")"

  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "claude-opus-4-7",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "llm"
}
EOF

  after=""
  if run_apply "$feature_dir" "$state_file" "HOK-1512"; then
    after="$(jq -cS '.tasks["HOK-1512"].challengeIntent' "$state_file")"
  fi
  if [[ -n "$after" && "$before" == "$after" ]] \
    && [[ "$(jq -r '.reviewer' "$feature_dir/.routing-complete")" == "gpt-5.6-terra" ]]; then
    pass "rerouting consumes the challenge intent without rewriting it"
  else
    fail "rerouting mutated the persisted challenge intent"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-summary-signals")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "claude-sonnet-5",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-5",
  "planDepth": "deep",
  "codeDepth": "medium",
  "reviewMode": "llm",
  "signals": {
    "taskType": "feature",
    "complexityScore": 5,
    "complexityBand": "xl",
    "riskFlags": ["greenfield", "large-scope-refactor"]
  }
}
EOF
  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]] \
    && grep -q 'taskType=feature' <<< "$output" \
    && grep -q 'complexity=5' <<< "$output" \
    && grep -q 'riskFlags=greenfield|large-scope-refactor' <<< "$output"; then
    pass "route summary includes signal vector"
  else
    fail "route summary should include signal vector"
  fi
  rm -rf "$root"
}

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
