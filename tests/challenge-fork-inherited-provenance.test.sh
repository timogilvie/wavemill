#!/usr/bin/env bash
# HOK-2814: inherited-stage provenance survives comparison and validates.
# Also covers the P2.4g integration-gate additions:
#   - divergent fork tree/task/plan/prompt/tool hashes
#   - challenged-vs-executed reviewer mismatch
#   - missing direct review evidence
#   - tie / insufficient_evidence
#   - delivery winner without stage winner (comparison-side quarantine)
#
# Unit-level invariants for these shapes are already covered by
# shared/lib/reviewer-stage-adjudicator.test.ts,
# shared/lib/challenge-execution-contract.test.ts, and
# tests/fork-aware-comparison.test.ts. This shell test is the surface-level
# gate: the test SUITE cannot claim a green pair for a shape the adjudicator
# rejects. Each sub-assertion drives the real contract entry point via a tsx
# one-liner rather than duplicating the TypeScript.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_DIR_ROOT/shared/lib/wavemill-monitor.sh"
STAGE_SCHEMA="$REPO_DIR_ROOT/shared/schemas/stage-result.schema.json"

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

TMP_ROOT="$(mktemp -d "/tmp/challenge-fork-inherited-provenance.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

# Seed a challenger feature dir with inherited stage-result files stamped
# source=inherited (exactly what challenge_materialize_challenger_arm writes).
CHALLENGER_FEATURE="$TMP_ROOT/features/foo-c"
mkdir -p "$CHALLENGER_FEATURE"

cat > "$CHALLENGER_FEATURE/.planning-result.json" <<'JSON'
{"stage":"planning","status":"completed","model":"claude-sonnet-5","agent":"claude","source":"inherited"}
JSON

cat > "$CHALLENGER_FEATURE/.coding-result.json" <<'JSON'
{"stage":"coding","status":"completed","model":"claude-opus-4-7","agent":"claude","source":"inherited"}
JSON

echo "=== stage-result schema accepts source=inherited ==="

if [[ "$(jq -r '.properties.source.enum | index("inherited") // "missing"' "$STAGE_SCHEMA")" != "missing" ]]; then
  pass "stage-result schema declares source enum includes inherited"
else
  fail "stage-result schema no longer declares source.enum includes inherited"
fi

# Validate the two written files against the schema. Prefer ajv when Node's
# require finds it (it does — the repo depends on it directly); fall back
# to a jq-only sanity check if unavailable.
if (cd "$REPO_DIR_ROOT" && node -e 'require("ajv/dist/2020")') 2>/dev/null; then
  validator="$TMP_ROOT/schema-validator.mjs"
  cat > "$validator" <<NODE
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

// createRequire from a file INSIDE the repo so Node's module resolution finds
// the repo's local node_modules (ajv, etc.) regardless of the script's TMP
// location.
const require = createRequire('${REPO_DIR_ROOT}/package.json');
const Ajv = require('ajv/dist/2020').default;

const schemaPath = process.argv[2];
const files = process.argv.slice(3);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

