import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readStageResult } from '../stage-result.ts';
import { registerScriptedPiProvider, type ScriptedPiProviderTurn, type ScriptedProviderContext } from './provider.ts';
import { getCodingFailureHandoffPath, readCodingFailureHandoff } from './coding-failure-handoff.ts';
import {
  CODING_RECOVERY_INSTRUCTION_FILE,
  launchNativeCoding,
  renderCodingSystemPrompt,
  withCodingRecoveryInstruction,
} from './launch-coding.ts';
import type { ToolDescriptor } from './tools/types.ts';

const repos: string[] = [];

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(): { repoDir: string; featureDir: string; slug: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'native-coding-launch-'));
  repos.push(repoDir);
  const slug = 'native-coding-demo';
  const featureDir = join(repoDir, 'features', slug);
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(repoDir, 'src', 'app.ts'), "export const message = 'before';\n", 'utf-8');
  writeFileSync(join(featureDir, 'plan.md'), '# Plan\n\nUpdate src/app.ts.\n', 'utf-8');
  writeFileSync(join(featureDir, 'task-packet.md'), '# Task Packet\n\nImplement the change.\n', 'utf-8');
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.name', 'Wavemill Test']);
  git(repoDir, ['config', 'user.email', 'wavemill@example.com']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  return { repoDir, featureDir, slug };
}

