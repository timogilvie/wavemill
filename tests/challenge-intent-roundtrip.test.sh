#!/usr/bin/env bash
# Producer/consumer round-trip for the challenge intent.
#
# The bug this suite exists for lived exactly in the seam between two files:
# persist_challenge_execution_intent (wavemill-mill.sh) WROTE the intent, and
# apply_expanded_route_if_present (wavemill-common.sh) READ it — and they
# disagreed about the schema. Each had its own passing tests. Nothing exercised
# the pair together, so the disagreement survived three separate fixes.
#
# Every case here writes with the real producer and reads with the real
# consumer, for every stage and both sides.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

source "$REPO_DIR/shared/lib/wavemill-common.sh"

log() {
  local level="${1:-}" message="${2:-}"
  if [[ "$level" == "warn" ]]; then
    printf '%s\n' "$message" >&2
  else
    printf '%s\n' "$message"
  fi
}
log_warn() { printf '%s\n' "$*" >&2; }
log_error() { printf 'ERROR %s\n' "$*" >&2; }

agent_resolve_from_model() {
  case "${1:-}" in
    gpt-*|o[0-9]*|codex*) printf 'codex\n' ;;
    claude-*) printf 'claude\n' ;;
    kimi-*|qwen-*|glm-*|devstral-*|llama-*|mistral-*) printf 'native-openrouter\n' ;;
    *) printf '\n' ;;
  esac
}

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Load the real producer out of wavemill-mill.sh. Sourcing the whole mill would
# start a session, so extract just the function under test — the same technique
# tests/wavemill-mill-challenge.test.sh uses.
eval "$(awk '
  /^persist_challenge_execution_intent\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MONITOR_SCRIPT_FILE")"

if ! declare -F persist_challenge_execution_intent >/dev/null 2>&1; then
  echo "  FAIL  could not load persist_challenge_execution_intent from the mill" >&2
  exit 1
fi

read_state_value() {
  local fallback="$1"; shift
  local value
  value="$(jq -r "$@" "$STATE_FILE" 2>/dev/null || true)"
  [[ -n "$value" && "$value" != "null" ]] && printf '%s' "$value" || printf '%s' "$fallback"
}

real_challenge_intent() {
  npx tsx "$REPO_DIR/tests/fixtures/build-challenge-intent.ts" "$@"
}

# Build a worktree pair, run the real producer, then the real consumer.
# Echoes the root dir so the caller can inspect and clean up.
roundtrip() {
  local stage="$1" side="$2" primary_model="$3" challenger_model="$4" expanded_model="$5"
  local root wt_dir feature_dir issue slug
  root="$(mktemp -d "/tmp/challenge-roundtrip.XXXXXX")"

  if [[ "$side" == "challenger" ]]; then
    issue="HOK-900_c"; slug="pair-slug-challenger"
  else
    issue="HOK-900"; slug="pair-slug"
  fi
  wt_dir="$root/$slug"
  feature_dir="$wt_dir/features/$slug"
  mkdir -p "$feature_dir"

  STATE_FILE="$root/workflow-state.json"
  cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-900":{"slug":"pair-slug","worktree":"$root/pair-slug","phase":"planning"},
          "HOK-900_c":{"slug":"pair-slug-challenger","worktree":"$root/pair-slug-challenger","phase":"planning"}}}
JSON

  cat > "$feature_dir/.routing-complete" <<'JSON'
{"planner":"bootstrap-planner","coder":"bootstrap-coder","reviewer":"bootstrap-reviewer",
 "planDepth":"light","codeDepth":"medium","reviewMode":"llm","reviewRecommended":"llm",
 "provenance":{"source":"bootstrap"}}
JSON

  # The expanded route disagrees with the selection on the varied stage — the
  # exact condition under which the arm used to be silently discarded.
  case "$stage" in
    plan)   printf '{"planner":"%s","coder":"bootstrap-coder","reviewer":"bootstrap-reviewer","planDepth":"deep","codeDepth":"medium","reviewMode":"llm"}\n' "$expanded_model" > "$feature_dir/.post-expansion-route.json" ;;
    review) printf '{"planner":"bootstrap-planner","coder":"bootstrap-coder","reviewer":"%s","planDepth":"light","codeDepth":"medium","reviewMode":"llm"}\n' "$expanded_model" > "$feature_dir/.post-expansion-route.json" ;;
    *)      printf '{"planner":"bootstrap-planner","coder":"%s","reviewer":"bootstrap-reviewer","planDepth":"light","codeDepth":"deep","reviewMode":"llm"}\n' "$expanded_model" > "$feature_dir/.post-expansion-route.json" ;;
  esac

  local intent_args=(--stage "$stage" --pair-id HOK-900 --slug pair-slug)
  case "$stage" in
    plan)   intent_args+=(--primary-planner "$primary_model" --challenger-planner "$challenger_model" --challenger-planner-agent "$(agent_resolve_from_model "$challenger_model")") ;;
    review) intent_args+=(--primary-reviewer "$primary_model" --challenger-reviewer "$challenger_model" --challenger-reviewer-agent "$(agent_resolve_from_model "$challenger_model")") ;;
    *)      intent_args+=(--primary-coder "$primary_model" --challenger-coder "$challenger_model" --challenger-coder-agent "$(agent_resolve_from_model "$challenger_model")") ;;
  esac

  local intent
  intent="$(real_challenge_intent "${intent_args[@]}")"

  # PRODUCER: the real mill function, writing both state and both feature dirs.
  persist_challenge_execution_intent "HOK-900" "HOK-900_c" "$feature_dir" "$intent" >/dev/null 2>&1 || true

  # CONSUMER: the real rerouting merge.
  apply_expanded_route_if_present "$feature_dir" "$issue" "$slug" "$wt_dir" "$STATE_FILE" >/dev/null 2>&1 || true

  printf '%s\n%s\n' "$root" "$feature_dir"
}

