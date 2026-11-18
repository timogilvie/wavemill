#!/usr/bin/env tsx
/**
 * Native read-only lifecycle smoke test.
 *
 * Runs a deterministic mock planning loop without live provider keys.
 * Validates:
 *   - Real read-only tools (read_file, list_files, search_text) execute successfully
 *   - Real git tools (git_status, git_diff) execute successfully
 *   - A mutation tool (patch_file) is blocked by read-only phase policy
 *   - Secrets embedded in source files are redacted from tool results and transcript JSONL
 *   - Transcript JSONL does not contain the seeded secret
 *   - Redaction metadata indicates redaction occurred
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn } from './provider.ts';
import { runWavemillLoop, type WavemillLoopConfig, type AgentContext } from './loop.ts';
import { TranscriptWriter } from './transcript.ts';
import type { Message, TextContent } from './messages.ts';
import { gitAfterToolCall, createGitTools } from './tools/git.ts';
import { createReadOnlyTools, READ_ONLY_PATH_FIELDS } from './tools/read-only.ts';
import { toPiAgentTool, type AgentTool, type AgentToolResult } from './tools/pi-adapter.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { ToolDescriptor } from './tools/types.ts';

// ---------------------------------------------------------------------------
// Seeded secret — must match the openai_key pattern: sk-[a-zA-Z0-9]{20,}
// ---------------------------------------------------------------------------
const SEEDED_SECRET = 'sk-smoketestFAKEKEY123456789012345678';

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

function setupFixtureRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'native-smoke-'));

  execFileSync('git', ['init', tmpDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'smoke@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Smoke Test'], { stdio: 'pipe' });

  // task-packet.md — no secret
  writeFileSync(join(tmpDir, 'task-packet.md'), [
    '# Task Packet',
    'Objective: Verify lifecycle smoke.',
    'Key file: source.ts',
  ].join('\n'));

  // plan.md — no secret
  writeFileSync(join(tmpDir, 'plan.md'), [
    '# Implementation Plan',
    '## Phase 1',
    '- Read source file',
    '- Check git status',
    '- Check diff',
  ].join('\n'));

  // source.ts — CONTAINS the seeded secret as a context line so git diff will expose it
  writeFileSync(join(tmpDir, 'source.ts'), [
    `// Source module`,
    `const API_KEY = '${SEEDED_SECRET}';`,
    `export function doSomething(): string {`,
    `  return 'result';`,
    `}`,
  ].join('\n'));

  execFileSync('git', ['-C', tmpDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', tmpDir, 'commit', '-m', 'initial commit'], { stdio: 'pipe' });

  // Modify source.ts so git diff has non-empty output showing the secret in context
  writeFileSync(join(tmpDir, 'source.ts'), [
    `// Source module`,
    `const API_KEY = '${SEEDED_SECRET}';`,
    `export function doSomething(): string {`,
    `  return 'result';`,
    `}`,
    `// helper added during smoke test`,
    `export function helper(): void {}`,
  ].join('\n'));

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Stub patch_file tool (should never execute — policy blocks it in planning)
// ---------------------------------------------------------------------------

function makePatchFilePiTool(): AgentTool<unknown, void> {
  return {
    name: 'patch_file',
    description: 'Write or patch a file (mutation — must be blocked in planning).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    label: 'patch_file',
    executionMode: 'sequential',
    async execute(_toolCallId: string): Promise<AgentToolResult<void>> {
      throw new Error('patch_file must never execute in planning phase — policy should have blocked it');
    },
  } as unknown as AgentTool<unknown, void>;
}

// ---------------------------------------------------------------------------
// Scripted provider turns
// ---------------------------------------------------------------------------

function makeTurns(): ScriptedPiProviderTurn[] {
  return [
    // Turn 1: read task-packet.md
    {
      content: [{ type: 'tool_call', id: 'tc-1', name: 'read_file', arguments: { path: 'task-packet.md' } }],
      stopReason: 'toolUse',
    },
    // Turn 2: read plan.md
    {
      content: [{ type: 'tool_call', id: 'tc-2', name: 'read_file', arguments: { path: 'plan.md' } }],
      stopReason: 'toolUse',
    },
    // Turn 3: read source.ts (contains the seeded secret)
    {
      content: [{ type: 'tool_call', id: 'tc-3', name: 'read_file', arguments: { path: 'source.ts' } }],
      stopReason: 'toolUse',
    },
    // Turn 4: git status
    {
      content: [{ type: 'tool_call', id: 'tc-4', name: 'git_status', arguments: {} }],
      stopReason: 'toolUse',
    },
    // Turn 5: git diff (diff context includes secret line)
    {
      content: [{ type: 'tool_call', id: 'tc-5', name: 'git_diff', arguments: {} }],
      stopReason: 'toolUse',
    },
    // Turn 6: attempt a mutation — must be blocked by policy
    {
      content: [{ type: 'tool_call', id: 'tc-6', name: 'patch_file', arguments: { path: 'notes.md', content: 'x' } }],
      stopReason: 'toolUse',
    },
    // Turn 7: acknowledge and stop
    {
      content: [{ type: 'text', text: 'Planning complete. All reads verified.' }],
      stopReason: 'stop',
    },
  ];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertNoSecretInJsonl(jsonlPath: string): void {
  const content = readFileSync(jsonlPath, 'utf-8');
  if (content.includes(SEEDED_SECRET)) {
    const lines = content.split('\n').filter(Boolean);
    const offending = lines.findIndex((l) => l.includes(SEEDED_SECRET));
    throw new Error(
      `FAIL: Seeded secret found in transcript JSONL at line ${offending + 1}\n` +
      `Line: ${lines[offending]?.slice(0, 200)}`,
    );
  }
}

function assertRedactionMetadata(jsonlPath: string): void {
  const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
  const toolResults = lines
    .map((l) => JSON.parse(l))
    .filter((e: { type?: string }) => e.type === 'tool_result');

  const withMeta = toolResults.filter(
    (e: { metadata?: { redaction?: { redacted?: boolean } } }) => e.metadata?.redaction?.redacted === true,
  );

  if (withMeta.length === 0) {
    throw new Error('FAIL: No tool_result events with redaction.redacted=true found in transcript');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const API = 'smoke-native-readonly';
  const smokeDir = mkdtempSync(join(tmpdir(), 'smoke-transcript-'));
  const transcriptPath = join(smokeDir, 'smoke.jsonl');

  console.log('[smoke] Setting up fixture git repo...');
  const worktree = setupFixtureRepo();

  try {
    const api = `${API}-${Date.now()}`;

    registerScriptedPiProvider({ api, turns: makeTurns() });

    // Build real tool descriptors
    const readOnlyDescriptors = createReadOnlyTools(worktree);
    const gitDescriptors = createGitTools(worktree);

    const registry = createToolRegistry([...readOnlyDescriptors, ...gitDescriptors]);

    // Pi tools: real tools + stub patch_file (so Pi doesn't reject the scripted call)
    const piTools: AgentTool<unknown, unknown>[] = [
      ...registry.getTools().map((d) => toPiAgentTool(d) as AgentTool<unknown, unknown>),
      makePatchFilePiTool() as AgentTool<unknown, unknown>,
    ];

    // Tool metadata registry for policy
    const allMeta = [
      ...registry.list(),
      // patch_file metadata — mutation class so policy blocks it in planning
      {
        name: 'patch_file',
        description: 'Write or patch a file',
        class: 'mutation' as const,
        allowedPhases: [] as const,
        executionMode: 'sequential' as const,
        outputCapPolicy: { strategy: 'none' as const },
      },
    ];

    const context: AgentContext = {
      systemPrompt: 'You are a planning agent. Read files and plan. Do not modify files.',
      messages: [{ role: 'user' as const, content: 'Begin planning.', timestamp: 0 }],
      tools: piTools,
    };

    const transcriptWriter = new TranscriptWriter({
      sessionId: 'smoke-session',
      model: 'smoke-model',
      api,
      provider: 'scripted',
      path: transcriptPath,
    });

    const loopConfig: WavemillLoopConfig = {
      model: { id: 'smoke-model', api, provider: 'scripted' },
      context,
      convertToLlm: (messages) => messages as unknown as Message[],
      afterToolCall: gitAfterToolCall,
      toolPolicy: {
        phase: 'planning',
        worktreePath: worktree,
        registry: allMeta,
        config: {
          pathFieldsByTool: READ_ONLY_PATH_FIELDS,
        },
      },
      onEvent: (event) => transcriptWriter.handleEvent(event),
    };

    console.log('[smoke] Running native agent loop (mock mode)...');
    // allow-stage-exit-identity: lifecycle smoke probe, not a task stage — no task budget applies (HOK-3492)
    const result = await runWavemillLoop(loopConfig);

    console.log(`[smoke] Loop result: stopReason=${result.stopReason} turns=${result.turnsCompleted} toolCallsExecuted=${result.toolCallsExecuted}`);

    // --- Assertions ---

    assert.equal(result.stopReason, 'stop', 'Loop must stop normally');

    // 5 tools execute (read × 3, git_status, git_diff); patch_file is policy-blocked
    assert.equal(result.toolCallsExecuted, 5, 'Exactly 5 tool calls must execute');

    // Transcript must not contain the seeded secret
    console.log('[smoke] Checking transcript for leaked secrets...');
    assertNoSecretInJsonl(transcriptPath);
    console.log('[smoke] OK: no seeded secret in transcript JSONL');

    // At least one tool result must have redaction metadata marking a redaction
    assertRedactionMetadata(transcriptPath);
    console.log('[smoke] OK: redaction metadata present in transcript');

    // Verify that tool result messages in the loop result also don't contain the seeded secret
    const allMessageText = JSON.stringify(result.messages);
    assert.ok(
      !allMessageText.includes(SEEDED_SECRET),
      'Seeded secret must not appear in loop result messages',
    );
    console.log('[smoke] OK: seeded secret absent from loop result messages');

    // Verify the denied patch_file result appears as an error in final messages
    const patchFileMsg = result.messages.find((m) => {
      const any = m as Record<string, unknown>;
      return any.role === 'toolResult' && any.toolName === 'patch_file';
    });
    assert.ok(patchFileMsg, 'patch_file must appear in messages as a policy-blocked tool error');
    assert.equal(
      (patchFileMsg as { content?: TextContent[] }).content?.[0]?.text,
      'phase_denied: tool "patch_file" is not allowed in planning',
    );
    assert.equal((patchFileMsg as { isError?: boolean }).isError, true);
    console.log('[smoke] OK: patch_file result present in messages (policy-blocked)');

    console.log('\n[smoke] All assertions passed. Native read-only lifecycle smoke PASSED.');

  } finally {
    // Clean up temp dirs
    try { rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(smokeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message ?? err);
  process.exit(1);
});