function scriptedModel(turns: ScriptedPiProviderTurn[], label: string) {
  const api = `native-coding-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  registerScriptedPiProvider({ api, provider: 'scripted', turns });
  return {
    id: `scripted:${api}`,
    name: `scripted:${api}`,
    api,
    provider: 'scripted',
  };
}

function toolTurn(id: string, name: string, args: Record<string, unknown>): ScriptedPiProviderTurn {
  return {
    content: [{ type: 'tool_call', id, name, arguments: args }],
    usage: {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
  };
}

function finalTurn(text: string): ScriptedPiProviderTurn {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  };
}

function createRawFileTool(repoDir: string): ToolDescriptor<{ path: string; content: string }, { ok: true }> {
  return {
    metadata: {
      name: 'write_raw_file',
      description: 'Test-only tool that bypasses mutation validation.',
      class: 'mutation',
      allowedPhases: ['coding'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const target = join(repoDir, params.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `wrote ${params.path}` }],
        details: { ok: true },
      };
    },
  };
}

function archivedArtifactPath(featureDir: string, artifactName: string): string | undefined {
  const archiveRoot = join(featureDir, '.stale-artifacts');
  if (!existsSync(archiveRoot)) {
    return undefined;
  }
  for (const entry of readdirSync(archiveRoot)) {
    const candidate = join(archiveRoot, entry, artifactName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

afterEach(() => {
  for (const repoDir of repos.splice(0)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('launchNativeCoding', () => {
  it('renders NativePatch guidance in the native coding system prompt', () => {
    const prompt = renderCodingSystemPrompt({
      template: 'Implement {{SLUG}} at {{FEATURE_DIR}} with {{CODE_DEPTH}}.',
      codeDepth: 'medium',
      operatingMode: 'normal',
      featureDir: '/repo/features/demo',
      planPath: '/repo/features/demo/plan.md',
      slug: 'demo',
      blockedCompletionPath: 'features/demo/.coding-blocked-completion.json',
    });

    assert.match(prompt, /NativePatch envelope/);
    assert.match(prompt, /version/);
    assert.match(prompt, /atomic/);
    assert.match(prompt, /operations/);
    assert.match(prompt, /edit-diff/);
    assert.match(prompt, /"version": 1/);
  });

  it('runs a scripted native coding loop, commits a scoped patch, and records completion', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('read-1', 'read_file', { path: 'src/app.ts' }),
      toolTurn('patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('test-1', 'run_tests', { command: 'node -e "process.stdout.write(\\\"ok\\\")"' }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: update native coding fixture' }),
      toolTurn('artifact-1', 'write_artifact', {
        path: `features/${slug}/.coding-result.json`,
        content: JSON.stringify({
          type: 'coding',
          filesChanged: 1,
          linesAdded: 1,
          linesRemoved: 1,
          commitCount: 1,
        }),
      }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high","producer":"native-agent"}\n',
      }),
      finalTurn('Coding complete.'),
    ], 'complete');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2542',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
      branch: 'task/native-coding',
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'after';\n");
    assert.equal(git(repoDir, ['log', '--format=%s', '-n', '1']), 'feat: update native coding fixture');
    assert.ok(existsSync(join(featureDir, '.coding-complete')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'completed');
    assert.equal(stageResult?.artifacts?.type, 'coding');
    assert.equal(stageResult?.artifacts?.filesChanged, 1);
    assert.equal(stageResult?.artifacts?.commitCount, 1);
  });

  it('fails before the provider when the prompt plus reserved output exceeds the model context window', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, 'task-packet.md'), `# Task Packet\n\n${'x'.repeat(40_000)}\n`, 'utf-8');
    const seen: ScriptedProviderContext[] = [];
    const api = `native-coding-context-window-${process.pid}-${Date.now()}`;
    registerScriptedPiProvider({
      api,
      provider: 'scripted',
      turns: (context) => {
        seen.push(context);
        return finalTurn('unreachable');
      },
    });
    const model = {
      id: `scripted:${api}`,
      name: `scripted:${api}`,
      api,
      provider: 'scripted',
      // The packet above is 40k *characters*, which the estimator scores at
      // ~10k tokens. The loop shrinks max_tokens to fit before asserting, so
      // the guard only fires when the prompt cannot fit even at
      // minOutputTokens (1024). A 40k-token window leaves ~28k of headroom and
      // never trips it; 8k leaves none.
      contextWindow: 8_000,
    };
    const hookPath = join(featureDir, 'native-coding.hook');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2772',
        slug,
        wtDir: repoDir,
        repoDir,
        hookPath,
        loopModelOverride: model,
        branch: 'task/context-window',
      }),
      /context window/,
    );

    assert.equal(seen.length, 0);
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /context window/);
    const hook = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(hook.state, 'error');
    assert.match(String(hook.detail), /context_length_exceeded/);
  });

  it('writes a provider-error failure handoff and throws a classified message', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([{
      content: [{ type: 'text', text: 'I was about to continue.' }],
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: 'error',
      errorMessage: 'HTTP 402 Payment Required: can only afford 200 tokens',
    }], 'provider-error');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2841',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /provider-credit-exhausted: HTTP 402 Payment Required/,
    );

    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.reason, 'provider_error');
    assert.equal(handoff.value.recoveryAttempted, false);
    assert.equal(handoff.value.providerError?.kind, 'provider-credit-exhausted');
    assert.equal(handoff.value.providerError?.errorMessage, 'HTTP 402 Payment Required: can only afford 200 tokens');
    assert.equal(handoff.value.providerError?.turnsCompleted, 1);
  });

  it('accepts a valid blocked-completion handoff without writing .coding-complete', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'blocked';\n",
          }],
        },
      }),
      toolTurn('test-1', 'run_tests', { command: 'node -e "process.stdout.write(\\\"targeted-ok\\\")"' }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: blocked verification fixture' }),
      toolTurn('blocked-1', 'write_artifact', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: JSON.stringify({
          stage: 'coding',
          implementationComplete: true,
          committed: true,
          passingChecks: ['node -e targeted-ok'],
          blockingChecks: ['npm run typecheck'],
          blockingReason: 'baseline_tests_failing',
          evidence: 'Repo-level baseline failed outside the scoped change.',
          recommendedAction: 'advance_to_review',
        }),
      }),
      finalTurn('Coding blocked by baseline verification.'),
    ], 'blocked');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2542',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'blocked');
    assert.equal(existsSync(join(featureDir, '.coding-complete')), false);
    assert.ok(existsSync(join(featureDir, '.coding-blocked-completion.json')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'running');
    assert.match(stageResult?.notes ?? '', /blocked-completion/);
  });

  it('fails closed when a coding agent tries to write outside the worktree', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const outsidePath = join(repoDir, '..', 'outside-native-coding-marker');
    const model = scriptedModel([
      toolTurn('bad-marker-1', 'create_marker', {
        path: '../outside-native-coding-marker',
        content: '{"stage":"coding","confidence":"high"}\n',
      }),
      finalTurn('Tried to write outside.'),
      finalTurn('Still no completion marker.'),
    ], 'outside');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2542',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    assert.equal(existsSync(outsidePath), false);
    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (handoff.ok) {
      assert.equal(handoff.value.lastToolError?.tool, 'create_marker');
      assert.equal(handoff.value.recoveryAttempted, true);
    }
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /without \.coding-complete/);
  });

  it('recovers from Kimi-like invalid patches with the documented contract after a normal stop', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', {
        patch: {
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('bad-patch-2', 'apply_patch', {
        patch: { files: [{ path: 'src/app.ts', content: "export const message = 'after';\n" }] },
      }),
      finalTurn('I could not apply the patch.'),
      toolTurn('good-patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: recover native patch contract' }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high","producer":"native-agent"}\n',
      }),
      finalTurn('Recovered and completed.'),
    ], 'kimi-recover');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2580',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'after';\n");
    assert.equal(existsSync(getCodingFailureHandoffPath(featureDir)), false);
    const transcript = readFileSync(result.transcriptPath, 'utf-8');
    assert.match(transcript, /Valid NativePatch example/);
    assert.match(transcript, /\\"version\\": 1/);
  });

  it('recovers from a zero-tool normal stop without a completion artifact', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      finalTurn('I have planned the edit but stopped before acting.'),
      toolTurn('patch-1', 'apply_patch', {
        patch: {
          version: 1,
          atomic: true,
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'recovered';\n",
          }],
        },
      }),
      toolTurn('add-1', 'git_add', { paths: ['src/app.ts'] }),
      toolTurn('commit-1', 'git_commit', { message: 'feat: recover zero-tool stop' }),
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high","producer":"native-agent"}\n',
      }),
      finalTurn('Recovered and completed.'),
    ], 'zero-tool-recover');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2838',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(repoDir, 'src', 'app.ts'), 'utf-8'), "export const message = 'recovered';\n");
    assert.equal(existsSync(getCodingFailureHandoffPath(featureDir)), false);
  });

  it('writes no-artifact handoff only after zero-tool recovery is exhausted', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      finalTurn('I planned but did not act.'),
      finalTurn('I still did not create the required marker.'),
    ], 'zero-tool-handoff');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2838',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.reason, 'no_completion_artifact');
    assert.equal(handoff.value.mutationFailures, 0);
    assert.equal(handoff.value.lastToolError, null);
    assert.equal(handoff.value.recoveryAttempted, true);
  });

  it('retries after an invalid post-exit .coding-complete and preserves the malformed file', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('raw-invalid-complete', 'write_raw_file', {
        path: `features/${slug}/.coding-complete`,
        content: 'not a valid marker\n',
      }),
      finalTurn('Wrote malformed marker.'),
      toolTurn('valid-complete', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high"}\n',
      }),
      finalTurn('Rewrote marker.'),
    ], 'artifact-retry-complete');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2761',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
      extraDescriptors: [createRawFileTool(repoDir)],
    });

    assert.equal(result.completion, 'complete');
    assert.equal(readFileSync(join(featureDir, '.coding-complete'), 'utf-8'), '{\n  "stage": "coding",\n  "confidence": "high"\n}\n');
    assert.equal(readFileSync(join(featureDir, '.coding-complete.invalid-1'), 'utf-8'), 'not a valid marker\n');
  });

  it('fails after bounded artifact retries keep writing malformed completion markers', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('raw-invalid-complete-1', 'write_raw_file', {
        path: `features/${slug}/.coding-complete`,
        content: 'still invalid 1\n',
      }),
      finalTurn('Invalid once.'),
      toolTurn('raw-invalid-complete-2', 'write_raw_file', {
        path: `features/${slug}/.coding-complete`,
        content: 'still invalid 2\n',
      }),
      finalTurn('Invalid twice.'),
      toolTurn('raw-invalid-complete-3', 'write_raw_file', {
        path: `features/${slug}/.coding-complete`,
        content: 'still invalid 3\n',
      }),
      finalTurn('Invalid third time.'),
    ], 'artifact-retry-exhausted');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2761',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
        extraDescriptors: [createRawFileTool(repoDir)],
      }),
      /after 2 artifact retry attempt\(s\).*structured handoff: /,
    );

    assert.equal(existsSync(join(featureDir, '.coding-complete')), false);
    assert.equal(readFileSync(join(featureDir, '.coding-complete.invalid-1'), 'utf-8'), 'still invalid 1\n');
    assert.equal(readFileSync(join(featureDir, '.coding-complete.invalid-2'), 'utf-8'), 'still invalid 2\n');
    assert.equal(readFileSync(join(featureDir, '.coding-complete.invalid-3'), 'utf-8'), 'still invalid 3\n');
    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.reason, 'invalid_completion_artifact');
    assert.ok((handoff.value.validationErrors?.length ?? 0) > 0);
    assert.deepEqual(
      handoff.value.quarantinedArtifacts,
      [
        `features/${slug}/.coding-complete.invalid-1`,
        `features/${slug}/.coding-complete.invalid-2`,
        `features/${slug}/.coding-complete.invalid-3`,
      ],
    );
    assert.equal(handoff.value.recoveryAttempted, false);
    assert.equal(handoff.value.mutationFailures, 0);
    assert.equal(handoff.value.lastToolError, null);
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /structured handoff: /);
  });

  it('fails after bounded artifact retries keep writing malformed blocked-completion markers', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('raw-invalid-blocked-1', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: 'still invalid 1\n',
      }),
      finalTurn('Invalid once.'),
      toolTurn('raw-invalid-blocked-2', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: 'still invalid 2\n',
      }),
      finalTurn('Invalid twice.'),
      toolTurn('raw-invalid-blocked-3', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: 'still invalid 3\n',
      }),
      finalTurn('Invalid third time.'),
    ], 'artifact-retry-blocked-exhausted');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2761',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
        extraDescriptors: [createRawFileTool(repoDir)],
      }),
      /invalid \.coding-blocked-completion\.json after 2 artifact retry attempt\(s\).*structured handoff: /,
    );

    assert.equal(existsSync(join(featureDir, '.coding-blocked-completion.json')), false);
    assert.equal(readFileSync(join(featureDir, '.coding-blocked-completion.json.invalid-1'), 'utf-8'), 'still invalid 1\n');
    assert.equal(readFileSync(join(featureDir, '.coding-blocked-completion.json.invalid-2'), 'utf-8'), 'still invalid 2\n');
    assert.equal(readFileSync(join(featureDir, '.coding-blocked-completion.json.invalid-3'), 'utf-8'), 'still invalid 3\n');
    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.reason, 'invalid_completion_artifact');
    assert.ok((handoff.value.validationErrors?.length ?? 0) > 0);
    assert.deepEqual(
      handoff.value.quarantinedArtifacts,
      [
        `features/${slug}/.coding-blocked-completion.json.invalid-1`,
        `features/${slug}/.coding-blocked-completion.json.invalid-2`,
        `features/${slug}/.coding-blocked-completion.json.invalid-3`,
      ],
    );
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /structured handoff: /);
  });

  it('coerces repeated unverified blocked completion claims to non-complete after retries', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const unverifiedBlocked = JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      passingChecks: [],
      blockingChecks: ['npm test'],
      blockingReason: 'baseline_tests_failing',
      evidence: 'No scoped verification was executed.',
      recommendedAction: 'advance_to_review',
    }, null, 2);
    const model = scriptedModel([
      toolTurn('raw-unverified-1', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: unverifiedBlocked,
      }),
      finalTurn('Blocked with no evidence.'),
      toolTurn('raw-unverified-2', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: unverifiedBlocked,
      }),
      finalTurn('Still blocked with no evidence.'),
      toolTurn('raw-unverified-3', 'write_raw_file', {
        path: `features/${slug}/.coding-blocked-completion.json`,
        content: unverifiedBlocked,
      }),
      finalTurn('Still no evidence.'),
    ], 'artifact-unverified-coerce');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2761',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
      extraDescriptors: [createRawFileTool(repoDir)],
    });

    assert.equal(result.completion, 'blocked');
    assert.equal(existsSync(getCodingFailureHandoffPath(featureDir)), false);
    const saved = JSON.parse(readFileSync(join(featureDir, '.coding-blocked-completion.json'), 'utf-8'));
    assert.equal(saved.implementationComplete, false);
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'running');
    assert.match(stageResult?.notes ?? '', /coerced to false/);
  });

  it('writes a structured handoff when Kimi-like invalid patches are followed by another normal stop', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    const model = scriptedModel([
      toolTurn('bad-patch-1', 'apply_patch', {
        patch: {
          operations: [{
            op: 'edit',
            path: 'src/app.ts',
            oldText: "export const message = 'before';\n",
            newText: "export const message = 'after';\n",
          }],
        },
      }),
      finalTurn('I stopped without a marker.'),
      finalTurn('Still stopped without a marker.'),
    ], 'kimi-handoff');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2580',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json; last tool error \(apply_patch\/invalid_patch\): Patch payload did not match the NativePatch contract/,
    );

    const handoff = await readCodingFailureHandoff(getCodingFailureHandoffPath(featureDir));
    assert.equal(handoff.ok, true);
    if (!handoff.ok) return;
    assert.equal(handoff.value.lastToolError?.tool, 'apply_patch');
    assert.equal(handoff.value.lastToolError?.error, 'invalid_patch');
    assert.ok(handoff.value.mutationFailures >= 1);
    assert.equal(handoff.value.recoveryAttempted, true);
    assert.equal(handoff.value.reason, 'no_completion_artifact');
    assert.equal(handoff.value.validationErrors, undefined);
    assert.equal(handoff.value.quarantinedArtifacts, undefined);

    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
    assert.match(stageResult?.failureReason ?? '', /last tool error \(apply_patch\/invalid_patch\)/);
  });

  it('surfaces the dirty-handoff recovery instruction and never archives it (HOK-3128)', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, '.coding-complete'), '{"stage":"coding","confidence":"high"}\n', 'utf-8');
    writeFileSync(
      join(featureDir, CODING_RECOVERY_INSTRUCTION_FILE),
      'Your previous run left these paths uncommitted:\n- test-simple.ts\n',
      'utf-8',
    );
    const seen: ScriptedProviderContext[] = [];
    const api = `native-coding-recovery-${process.pid}-${Date.now()}`;
    registerScriptedPiProvider({
      api,
      provider: 'scripted',
      turns: (context) => {
        seen.push(context);
        return finalTurn('Stopped without writing a fresh marker.');
      },
    });

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-3128',
        slug,
        wtDir: repoDir,
        repoDir,
        issueContext: 'Issue Description:\nfix it',
        loopModelOverride: { id: `scripted:${api}`, name: `scripted:${api}`, api, provider: 'scripted' },
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    assert.ok(seen.length > 0);
    const firstUser = JSON.stringify(seen[0].messages);
    assert.match(firstUser, /## Recovery instruction/);
    assert.match(firstUser, /test-simple\.ts/);
    assert.ok(firstUser.indexOf('Recovery instruction') < firstUser.indexOf('Issue Description'));
    // The stale marker is archived; the monitor-owned instruction is not.
    assert.ok(archivedArtifactPath(featureDir, '.coding-complete'));
    assert.ok(existsSync(join(featureDir, CODING_RECOVERY_INSTRUCTION_FILE)));
    assert.equal(archivedArtifactPath(featureDir, CODING_RECOVERY_INSTRUCTION_FILE), undefined);
  });

  it('sweeps a pre-existing .coding-complete before classifying native completion', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, '.coding-complete'), '{"stage":"coding","confidence":"high","producer":"stale"}\n', 'utf-8');
    const model = scriptedModel([
      finalTurn('Stopped without writing a fresh marker.'),
    ], 'stale-complete');

    await assert.rejects(
      () => launchNativeCoding({
        session: 'sess',
        issue: 'HOK-2757',
        slug,
        wtDir: repoDir,
        repoDir,
        loopModelOverride: model,
      }),
      /without \.coding-complete or \.coding-blocked-completion\.json/,
    );

    assert.equal(existsSync(join(featureDir, '.coding-complete')), false);
    assert.ok(archivedArtifactPath(featureDir, '.coding-complete'));
    assert.ok(existsSync(getCodingFailureHandoffPath(featureDir)));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'failed');
  });

  it('sweeps a stale blocked-completion and accepts a fresh .coding-complete from the current run', async () => {
    const { repoDir, featureDir, slug } = makeRepo();
    writeFileSync(join(featureDir, '.coding-blocked-completion.json'), JSON.stringify({
      stage: 'coding',
      implementationComplete: true,
      committed: true,
      passingChecks: ['old check'],
      blockingChecks: ['old blocker'],
      blockingReason: 'old',
      evidence: 'old run',
      recommendedAction: 'advance_to_review',
    }), 'utf-8');
    const model = scriptedModel([
      toolTurn('marker-1', 'create_marker', {
        path: `features/${slug}/.coding-complete`,
        content: '{"stage":"coding","confidence":"high","producer":"native-agent"}\n',
      }),
      finalTurn('Coding complete.'),
    ], 'stale-blocked-fresh-complete');

    const result = await launchNativeCoding({
      session: 'sess',
      issue: 'HOK-2757',
      slug,
      wtDir: repoDir,
      repoDir,
      loopModelOverride: model,
    });

    assert.equal(result.completion, 'complete');
    assert.ok(archivedArtifactPath(featureDir, '.coding-blocked-completion.json'));
    assert.equal(existsSync(join(featureDir, '.coding-blocked-completion.json')), false);
    assert.ok(existsSync(join(featureDir, '.coding-complete')));
    const stageResult = await readStageResult(featureDir, 'coding');
    assert.equal(stageResult?.status, 'completed');
  });
});

describe('withCodingRecoveryInstruction (HOK-3128)', () => {
  it('returns the issue context unchanged when no recovery instruction exists', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'wm-recovery-'));
    try {
      assert.equal(withCodingRecoveryInstruction(featureDir, 'Issue Description:\nfix it'), 'Issue Description:\nfix it');
      assert.equal(withCodingRecoveryInstruction(featureDir, undefined), undefined);
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });

  it('prepends the monitor-written recovery instruction as a heading block', () => {
    const featureDir = mkdtempSync(join(tmpdir(), 'wm-recovery-'));
    try {
      writeFileSync(join(featureDir, CODING_RECOVERY_INSTRUCTION_FILE), 'Commit or discard:\n- test-simple.ts\n');
      const context = withCodingRecoveryInstruction(featureDir, 'Issue Description:\nfix it');
      assert.equal(context, '## Recovery instruction\nCommit or discard:\n- test-simple.ts\n\nIssue Description:\nfix it');
      assert.equal(
        withCodingRecoveryInstruction(featureDir, ''),
        '## Recovery instruction\nCommit or discard:\n- test-simple.ts\n',
      );
    } finally {
      rmSync(featureDir, { recursive: true, force: true });
    }
  });
});
