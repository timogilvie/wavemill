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
HARNESS="$REPO_DIR/.tmp-native-coding-commit-harness-$$.ts"
TEST_REPO="$TMP_ROOT/repo"
FEATURE_SLUG="native-command-commit-smoke"
FEATURE_DIR="$TEST_REPO/features/$FEATURE_SLUG"
trap 'rm -rf "$TMP_ROOT"; rm -f "$HARNESS"' EXIT

mkdir -p "$TEST_REPO/src" "$FEATURE_DIR"
git -C "$TEST_REPO" init >/dev/null 2>&1
git -C "$TEST_REPO" config user.name "Wavemill Test"
git -C "$TEST_REPO" config user.email "wavemill@example.com"
printf "export const message = 'before';\n" > "$TEST_REPO/src/app.ts"
printf '# Task Packet\n' > "$FEATURE_DIR/task-packet.md"
git -C "$TEST_REPO" add .
git -C "$TEST_REPO" commit -m "fixture" >/dev/null 2>&1

cat > "$HARNESS" <<'EOF'
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseCodingComplete, validateCodingArtifacts } from '__REPO_DIR__/shared/lib/native-agent/coding-artifacts.ts';
import { runWavemillLoop, type AgentContext, type WavemillLoopConfig } from '__REPO_DIR__/shared/lib/native-agent/loop.ts';
import type { Message } from '__REPO_DIR__/shared/lib/native-agent/messages.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from '__REPO_DIR__/shared/lib/native-agent/provider.ts';
import {
  commandToolsAfterToolCall,
  createCommandTools,
} from '__REPO_DIR__/shared/lib/native-agent/tools/command-tools.ts';
import {
  createGitCommitTools,
  gitMutationAfterToolCall,
} from '__REPO_DIR__/shared/lib/native-agent/tools/git.ts';
import { createIntendedFileTracker, intendedFilesAfterToolCall } from '__REPO_DIR__/shared/lib/native-agent/tools/intended-files.ts';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
} from '__REPO_DIR__/shared/lib/native-agent/tools/mutation-tools.ts';
import { toPiAgentTool } from '__REPO_DIR__/shared/lib/native-agent/tools/pi-adapter.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from '__REPO_DIR__/shared/lib/native-agent/tools/read-only.ts';
import { createToolRegistry } from '__REPO_DIR__/shared/lib/native-agent/tools/registry.ts';
import { gitMutationToolPolicyConfig } from '__REPO_DIR__/shared/lib/native-agent/tools/git.ts';

const mode = process.argv[2];
const repo = process.argv[3];
const featureSlug = process.argv[4];

if (!mode || !repo || !featureSlug) {
  throw new Error('usage: harness <happy|out_of_scope|dangerous_tests> <repo> <featureSlug>');
}

const sourcePath = 'src/app.ts';
const markerPath = `features/${featureSlug}/.coding-complete`;
const resultPath = `features/${featureSlug}/.coding-result.json`;
const finalSource = "export const message = 'after';\n";