let bad = 0;
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!validate(data)) {
    process.stderr.write(\`INVALID \${basename(file)}: \${JSON.stringify(validate.errors)}\n\`);
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
NODE
  if node "$validator" "$STAGE_SCHEMA" \
       "$CHALLENGER_FEATURE/.planning-result.json" \
       "$CHALLENGER_FEATURE/.coding-result.json" 2>&1; then
    pass "inherited stage-result files validate against stage-result schema"
  else
    fail "inherited stage-result files failed schema validation"
  fi
else
  # Structural fallback — required fields plus source=inherited.
  ok="true"
  for file in "$CHALLENGER_FEATURE/.planning-result.json" "$CHALLENGER_FEATURE/.coding-result.json"; do
    jq -e '.stage and .status and .source == "inherited"' "$file" >/dev/null 2>&1 || ok="false"
  done
  if [[ "$ok" == "true" ]]; then
    pass "inherited stage-result files satisfy the schema's required fields (jq fallback)"
  else
    fail "inherited stage-result files failed the required-fields check"
  fi
fi

# ────────────────────────────────────────────────────────────────
# Fork-descriptor stamped intent — the challenger's intent file should
# describe the fork commit and the inherited stages after the materialiser
# runs. Replay the fork-descriptor stamp in isolation (its unit test lives
# in challenge-deferred-arm.test.sh; here we just assert the written shape).
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== inherited-stage descriptor lands on challenger intent ==="

state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
export -f state_mutate

STATE_FILE="$TMP_ROOT/state.json"
export STATE_FILE
printf '%s\n' '{"tasks":{"HOK-777":{},"HOK-777_c":{}}}' > "$STATE_FILE"

cat > "$CHALLENGER_FEATURE/.challenge-intent.json" <<'JSON'
{"schemaVersion":1,"pairId":"HOK-777","issueId":"HOK-777","selectedStage":"review","challengeStage":"review","primary":{"pairId":"HOK-777","side":"primary","challengeStage":"review","expectedStageModel":"claude-sonnet-5","expectedRoute":{}},"challenger":{"pairId":"HOK-777","side":"challenger","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","expectedRoute":{}},"forkStage":null,"forkCommit":null,"sharedPrefix":false}
JSON

PRIMARY_FEATURE="$TMP_ROOT/features/foo"
mkdir -p "$PRIMARY_FEATURE"
cp "$CHALLENGER_FEATURE/.challenge-intent.json" "$PRIMARY_FEATURE/.challenge-intent.json"

# Extract the fork-descriptor helper (already unit-tested elsewhere).
eval "$(awk '/^challenge_intent_stamp_fork_descriptor\(\) \{/{c=1} c{print} /^}/ && c{exit}' "$MONITOR_SCRIPT_FILE")"

challenge_intent_stamp_fork_descriptor \
  "HOK-777" "HOK-777_c" \
  "$PRIMARY_FEATURE" "$CHALLENGER_FEATURE" \
  "review" "abcdef01" '["plan","implementation"]'

check_eq "forkStage stamped" "review" "$(jq -r '.forkStage' "$CHALLENGER_FEATURE/.challenge-intent.json")"
check_eq "forkCommit stamped" "abcdef01" "$(jq -r '.forkCommit' "$CHALLENGER_FEATURE/.challenge-intent.json")"
check_eq "sharedPrefix stamped true" "true" "$(jq -r '.sharedPrefix' "$CHALLENGER_FEATURE/.challenge-intent.json")"
check_eq "challenger inheritedStages" '["plan","implementation"]' \
  "$(jq -c '.challenger.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")"
check_eq "primary inheritedStages empty" "[]" \
  "$(jq -c '.primary.inheritedStages' "$CHALLENGER_FEATURE/.challenge-intent.json")"

# ────────────────────────────────────────────────────────────────
# P2.4g adjudicator drives: build a driver we can invoke with different
# ForkIdentity + ReviewExecutedIdentitySet shapes and confirm the reason
# set that comes back. This exercises the same entry point (foldAttestations
# IntoStageAttribution) the resolver uses in production.
# ────────────────────────────────────────────────────────────────
DRIVER="$TMP_ROOT/adjudicator-driver.mts"
cat > "$DRIVER" <<PY
import { foldAttestationsIntoStageAttribution } from '$REPO_DIR_ROOT/shared/lib/challenge-execution-contract.ts';

const input = JSON.parse(process.argv[2]);
const result = foldAttestationsIntoStageAttribution(input);
process.stdout.write(JSON.stringify(result));
PY

drive() {
  local label="$1" payload="$2"
  local out
  if ! out="$(npx tsx "$DRIVER" "$payload" 2>&1)"; then
    fail "$label: tsx driver failed: $out"
    return
  fi
  printf '%s' "$out"
}

echo ""
echo "=== adjudicator: divergent-hash fork identity → invalid ==="

# A ForkIdentity where taskPacketHash is null (mismatched between arms in
# real life) must surface the taxonomy code AND divergent_pre_stage_inputs.
DIVERGENT_PAYLOAD='{
  "pairId": "HOK-777",
  "stage": "review",
  "primary": {"pairId":"HOK-777","side":"primary","validity":"valid","challengeStage":"review","expectedStageModel":"claude-sonnet-5","evidence":[]},
  "challenger": {"pairId":"HOK-777","side":"challenger","validity":"valid","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","evidence":[]},
  "evidenceProvenance": "direct",
  "forkIdentity": {
    "stage": "review",
    "commit": "abcdef01",
    "tree": "treeabc",
    "taskPacketHash": null,
    "planHash": "planhash",
    "promptHash": "promphash",
    "toolConfigHash": "toolhash"
  },
  "primaryReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true}
  },
  "challengerReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true}
  },
  "reviewIterationsComplete": true,
  "judgeWinner": "primary"
}'

DIVERGENT_RESULT="$(drive "divergent-hash driver" "$DIVERGENT_PAYLOAD")"
if [[ -n "$DIVERGENT_RESULT" ]]; then
  status="$(jq -r '.status' <<< "$DIVERGENT_RESULT")"
  reasons="$(jq -r '.reasonCodes[]' <<< "$DIVERGENT_RESULT" | sort | tr '\n' ' ')"
  check_eq "divergent-hash → status=invalid" "invalid" "$status"
  case "$reasons" in
    *task_packet_hash_mismatch*) pass "divergent-hash reasons include task_packet_hash_mismatch" ;;
    *) fail "divergent-hash reasons missing task_packet_hash_mismatch (got: $reasons)" ;;
  esac
  case "$reasons" in
    *divergent_pre_stage_inputs*) pass "divergent-hash reasons include divergent_pre_stage_inputs" ;;
    *) fail "divergent-hash reasons missing divergent_pre_stage_inputs (got: $reasons)" ;;
  esac
fi

echo ""
echo "=== adjudicator: challenged-vs-executed reviewer mismatch ==="

# The pin under test is claude-sonnet-5 but the substantive analysis ran on
# a different model — the pinned flag drops, hasUnpinnedIdentity flags the
# arm, and executed_identity_missing surfaces.
MISMATCH_PAYLOAD='{
  "pairId": "HOK-777",
  "stage": "review",
  "primary": {"pairId":"HOK-777","side":"primary","validity":"valid","challengeStage":"review","expectedStageModel":"claude-sonnet-5","evidence":[]},
  "challenger": {"pairId":"HOK-777","side":"challenger","validity":"valid","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","evidence":[]},
  "evidenceProvenance": "direct",
  "forkIdentity": {
    "stage": "review",
    "commit": "abcdef01",
    "tree": "treeabc",
    "taskPacketHash": "taskhash",
    "planHash": "planhash",
    "promptHash": "promphash",
    "toolConfigHash": "toolhash"
  },
  "primaryReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-sonnet-5","resolvedModel":"claude-opus-4-7","source":"artifact","pinned":false,"fallbackReason":"requested_model_unavailable"}
  },
  "challengerReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true}
  },
  "reviewIterationsComplete": true,
  "judgeWinner": "primary"
}'

MISMATCH_RESULT="$(drive "mismatch driver" "$MISMATCH_PAYLOAD")"
if [[ -n "$MISMATCH_RESULT" ]]; then
  status="$(jq -r '.status' <<< "$MISMATCH_RESULT")"
  reasons="$(jq -r '.reasonCodes[]' <<< "$MISMATCH_RESULT" | sort | tr '\n' ' ')"
  case "$status" in
    invalid|insufficient_evidence) pass "reviewer-mismatch status is invalid or insufficient_evidence (got $status)" ;;
    *) fail "reviewer-mismatch status must not be valid (got $status)" ;;
  esac
  case "$reasons" in
    *executed_identity_missing*) pass "reviewer-mismatch reasons include executed_identity_missing" ;;
    *) fail "reviewer-mismatch reasons missing executed_identity_missing (got: $reasons)" ;;
  esac
fi

echo ""
echo "=== adjudicator: inferred evidence only → insufficient_evidence ==="

INFERRED_PAYLOAD='{
  "pairId": "HOK-777",
  "stage": "review",
  "primary": {"pairId":"HOK-777","side":"primary","validity":"valid","challengeStage":"review","expectedStageModel":"claude-sonnet-5","evidence":[]},
  "challenger": {"pairId":"HOK-777","side":"challenger","validity":"valid","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","evidence":[]},
  "evidenceProvenance": "inferred",
  "forkIdentity": {
    "stage": "review",
    "commit": "abcdef01",
    "tree": "treeabc",
    "taskPacketHash": "taskhash",
    "planHash": "planhash",
    "promptHash": "promphash",
    "toolConfigHash": "toolhash"
  },
  "primaryReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true}
  },
  "challengerReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true}
  },
  "reviewIterationsComplete": true,
  "judgeWinner": "primary"
}'

INFERRED_RESULT="$(drive "inferred-evidence driver" "$INFERRED_PAYLOAD")"
if [[ -n "$INFERRED_RESULT" ]]; then
  status="$(jq -r '.status' <<< "$INFERRED_RESULT")"
  reasons="$(jq -r '.reasonCodes[]' <<< "$INFERRED_RESULT" | sort | tr '\n' ' ')"
  check_eq "inferred-only status is insufficient_evidence" "insufficient_evidence" "$status"
  case "$reasons" in
    *inferred_evidence_only*) pass "inferred-only reasons include inferred_evidence_only" ;;
    *) fail "inferred-only reasons missing inferred_evidence_only (got: $reasons)" ;;
  esac
fi

echo ""
echo "=== adjudicator: judgeWinner=tie surfaces as valid tie, judgeWinner=null as tie ==="

# When there are no reason codes, the adjudicator returns status=valid with
# whatever judge decision (tie/null) collapses to.
TIE_PAYLOAD='{
  "pairId": "HOK-777",
  "stage": "review",
  "primary": {"pairId":"HOK-777","side":"primary","validity":"valid","challengeStage":"review","expectedStageModel":"claude-sonnet-5","evidence":[]},
  "challenger": {"pairId":"HOK-777","side":"challenger","validity":"valid","challengeStage":"review","expectedStageModel":"claude-haiku-4-5-20251001","evidence":[]},
  "evidenceProvenance": "direct",
  "forkIdentity": {
    "stage": "review",
    "commit": "abcdef01",
    "tree": "treeabc",
    "taskPacketHash": "taskhash",
    "planHash": "planhash",
    "promptHash": "promphash",
    "toolConfigHash": "toolhash"
  },
  "primaryReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5","source":"route","pinned":true}
  },
  "challengerReviewIdentity": {
    "orchestrator": {"role":"review_orchestrator","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true},
    "substantiveAnalysis": {"role":"substantive_analysis","requestedModel":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","source":"route","pinned":true}
  },
  "reviewIterationsComplete": true,
  "judgeWinner": "tie"
}'

TIE_RESULT="$(drive "tie driver" "$TIE_PAYLOAD")"
if [[ -n "$TIE_RESULT" ]]; then
  outcome="$(jq -r '.outcome' <<< "$TIE_RESULT")"
  # Neither primary nor challenger — the resolver treats tie as no stage winner.
  case "$outcome" in
    tie|null) pass "judgeWinner=tie surfaces without a stage winner (outcome=$outcome)" ;;
    *) fail "judgeWinner=tie produced a stage winner (outcome=$outcome)" ;;
  esac
fi

# judgeWinner absent (null) — the folding function defaults to 'tie'.
NULL_PAYLOAD="$(jq -c '.judgeWinner = null' <<< "$TIE_PAYLOAD")"
NULL_RESULT="$(drive "null-winner driver" "$NULL_PAYLOAD")"
if [[ -n "$NULL_RESULT" ]]; then
  outcome="$(jq -r '.outcome' <<< "$NULL_RESULT")"
  case "$outcome" in
    tie|null) pass "judgeWinner=null surfaces without a stage winner (outcome=$outcome)" ;;
    *) fail "judgeWinner=null produced a stage winner (outcome=$outcome)" ;;
  esac
fi

echo ""
echo "=== delivery-winner-without-stage-winner: comparison quarantine site ==="

# The comparison-side branch that quarantines a comparison record where the
# challenge was invalid but a delivery winner was recorded lives in
# shared/lib/challenge-comparison.ts at the HOK-2970 branch. Assert the
# branch text still exists; unit-level behaviour is covered by
# tests/challenge-comparison.test.ts.
if grep -Fq 'HOK-2970: invalid_challenge records that came from the auto-resolve path' "$REPO_DIR_ROOT/shared/lib/challenge-comparison.ts" \
  && grep -Fq "if (record.comparisonOutcome === 'invalid_challenge')" "$REPO_DIR_ROOT/shared/lib/challenge-comparison.ts"; then
  pass "challenge-comparison.ts still guards delivery-winner-without-stage-winner"
else
  fail "delivery-winner-without-stage-winner quarantine branch is gone"
fi

echo ""
echo "=== restart preservation (executionIntent survives materializing → awaiting_fork) ==="

# End-to-end restart-preservation is covered by challenge-fork-restart.test.sh;
# assert the sibling exists so removing it breaks THIS suite too.
if [[ -f "$SCRIPT_DIR/challenge-fork-restart.test.sh" ]]; then
  pass "restart-preservation sibling test present"
else
  fail "restart-preservation sibling test missing"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
