#!/usr/bin/env bash
# HOK-3511: the challenge reseal carries models only. When the enriched intent
# changes the primary's not-yet-executed coder to a native model:
#   1. .phase-config.json gets the model with the agent and provider DERIVED
#      from it (never the sealed/carried executor) — the HOK-3500 class;
#   2. the route record (.post-expansion-route.json stageRoutes.coder) gets
#      exactly one `challenge` override (HOK-3363), seeded from the decided
#      model before the top-level fields move;
#   3. .routing-complete's top-level coder and the task row's coderModel agree;
#   4. an executed stage and a same-model stage are left untouched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

source "$REPO_DIR/shared/lib/wavemill-common.sh"
export TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); }
check_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-reseal-override.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

# Hermetic certification store: the writer's executor derivation is gated.
export WAVEMILL_NATIVE_CERTIFICATION_ROOT="$TMP_DIR/cert-root"
node --import tsx "$REPO_DIR/tests/fixtures/write-native-certification.ts" kimi-k2.7-code >/dev/null

log() { :; }
log_warn() { echo "warn: $*" >> "$TMP_DIR/log.txt"; }
log_error() { echo "error: $*" >> "$TMP_DIR/log.txt"; }
log_route_lifecycle() { echo "lifecycle: $*" >> "$TMP_DIR/log.txt"; }

extract_function() {
  awk -v name="$2" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$1"
}
eval "$(extract_function "$MONITOR_SCRIPT_FILE" challenge_reseal_primary_route)"
eval "$(extract_function "$MONITOR_SCRIPT_FILE" read_phase_config)"

FEATURE_DIR="$TMP_DIR/feature"
mkdir -p "$FEATURE_DIR"
STATE_FILE="$TMP_DIR/workflow-state.json"
printf '{"tasks":{"HOK-3500":{"coderModel":"claude-opus-5-5"}}}\n' > "$STATE_FILE"

# Sealed launch route: coder claude-opus-5-5 with its (carried) executor —
# the exact pre-reseal shape the incident recorded.
jq -n '{
  planning: {model: "gpt-5.6-terra", provider: "openai", agent: "codex", stageRole: "planning", challengeSide: null, selectedAt: "2026-11-17T16:35:31Z", depth: "light"},
  coding: {model: "claude-opus-5-5", provider: "anthropic", agent: "claude", stageRole: "coding", challengeSide: null, selectedAt: "2026-11-17T16:35:31Z", depth: "light"},
  review: {model: "claude-haiku-4-5-20251001", provider: "anthropic", agent: "claude", stageRole: "review", challengeSide: null, selectedAt: "2026-11-17T16:35:31Z", mode: "static"},
  resolvedAt: "2026-11-17T16:35:31Z", forceModel: null
}' > "$FEATURE_DIR/.phase-config.json"
jq -n '{planner: "gpt-5.6-terra", coder: "claude-opus-5-5", reviewer: "claude-haiku-4-5-20251001",
  planDepth: "light", codeDepth: "light", reviewMode: "static"}' > "$FEATURE_DIR/.routing-complete"
jq -n '{planner: "gpt-5.6-terra", coder: "claude-opus-5-5", reviewer: "claude-haiku-4-5-20251001",
  planDepth: "light", codeDepth: "light", reviewMode: "static"}' > "$FEATURE_DIR/.post-expansion-route.json"

# Enriched intent: models only (HOK-3511); the coder moved to a native model.
INTENT_JSON="$(jq -nc '{
  pairId: "HOK-3500",
  primary: {
    planner: {model: "gpt-5.6-terra"},
    coder: {model: "kimi-k2.7-code"},
    reviewer: {model: "claude-haiku-4-5-20251001"}
  }
}')"

challenge_reseal_primary_route "HOK-3500" "$FEATURE_DIR" "$INTENT_JSON" "plan" || {
  fail "reseal returned success" "0" "$?"
}

check_eq "coding model resealed to the enriched coder" "kimi-k2.7-code" \
  "$(jq -r '.coding.model' "$FEATURE_DIR/.phase-config.json")"
check_eq "coding agent DERIVED from the model (not carried claude)" "native-openrouter" \
  "$(jq -r '.coding.agent' "$FEATURE_DIR/.phase-config.json")"
check_eq "coding provider follows the derived agent" "native-openrouter" \
  "$(jq -r '.coding.provider' "$FEATURE_DIR/.phase-config.json")"
check_eq "coding depth preserved across the reseal" "light" \
  "$(jq -r '.coding.depth' "$FEATURE_DIR/.phase-config.json")"
check_eq "coding selectedAt kept (stage has not launched again)" "2026-11-17T16:35:31Z" \
  "$(jq -r '.coding.selectedAt' "$FEATURE_DIR/.phase-config.json")"
check_eq "executed planning stage untouched" "gpt-5.6-terra/codex" \
  "$(jq -r '"\(.planning.model)/\(.planning.agent)"' "$FEATURE_DIR/.phase-config.json")"
check_eq "same-model reviewer untouched" "claude-haiku-4-5-20251001/claude" \
  "$(jq -r '"\(.review.model)/\(.review.agent)"' "$FEATURE_DIR/.phase-config.json")"
check_eq ".routing-complete coder updated" "kimi-k2.7-code" \
  "$(jq -r '.coder' "$FEATURE_DIR/.routing-complete")"
check_eq "task row coderModel updated" "kimi-k2.7-code" \
  "$(jq -r '.tasks["HOK-3500"].coderModel' "$STATE_FILE")"
check_eq "route record: one challenge override on the coder (HOK-3363)" \
  "claude-opus-5-5>kimi-k2.7-code challenge challenge_reseal HOK-3500 primary 1" \
  "$(jq -r '.stageRoutes.coder | "\(.overrides[0].from)>\(.overrides[0].to) \(.overrides[0].source) \(.overrides[0].reason) \(.overrides[0].pairId) \(.overrides[0].side) \(.overrides | length)"' \
    "$FEATURE_DIR/.post-expansion-route.json")"
check_eq "route record: coder executed model is the resealed one" "kimi-k2.7-code" \
  "$(jq -r '.stageRoutes.coder.executed' "$FEATURE_DIR/.post-expansion-route.json")"
check_eq "route record: unchanged roles carry no override" "0 0" \
  "$(jq -r '"\(.stageRoutes.planner.overrides | length) \(.stageRoutes.reviewer.overrides | length)"' "$FEATURE_DIR/.post-expansion-route.json")"
check_eq "reseal lifecycle event names the changed role" "yes" \
  "$(grep -q 'challenge_primary_resealed issue=HOK-3500 fields=coder' "$TMP_DIR/log.txt" && echo yes || echo no)"

# A second reseal with the same models is a no-op: no second override.
challenge_reseal_primary_route "HOK-3500" "$FEATURE_DIR" "$INTENT_JSON" "plan" || fail "second reseal returned success" "0" "$?"
check_eq "same-model reseal appends no second override" "1" \
  "$(jq -r '.stageRoutes.coder.overrides | length' "$FEATURE_DIR/.post-expansion-route.json")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
(( FAIL == 0 )) || { cat "$TMP_DIR/log.txt" 2>/dev/null || true; exit 1; }
echo "challenge-reseal-route-override OK"
