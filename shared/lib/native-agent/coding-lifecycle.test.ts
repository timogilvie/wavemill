import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { validateCodingArtifacts, parseCodingComplete } from './coding-artifacts.ts';
import {
  CODING_FIXTURE_ARTIFACTS,
  CODING_FIXTURE_FEATURE_SLUG,
  CODING_FIXTURE_FINAL_SOURCE,
  CODING_FIXTURE_INITIAL_SOURCE,
  CODING_FIXTURE_MARKER_PATH,
  CODING_FIXTURE_RESULT_PATH,
  CODING_FIXTURE_SOURCE_PATH,
  codingLifecycleSessionTurns,
} from './fixtures/coding-lifecycle-session.ts';
import { runWavemillLoop, type AgentContext, type WavemillLoopConfig } from './loop.ts';
import type { Message } from './messages.ts';
import { registerScriptedPiProvider } from './provider.ts';
import {
  codingMutationAfterToolCall,
  codingMutationPolicyConfig,
  createCodingMutationTools,
} from './tools/mutation-tools.ts';
import { createGitCommitTools, gitMutationToolPolicyConfig } from './tools/git.ts';
import { createIntendedFileTracker, intendedFilesAfterToolCall } from './tools/intended-files.ts';
import { toPiAgentTool } from './tools/pi-adapter.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { createToolRegistry } from './tools/registry.ts';

const dirsToClean = new Set<string>();
let apiSeq = 0;
type LoopEvent = Parameters<NonNullable<WavemillLoopConfig['onEvent']>>[0];

after(() => {
  for (const dir of dirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-agent coding lifecycle', () => {
  it('applies a one-file patch and writes completion markers and artifacts', async () => {
    const repo = createRepo('native-coding-lifecycle-');
    seedRepo(repo);

    const api = uniqueApi('coding-lifecycle');
    registerScriptedPiProvider({ api, turns: codingLifecycleSessionTurns });

    const tracker = createIntendedFileTracker();
    const registry = createToolRegistry([
      ...createReadOnlyTools(repo),
      ...createCodingMutationTools(repo, { phase: 'coding' }),
      ...createGitCommitTools(repo, { tracker }),
    ]);
    const events: LoopEvent[] = [];

    const context: AgentContext = {
      systemPrompt: 'You are a coding agent. Read the file, patch it, and write completion artifacts.',
      messages: [{ role: 'user', content: 'Complete the coding task.', timestamp: 0 }],
      tools: registry.getTools().map((tool) => toPiAgentTool(tool)),
    };

    const loopConfig: WavemillLoopConfig = {
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
        return codingMutationAfterToolCall(toolContext);
      },
      toolPolicy: {
        phase: 'coding',
        worktreePath: repo,
        registry: registry.list(),
        config: {
          pathFieldsByTool: {
            ...READ_ONLY_PATH_FIELDS,
            ...codingMutationPolicyConfig.pathFieldsByTool,
            ...gitMutationToolPolicyConfig.pathFieldsByTool,
          },
        },
      },
      onEvent: (event) => {
        events.push(event);
      },
    };

    const result = await runWavemillLoop(loopConfig);

    assert.equal(result.stopReason, 'stop');
    assert.equal(readFileSync(path.join(repo, CODING_FIXTURE_SOURCE_PATH), 'utf-8'), CODING_FIXTURE_FINAL_SOURCE);
    assert.equal(existsSync(path.join(repo, CODING_FIXTURE_MARKER_PATH)), true);
    assert.equal(existsSync(path.join(repo, CODING_FIXTURE_RESULT_PATH)), true);

    const staleAttempt = findToolExecutionEnd(events, 'coding-patch-stale-1');
    assert.equal(staleAttempt?.isError, true);
    assert.equal(staleAttempt?.toolName, 'apply_patch');
    assert.equal((staleAttempt?.result as { details?: { error?: string } })?.details?.error, 'patch_rejected');
    assert.equal(
      (staleAttempt?.result as { details?: { diagnostics?: { code?: string; liveContext?: { path?: string } } } })?.details?.diagnostics?.code,
      'old_text_not_found',
    );
    assert.equal(
      (staleAttempt?.result as { details?: { diagnostics?: { liveContext?: { path?: string } } } })?.details?.diagnostics?.liveContext?.path,
      CODING_FIXTURE_SOURCE_PATH,
    );

    const successfulPatch = findToolExecutionEnd(events, 'coding-patch-fix-1');
    assert.equal(successfulPatch?.isError, false);
    assert.deepEqual(
      (successfulPatch?.result as { details?: { changedFiles?: string[] } })?.details?.changedFiles,
      [CODING_FIXTURE_SOURCE_PATH],
    );

    const markerText = readFileSync(path.join(repo, CODING_FIXTURE_MARKER_PATH), 'utf-8');
    const parsedMarker = parseCodingComplete(markerText);
    assert.equal(parsedMarker.ok, true);
    if (parsedMarker.ok) {
      assert.equal(parsedMarker.value.confidence, 'high');
      assert.equal(parsedMarker.value.producer, 'native-agent');
    }

    const parsedArtifacts = JSON.parse(readFileSync(path.join(repo, CODING_FIXTURE_RESULT_PATH), 'utf-8')) as unknown;
    const artifactValidation = validateCodingArtifacts(parsedArtifacts);
    assert.equal(artifactValidation.ok, true);
    if (artifactValidation.ok) {
      assert.deepEqual(artifactValidation.value, CODING_FIXTURE_ARTIFACTS);
    }
  });
});

function createRepo(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirsToClean.add(dir);
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Native Coding Test'], { stdio: 'pipe' });
  return dir;
}

function seedRepo(repo: string): void {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(repo, 'features', CODING_FIXTURE_FEATURE_SLUG), { recursive: true });
  writeFileSync(path.join(repo, CODING_FIXTURE_SOURCE_PATH), CODING_FIXTURE_INITIAL_SOURCE, 'utf-8');
  writeFileSync(path.join(repo, 'features', CODING_FIXTURE_FEATURE_SLUG, 'task-packet.md'), '# Task Packet\n', 'utf-8');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'fixture'], { stdio: 'pipe' });
}

function uniqueApi(label: string): string {
  apiSeq += 1;
  return `${label}-${apiSeq}`;
}

function findToolExecutionEnd(
  events: LoopEvent[],
  toolCallId: string,
): Extract<LoopEvent, { type: 'tool_execution_end' }> | undefined {
  return events.find((event): event is Extract<LoopEvent, { type: 'tool_execution_end' }> =>
    event.type === 'tool_execution_end' && event.toolCallId === toolCallId);
}