async function main() {
  const tracker = createIntendedFileTracker();
  const registry = createToolRegistry([
    ...createReadOnlyTools(repo),
    ...createCodingMutationTools(repo, { phase: 'coding' }),
    ...createCommandTools(repo),
    ...createGitCommitTools(repo, { tracker }),
  ]);
  const turns = buildTurns(mode, featureSlug);
  const api = `native-command-commit-${mode}-${process.pid}-${Date.now()}`;
  registerScriptedPiProvider({ api, turns });
  const events: Array<Parameters<NonNullable<WavemillLoopConfig['onEvent']>>[0]> = [];

  const context: AgentContext = {
    systemPrompt: 'Complete the coding task end-to-end.',
    messages: [{ role: 'user', content: `Run coding scenario ${mode}.`, timestamp: 0 }],
    tools: registry.getTools().map((tool) => toPiAgentTool(tool)),
  };

  const result = await runWavemillLoop({
    model: {
      id: `scripted:${api}`,
      name: `scripted:${api}`,
      api,
      provider: 'scripted',
    },
    context,
    convertToLlm: (messages) => messages as unknown as Message[],
    afterToolCall: async (toolContext) => {
      await intendedFilesAfterToolCall(toolContext, tracker);
      const commandResult = await commandToolsAfterToolCall(toolContext);
      if (commandResult?.isError) {
        return commandResult;
      }
      const gitResult = await gitMutationAfterToolCall(toolContext);
      if (gitResult?.isError) {
        return gitResult;
      }
      return codingMutationAfterToolCall(toolContext);
    },
    toolPolicy: {
      phase: 'coding',
      worktreePath: repo,
      registry: registry.list(),
      config: {
        pathFieldsByTool: {
          ...READ_ONLY_PATH_FIELDS,
          ...gitMutationToolPolicyConfig.pathFieldsByTool,
          ...codingMutationPolicyConfig.pathFieldsByTool,
        },
      },
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  const markerExists = existsSync(path.join(repo, markerPath));
  const artifactExists = existsSync(path.join(repo, resultPath));
  const markerParse = markerExists
    ? parseCodingComplete(readFileSync(path.join(repo, markerPath), 'utf8'))
    : { ok: false, errors: [{ message: 'missing marker' }] };
  const artifactValidation = artifactExists
    ? validateCodingArtifacts(JSON.parse(readFileSync(path.join(repo, resultPath), 'utf8')) as unknown)
    : { ok: false, errors: [{ message: 'missing artifact' }] };
  const lastToolEvent = [...events].reverse().find((event) => event.type === 'tool_execution_end');

  process.stdout.write(`${JSON.stringify({
    mode,
    stopReason: result.stopReason,
    turnsCompleted: result.turnsCompleted,
    toolCallsExecuted: result.toolCallsExecuted,
    source: readFileSync(path.join(repo, sourcePath), 'utf8'),
    markerExists,
    artifactExists,
    markerParse,
    artifactValidation,
    trackerList: tracker.list(),
    trackerCommitCount: tracker.commitCount,
    lastToolEvent: lastToolEvent && lastToolEvent.type === 'tool_execution_end'
      ? {
        toolName: lastToolEvent.toolName,
        isError: lastToolEvent.isError,
        details: (lastToolEvent.result as { details?: unknown } | undefined)?.details,
      }
      : null,
  })}\n`);
}

function buildTurns(mode: string, featureSlug: string): ScriptedPiProviderTurn[] {
  if (mode === 'happy') {
    return [
      toolTurn('coding-read-1', 'read_file', { path: sourcePath }),
      toolTurn('coding-patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: sourcePath,
            oldText: "export const message = 'before';\n",
            newText: finalSource,
          }],
        },
      }),
      toolTurn('coding-tests-1', 'run_tests', {
        command: `node -e "process.stdout.write('tests-ok')"`,
      }),
      toolTurn('coding-format-1', 'run_format', {
        command: `node -e "process.stdout.write('fmt-ok')"`,
      }),
      toolTurn('coding-add-1', 'git_add', { paths: [sourcePath] }),
      toolTurn('coding-commit-1', 'git_commit', { message: 'feat: rename greeting' }),
      toolTurn('coding-artifact-1', 'write_artifact', {
        path: `features/${featureSlug}/.coding-result.json`,
        content: `${JSON.stringify({
          type: 'coding',
          filesChanged: 1,
          linesAdded: 1,
          linesRemoved: 1,
          commitCount: 1,
        }, null, 2)}\n`,
      }),
      toolTurn('coding-marker-1', 'create_marker', {
        path: `features/${featureSlug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high","producer":"native-agent"}\n',
      }),
      {
        content: [{ type: 'text', text: 'Coding complete.' }],
        usage: usage(9),
        stopReason: 'stop',
      },
    ];
  }

  if (mode === 'out_of_scope') {
    return [
      toolTurn('coding-patch-scope-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: sourcePath,
            oldText: "export const message = 'before';\n",
            newText: finalSource,
          }],
        },
      }),
      toolTurn('coding-add-scope-1', 'git_add', { paths: [sourcePath] }),
      toolTurn('coding-commit-scope-1', 'git_commit', { message: 'feat: rename greeting' }),
      {
        content: [{ type: 'text', text: 'Out-of-scope commit rejected.' }],
        usage: usage(4),
        stopReason: 'stop',
      },
    ];
  }

  if (mode === 'dangerous_tests') {
    return [
      toolTurn('coding-tests-danger-1', 'run_tests', { command: 'rm -rf /tmp/x' }),
      {
        content: [{ type: 'text', text: 'Dangerous command rejected.' }],
        usage: usage(2),
        stopReason: 'stop',
      },
    ];
  }

  throw new Error(`unknown mode: ${mode}`);
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): ScriptedPiProviderTurn {
  return {
    content: [{ type: 'tool_call', id, name, arguments: args }],
    usage: usage(1),
    stopReason: 'toolUse',
  };
}

function usage(multiplier: number) {
  return {
    input: 100 * multiplier,
    output: 20 * multiplier,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120 * multiplier,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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

HAPPY_JSON="$TMP_ROOT/happy.json"
node "$HARNESS" happy "$TEST_REPO" "$FEATURE_SLUG" > "$HAPPY_JSON"

if jq -e '.stopReason == "stop"' "$HAPPY_JSON" >/dev/null; then
  pass "happy path stops cleanly"
else
  fail "happy path stops cleanly" "$(cat "$HAPPY_JSON")"
fi

if jq -e '.source == "export const message = '\''after'\'';\n"' "$HAPPY_JSON" >/dev/null; then
  pass "happy path patches source"
else
  fail "happy path patches source" "$(cat "$HAPPY_JSON")"
fi

if [[ "$(git -C "$TEST_REPO" log --format=%s -n 1)" == "feat: rename greeting" ]]; then
  pass "happy path creates commit"
else
  fail "happy path creates commit" "$(git -C "$TEST_REPO" log --format=%s -n 1)"
fi

if [[ "$(git -C "$TEST_REPO" show --name-only --format= HEAD | sed '/^$/d')" == "src/app.ts" ]]; then
  pass "commit only includes intended source file"
else
  fail "commit only includes intended source file" "$(git -C "$TEST_REPO" show --name-only --format= HEAD)"
fi

if jq -e '.markerExists == true and .artifactExists == true and .markerParse.ok == true and .markerParse.value.confidence == "high" and .markerParse.value.producer == "native-agent"' "$HAPPY_JSON" >/dev/null; then
  pass "completion marker is valid"
else
  fail "completion marker is valid" "$(cat "$HAPPY_JSON")"
fi

if jq -e '.artifactValidation.ok == true and .artifactValidation.value.filesChanged == 1 and .artifactValidation.value.commitCount == 1' "$HAPPY_JSON" >/dev/null; then
  pass "coding artifact validates"
else
  fail "coding artifact validates" "$(cat "$HAPPY_JSON")"
fi

if jq -e '.trackerList == ["features/'"$FEATURE_SLUG"'/.coding-complete","features/'"$FEATURE_SLUG"'/.coding-result.json","src/app.ts"] and .trackerCommitCount == 1' "$HAPPY_JSON" >/dev/null; then
  pass "intended file tracker records source and artifacts"
else
  fail "intended file tracker records source and artifacts" "$(cat "$HAPPY_JSON")"
fi

printf 'export const stray = 1;\n' > "$TEST_REPO/stray.ts"
git -C "$TEST_REPO" add stray.ts
OUT_OF_SCOPE_JSON="$TMP_ROOT/out-of-scope.json"
node "$HARNESS" out_of_scope "$TEST_REPO" "$FEATURE_SLUG" > "$OUT_OF_SCOPE_JSON"

if jq -e '.lastToolEvent.toolName == "git_commit" and .lastToolEvent.isError == true and .lastToolEvent.details.ok == false and .lastToolEvent.details.error.code == "out_of_scope"' "$OUT_OF_SCOPE_JSON" >/dev/null; then
  pass "out-of-scope commit is rejected"
else
  fail "out-of-scope commit is rejected" "$(cat "$OUT_OF_SCOPE_JSON")"
fi

git -C "$TEST_REPO" reset HEAD stray.ts >/dev/null 2>&1
rm -f "$TEST_REPO/stray.ts"

DANGEROUS_JSON="$TMP_ROOT/dangerous.json"
node "$HARNESS" dangerous_tests "$TEST_REPO" "$FEATURE_SLUG" > "$DANGEROUS_JSON"

if jq -e '.lastToolEvent.toolName == "run_tests" and .lastToolEvent.isError == true and .lastToolEvent.details.ok == false and .lastToolEvent.details.error == "unsafe_command"' "$DANGEROUS_JSON" >/dev/null; then
  pass "dangerous run_tests command is rejected"
else
  fail "dangerous run_tests command is rejected" "$(cat "$DANGEROUS_JSON")"
fi

if [[ "$(cat "$TEST_REPO/src/app.ts")" == "export const message = 'after';" ]]; then
  pass "dangerous run_tests leaves source untouched"
else
  fail "dangerous run_tests leaves source untouched" "$(cat "$TEST_REPO/src/app.ts")"
fi

echo "--- Results: $PASS passed, $FAIL failed ---"
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