routing_field_for_stage() {
  case "$1" in
    plan) printf 'planner' ;;
    review) printf 'reviewer' ;;
    *) printf 'coder' ;;
  esac
}

phase_field_for_stage() {
  case "$1" in
    plan) printf 'planning' ;;
    review) printf 'review' ;;
    *) printf 'coding' ;;
  esac
}

echo "=== Challenge Intent Producer/Consumer Round-Trip ==="

for stage in plan implementation review; do
  for side in primary challenger; do
    if [[ "$side" == "challenger" ]]; then
      selected="kimi-k2"
    else
      selected="gpt-5.6-terra"
    fi

    mapfile -t out < <(roundtrip "$stage" "$side" "gpt-5.6-terra" "$selected" "claude-opus-4-7")
    root="${out[0]}"
    feature_dir="${out[1]}"

    routing_field="$(routing_field_for_stage "$stage")"
    phase_field="$(phase_field_for_stage "$stage")"
    actual_route="$(jq -r --arg f "$routing_field" '.[$f] // ""' "$feature_dir/.routing-complete" 2>/dev/null || true)"
    actual_phase="$(jq -r --arg f "$phase_field" '.[$f].model // ""' "$feature_dir/.phase-config.json" 2>/dev/null || true)"
    preserved="$(jq -r '.challengeIntentApplied // ""' "$feature_dir/.routing-complete" 2>/dev/null || true)"

    if [[ "$actual_route" == "$selected" && "$actual_phase" == "$selected" && "$preserved" == "true" ]]; then
      pass "stage=$stage side=$side retains the selected arm ($selected) through rerouting"
    else
      fail "stage=$stage side=$side lost the arm: route=$actual_route phase=$actual_phase preserved=$preserved (expected $selected)"
    fi
    rm -rf "$root"
  done
done

# The stages the pair does NOT vary must take the expanded route, otherwise the
# merge is over-preserving and the pair stops sharing its control variables.
{
  mapfile -t out < <(roundtrip "review" "challenger" "gpt-5.6-terra" "kimi-k2" "claude-opus-4-7")
  root="${out[0]}"
  feature_dir="${out[1]}"
  if [[ "$(jq -r '.reviewer' "$feature_dir/.routing-complete")" == "kimi-k2" ]] \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "bootstrap-coder" ]] \
    && [[ "$(jq -r '.planner' "$feature_dir/.routing-complete")" == "bootstrap-planner" ]]; then
    pass "shared stages still follow the expanded route while the varied stage is pinned"
  else
    fail "shared stages were incorrectly pinned alongside the varied stage"
  fi
  rm -rf "$root"
}

# A native challenger must still resolve to its native agent after rerouting —
# the coding launch reads .phase-config.json, so a lost agent silently
# downgrades the arm to the incumbent CLI.
{
  mapfile -t out < <(roundtrip "implementation" "challenger" "gpt-5.6-terra" "qwen-3-coder" "gpt-5.5")
  root="${out[0]}"
  feature_dir="${out[1]}"
  coding_model="$(jq -r '.coding.model' "$feature_dir/.phase-config.json")"
  coding_agent="$(jq -r '.coding.agent' "$feature_dir/.phase-config.json")"
  coding_provider="$(jq -r '.coding.provider' "$feature_dir/.phase-config.json")"
  if [[ "$coding_model" == "qwen-3-coder" ]] \
    && [[ "$coding_agent" == "native-openrouter" ]] \
    && [[ "$coding_provider" == "native-openrouter" ]]; then
    pass "native OpenRouter coder arm survives rerouting with its agent and provider intact"
  else
    fail "native coder arm degraded: model=$coding_model agent=$coding_agent provider=$coding_provider"
  fi
  rm -rf "$root"
}

# Transient challenger retries resolve the launch adapter from this immutable
# intent, not from stage-result provenance. Keep both runtime and projection
# fields available so native OpenRouter can relaunch as native-openrouter.
{
  intent="$(real_challenge_intent --stage implementation --pair-id HOK-900 --slug pair-slug \
    --challenger-coder llama-4-scout --challenger-coder-agent native-openrouter)"
  if jq -e \
    '.challenger.coder.model == "llama-4-scout"
     and .challenger.coder.agent == "native-openrouter"
     and .challenger.expectedStageModel == "llama-4-scout"
     and .challenger.expectedStageAgent == "native-openrouter"' \
    <<< "$intent" >/dev/null; then
    pass "native OpenRouter intent carries provider-aware retry launch identity"
  else
    fail "native OpenRouter intent lost provider-aware retry launch identity"
  fi
}

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
