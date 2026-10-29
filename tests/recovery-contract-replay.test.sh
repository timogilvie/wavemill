#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Recovery Contract Replay ==="

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
cat > "$tmpdir/.phase-config.json" <<'EOF'
{
  "coding": {
    "model": "gpt-5.3-codex",
    "provider": "openai",
    "agent": "codex",
    "stageRole": "coding",
    "challengeSide": "primary",
    "selectedAt": "2026-07-30T00:00:00Z"
  }
}
EOF

contract_json="$(npx tsx "$REPO_DIR/tools/recovery-contract.ts" read --feature-dir "$tmpdir" --stage coding --challenge-side challenger --json)"
if jq -e '
  .ok == true
  and .contract.model == "gpt-5.3-codex"
  and .contract.provider == "openai"
  and .contract.agent == "codex"
  and .contract.stageRole == "coding"
  and .contract.challengeSide == "challenger"
  and .contract.selectedAt == "2026-07-30T00:00:00Z"
' <<<"$contract_json" >/dev/null 2>&1; then
  pass "recovery CLI replays the persisted model, provider, agent, stage, side, and selection time"
else
  fail "recovery CLI does not replay the complete persisted contract"
fi

cat > "$tmpdir/.phase-config.json" <<'EOF'
{
  "resolvedAt": "2026-09-15T12:00:00Z",
  "review": {
    "model": "claude-haiku-4-5-20251001",
    "provider": "anthropic",
    "agent": "claude",
    "stageRole": "review",
    "challengeSide": null,
    "selectedAt": "2026-09-15T12:00:00Z"
  }
}
EOF
cat > "$tmpdir/challenge-intent.json" <<'EOF'
{
  "pairId": "HOK-3010",
  "challengeStage": "review",
  "createdAt": "2026-09-14T19:00:00Z",
  "primary": {
    "pairId": "HOK-3010",
    "side": "primary",
    "challengeStage": "review",
    "expectedStageModel": "claude-haiku-4-5-20251001",
    "expectedStageAgent": "claude",
    "expectedRoute": {"planner":"","coder":"","reviewer":"claude-haiku-4-5-20251001","planDepth":"","codeDepth":"","reviewMode":""}
  },
  "challenger": {
    "pairId": "HOK-3010",
    "side": "challenger",
    "challengeStage": "review",
    "expectedStageModel": "kimi-k3",
    "expectedStageAgent": "native-openrouter",
    "expectedRoute": {"planner":"","coder":"","reviewer":"kimi-k3","planDepth":"","codeDepth":"","reviewMode":""}
  }
}
EOF

review_contract_json="$(npx tsx "$REPO_DIR/tools/recovery-contract.ts" read --feature-dir "$tmpdir" --stage review --challenge-side challenger --json)"
if jq -e '
  .ok == true
  and .contract.model == "kimi-k3"
  and .contract.agent == "native-openrouter"
  and .contract.stageRole == "review"
  and .contract.challengeSide == "challenger"
' <<<"$review_contract_json" >/dev/null 2>&1; then
  pass "review recovery CLI prefers reviewer-stage challenge intent over inherited phase config"
else
  fail "review recovery CLI did not prefer reviewer-stage challenge intent"
fi

rm "$tmpdir/.phase-config.json"
missing_json="$(npx tsx "$REPO_DIR/tools/recovery-contract.ts" read --feature-dir "$tmpdir" --stage coding --json)"
if jq -e '.ok == false and .reason == "contract_missing"' <<<"$missing_json" >/dev/null 2>&1; then
  pass "recovery CLI refuses to recover without a persisted contract"
else
  fail "recovery CLI does not fail closed when the persisted contract is missing"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

[[ "$FAIL" -eq 0 ]]
