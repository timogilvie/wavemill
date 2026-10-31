#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
HARNESS="$REPO_DIR/.tmp-native-review-harness-$$.ts"
TEST_REPO="$TMP_ROOT/repo"
trap 'rm -rf "$TMP_ROOT"; rm -f "$HARNESS"' EXIT

mkdir -p "$TEST_REPO"
git -C "$TEST_REPO" init >/dev/null 2>&1
git -C "$TEST_REPO" config user.name "Wavemill Test"
git -C "$TEST_REPO" config user.email "wavemill@example.com"
printf '.wavemill/\n' > "$TEST_REPO/.gitignore"
printf 'prompt-registry.jsonl\n' >> "$TEST_REPO/.gitignore"
printf 'export const value = 1;\n' > "$TEST_REPO/file.ts"
cat > "$TEST_REPO/.wavemill-config.json" <<'EOF'
{"nativeAgent":{"enabled":true,"allowedPhases":["review"]}}
EOF
git -C "$TEST_REPO" add .gitignore file.ts .wavemill-config.json
git -C "$TEST_REPO" commit -m "init" >/dev/null 2>&1

cat > "$HARNESS" <<'EOF'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runNativeReview, nativeReviewTestUtils } from '__REPO_DIR__/shared/lib/native-agent/review.ts';
import { NativeSessionAdapter, getNativeProviderMetadata } from '__REPO_DIR__/shared/lib/session-adapters.ts';
import { runReview, reviewEngineTestUtils } from '__REPO_DIR__/shared/lib/review-engine.ts';

async function main() {
  const mode = process.argv[2];
  const repoDir = process.argv[3];
  if (!mode || !repoDir) {
    throw new Error('usage: harness <enabled|disabled> <repoDir>');
  }

  const context = {
    diff: 'diff --git a/file.ts b/file.ts\n+export const value = 2;',
    plan: 'Plan',
    taskPacket: 'Task packet',
    designContext: null,
    metadata: {
      branch: 'feature/native-review',
      files: ['file.ts'],
      hasUiChanges: false,
    },
  };

  if (mode === 'enabled') {
    nativeReviewTestUtils.setSelectReviewProvider(() => ({
      ok: true,
      entry: {
        providerName: 'openai',
        modelId: 'gpt-4o',
        status: 'ready',
        apiKeyEnv: 'OPENAI_API_KEY',
        baseUrl: 'https://api.openai.com/v1',
        headers: {},
        model: {
          id: 'openai:gpt-4o',
          name: 'gpt-4o',
          api: 'openai-responses',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          headers: {},
        },
      },
    }));
    nativeReviewTestUtils.setGetNativeProviderApiKey(() => 'test-key');
    nativeReviewTestUtils.setRunWavemillLoop(async (config) => {
      const message = {
        role: 'assistant' as const,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ verdict: 'ready', codeReviewFindings: [] }),
        }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-4o',
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as const,
        timestamp: Date.now(),
      };

      config.onEvent?.({ type: 'agent_start' });
      config.onEvent?.({ type: 'turn_start' });
      config.onEvent?.({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'apply_patch',
        isError: true,
        result: {
          content: [{ type: 'text', text: 'phase_denied: tool "apply_patch" is not allowed in review' }],
        },
      });
      config.onEvent?.({ type: 'message_end', message });
      config.onEvent?.({ type: 'turn_end', message, toolResults: [] });
      config.onEvent?.({ type: 'agent_end', messages: [message] });

      return {
        messages: [message],
        stopReason: 'stop' as const,
        turnsCompleted: 1,
        toolCallsExecuted: 0,
        totalInputTokens: 10,
        totalOutputTokens: 10,
        totalCostUsd: 0,
        wallClockMs: 5,
      };
    });

    const result = await runNativeReview(context, repoDir, {});
    const scan = new NativeSessionAdapter().scan({
      worktreePath: repoDir,
      branchName: context.metadata.branch,
    });
    const providerMetadata = getNativeProviderMetadata(repoDir);
    const runsDir = join(repoDir, '.wavemill', 'runs');
    const runId = readdirSync(runsDir)[0];
    const sessionDir = join(runsDir, runId, 'native-sessions');
    const transcriptPath = join(sessionDir, readdirSync(sessionDir)[0]);
    const transcript = readFileSync(transcriptPath, 'utf-8');
    const parsedTranscript = transcript
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gitStatus = execFileSync('git', ['status', '--short'], { cwd: repoDir, encoding: 'utf-8' }).trim();

    console.log(JSON.stringify({
      result,
      scan,
      providerMetadata,
      transcriptPath,
      transcriptContainsPhaseDenied: parsedTranscript.some(
        (event) => event.type === 'tool_result' && typeof event.content === 'string' && event.content.includes('phase_denied'),
      ),
      gitStatus,
    }));
  } else if (mode === 'disabled') {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      nativeAgent: {
        enabled: false,
        allowedPhases: ['review'],
      },
    }));

    let loaderCalls = 0;
    reviewEngineTestUtils.setLoadNativeReviewModule(async () => {
      loaderCalls += 1;
      throw new Error('native loader should not be called');
    });
    reviewEngineTestUtils.setRunPersonaReview(async () => ({
      verdict: 'ready' as const,
      codeReviewFindings: [],
      metadata: {
        branch: context.metadata.branch,
        files: context.metadata.files,
        hasUiChanges: false,
        designContextAvailable: false,
        uiVerificationRun: false,
      },
    }));

    const result = await runReview(context, repoDir, { skipClaudePreflight: true });
    console.log(JSON.stringify({
      result,
      loaderCalls,
      nativeSessionsExists: existsSync(join(repoDir, '.wavemill', 'runs')),
    }));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

python3 - <<'PY' "$HARNESS" "$REPO_DIR"
from pathlib import Path
import sys
path = Path(sys.argv[1])
repo_dir = sys.argv[2]
path.write_text(path.read_text().replace('__REPO_DIR__', repo_dir))
PY

echo "=== native review enabled ==="
ENABLED_JSON="$TMP_ROOT/enabled.json"
node "$HARNESS" enabled "$TEST_REPO" > "$ENABLED_JSON"

if [[ "$(jq -r '.result.verdict' "$ENABLED_JSON")" == "ready" ]]; then
  pass "native review returns ready result"
else
  fail "native review returns ready result" "$(cat "$ENABLED_JSON")"
fi

if [[ "$(jq -r '.result.metadata.deniedTools | length' "$ENABLED_JSON")" == "1" ]]; then
  pass "denied tool is surfaced in metadata"
else
  fail "denied tool is surfaced in metadata" "$(cat "$ENABLED_JSON")"
fi

if jq -e '.scan.turnCount >= 1 and .scan.sessionCount >= 1' "$ENABLED_JSON" >/dev/null; then
  pass "native transcript is consumable by NativeSessionAdapter"
else
  fail "native transcript is consumable by NativeSessionAdapter" "$(cat "$ENABLED_JSON")"
fi

if [[ "$(jq -r '.providerMetadata.provider' "$ENABLED_JSON")" == "openai" ]]; then
  pass "native provider metadata is discoverable"
else
  fail "native provider metadata is discoverable" "$(cat "$ENABLED_JSON")"
fi

if [[ "$(jq -r '.providerMetadata.endpoint' "$ENABLED_JSON")" == "openai-responses" ]]; then
  pass "native provider endpoint is discoverable"
else
  fail "native provider endpoint is discoverable" "$(cat "$ENABLED_JSON")"
fi

if [[ "$(jq -r '.scan.models["gpt-4o"].inputTokens' "$ENABLED_JSON")" == "10" ]]; then
  pass "native session scan preserves model identity"
else
  fail "native session scan preserves model identity" "$(cat "$ENABLED_JSON")"
fi

if [[ "$(jq -r '.transcriptContainsPhaseDenied' "$ENABLED_JSON")" == "true" ]]; then
  pass "phase denial is preserved in transcript"
else
  fail "phase denial is preserved in transcript" "$(cat "$ENABLED_JSON")"
fi

if [[ -z "$(jq -r '.gitStatus' "$ENABLED_JSON")" ]]; then
  pass "native review leaves git status clean"
else
  fail "native review leaves git status clean" "$(cat "$ENABLED_JSON")"
fi

echo ""
echo "=== native review disabled ==="
DISABLED_JSON="$TMP_ROOT/disabled.json"
rm -rf "$TEST_REPO/.wavemill"
node "$HARNESS" disabled "$TEST_REPO" > "$DISABLED_JSON"

if [[ "$(jq -r '.loaderCalls' "$DISABLED_JSON")" == "0" ]]; then
  pass "disabled path does not invoke native loader"
else
  fail "disabled path does not invoke native loader" "$(cat "$DISABLED_JSON")"
fi

if [[ "$(jq -r '.nativeSessionsExists' "$DISABLED_JSON")" == "false" ]]; then
  pass "disabled path does not create native session artifacts"
else
  fail "disabled path does not create native session artifacts" "$(cat "$DISABLED_JSON")"
fi

if [[ "$(jq -r '.result.verdict' "$DISABLED_JSON")" == "ready" ]]; then
  pass "disabled path falls through to legacy review behavior"
else
  fail "disabled path falls through to legacy review behavior" "$(cat "$DISABLED_JSON")"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
