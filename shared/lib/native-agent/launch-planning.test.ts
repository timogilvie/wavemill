import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { registerScriptedPiProvider, type ScriptedProviderContext } from './provider.ts';
import { describeNativePlanningHelperFailure, launchNativePlanning } from './launch-planning.ts';
import { resolvePiRuntimeVersions } from './pi-runtime-version.ts';
import { resolveSessionEventsDir } from './session-stream.ts';
import {
  parseNativePlanningApprovalCommand,
  resolveNativePlanningApprovalMode,
  runNativePlanningApprovalGate,
} from './planning-approval.ts';
import type { ToolDescriptor } from './tools/types.ts';
import type { ReadyNativeProviderEntry } from './providers.ts';

let apiSeq = 0;
function uniqueApi(label: string): string {
  apiSeq += 1;
  return `launch-planning-${label}-${apiSeq}`;
}

function setupWorktree(): { wtDir: string; featureDir: string; packetPath: string; sourcePath: string } {
  const wtDir = mkdtempSync(join(tmpdir(), 'native-planning-wt-'));
  execFileSync('git', ['init', wtDir], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.email', 'native@wavemill.test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'config', 'user.name', 'Native Planning Test'], { stdio: 'pipe' });

  const featureDir = join(wtDir, 'features', 'demo');
  const packetPath = join(featureDir, 'task-packet.md');
  const sourcePath = join(wtDir, 'src.ts');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(packetPath, [
    '# Task Packet',
    '## 1. Objective',
    'Wire native planning.',
    '## Success Criteria',
    '- planning completes',
  ].join('\n'));
  writeFileSync(sourcePath, 'export const value = 1;\n');
  execFileSync('git', ['-C', wtDir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wtDir, 'commit', '-m', 'fixture'], { stdio: 'pipe' });

  return { wtDir, featureDir, packetPath, sourcePath };
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function scriptedModel(api: string) {
  return {
    id: `scripted:${api}`,
    name: `scripted:${api}`,
    api,
    provider: 'scripted',
  } as const;
}

function validPlan(title = 'Implementation Plan'): string {
  return [
    `# ${title}`,
    '',
    '## Phase 1',
    '- Inspect the native planning launch path and relevant tests.',
    '- Implement bounded loop execution and deterministic validation.',
    '',
    '## Validation',
    '- Run targeted native planning and loop tests.',
    '',
    '## Release Readiness',
    '- **database_change_risk**: none',
    '- **env_changes**: none',
    '- **config_changes**: native planning limits only',
    '- **manual_steps**: none',
  ].join('\n');
}

function readyOpenRouterEntry(modelId: string, api: string): ReadyNativeProviderEntry {
  return {
    providerName: 'openrouter',
    modelId,
    status: 'ready',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: {},
    model: {
      ...scriptedModel(api),
      id: `openrouter:${modelId}`,
      name: modelId,
      provider: 'scripted',
    },
    certificationOnly: false,
  };
}

function stubRunTsxCommand(): (args: string[]) => string {
  return (args: string[]) => {
    const outputIndex = args.indexOf('--output');
    if (outputIndex >= 0) {
      writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
        planner: 'gpt-5.4',
        coder: 'gpt-5.4',
        reviewer: 'gpt-5.4',
        planDepth: 'light',
      }, null, 2)}\n`);
    }
    return '';
  };
}

function stubRunTsxCommandWithExpansion(
  expandedIssues: string[],
  expandArgs: string[][] = [],
): (args: string[]) => string {
  return (args: string[]) => {
    const command = basename(args[0] ?? '');
    const outputIndex = args.indexOf('--output');
    if (command === 'expand-issue.ts') {
      expandedIssues.push(args[1] ?? '');
      expandArgs.push(args);
      assert.ok(outputIndex >= 0, 'expand-issue must receive --output');
      writeFileSync(args[outputIndex + 1]!, [
        '# Task Packet',
        '## 1. Objective',
        'Plan the challenger workflow.',
        '## Success Criteria',
        '- packet expands from the canonical Linear issue',
      ].join('\n'));
      return '';
    }
    if (command === 'route-task.ts') {
      assert.ok(outputIndex >= 0, 'route-task must receive --output');
      writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
        planner: 'gpt-5.4',
        coder: 'gpt-5.4',
        reviewer: 'gpt-5.4',
        planDepth: 'light',
      }, null, 2)}\n`);
      return '';
    }
    throw new Error(`unexpected tsx command: ${args.join(' ')}`);
  };
}

function writeNativeConfig(
  repoDir: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function makeMutationTool(executed: { value: boolean }): ToolDescriptor {
  return {
    metadata: {
      name: 'write_source',
      description: 'Mutate source files.',
      class: 'mutation',
      allowedPhases: [] as const,
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' as const },
    },
    label: 'write_source',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute() {
      executed.value = true;
      return {
        content: [{ type: 'text', text: 'mutated' }],
      };
    },
  };
}

function collectOutput(): { writable: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  return {
    writable: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

function approvalFixture(): {
  dir: string;
  planPath: string;
  approvalMarkerPath: string;
  workflowAbortMarkerPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'native-planning-approval-'));
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, '# Plan\n\n## Release Readiness\n- **database_change_risk**: none\n');
  return {
    dir,
    planPath,
    approvalMarkerPath: join(dir, '.plan-approved'),
    workflowAbortMarkerPath: join(dir, '.workflow-aborted'),
  };
}

describe('native planning approval gate', () => {
  it('parses approval commands used by tmux operators', () => {
    assert.equal(parseNativePlanningApprovalCommand('approved'), 'approve');
    assert.equal(parseNativePlanningApprovalCommand('yes'), 'approve');
    assert.equal(parseNativePlanningApprovalCommand('reject'), 'reject');
    assert.equal(parseNativePlanningApprovalCommand('abort'), 'abort');
    assert.equal(parseNativePlanningApprovalCommand('status'), 'status');
    assert.equal(parseNativePlanningApprovalCommand(''), 'help');
    assert.equal(parseNativePlanningApprovalCommand('continue'), 'unknown');
  });

  it('defaults to external mode for non-TTY launchers', () => {
    const input = Readable.from([]);
    Object.defineProperty(input, 'isTTY', { value: false });
    assert.equal(resolveNativePlanningApprovalMode(undefined, input), 'external');
    assert.equal(resolveNativePlanningApprovalMode('interactive', input), 'interactive');
  });

  it('creates .plan-approved only after an explicit interactive approval command', async () => {
    const fixture = approvalFixture();
    const output = collectOutput();

    try {
      const result = await runNativePlanningApprovalGate({
        issue: 'HOK-2544',
        planPath: fixture.planPath,
        approvalMarkerPath: fixture.approvalMarkerPath,
        workflowAbortMarkerPath: fixture.workflowAbortMarkerPath,
        transcriptPath: join(fixture.dir, 'transcript.jsonl'),
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        mode: 'interactive',
        input: Readable.from(['approved\n']),
        output: output.writable,
      });

      assert.equal(result.decision, 'approved');
      assert.equal(existsSync(fixture.approvalMarkerPath), true);
      assert.equal(existsSync(fixture.workflowAbortMarkerPath), false);
      assert.match(output.text(), /Native plan ready for approval/);
      assert.match(output.text(), /Plan approved\. Created/);
    } finally {
      cleanup(fixture.dir);
    }
  });

  it('creates .workflow-aborted without approving when the operator aborts', async () => {
    const fixture = approvalFixture();
    const output = collectOutput();

    try {
      const result = await runNativePlanningApprovalGate({
        issue: 'HOK-2544',
        planPath: fixture.planPath,
        approvalMarkerPath: fixture.approvalMarkerPath,
        workflowAbortMarkerPath: fixture.workflowAbortMarkerPath,
        transcriptPath: join(fixture.dir, 'transcript.jsonl'),
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        mode: 'interactive',
        input: Readable.from(['abort\n']),
        output: output.writable,
      });

      assert.equal(result.decision, 'aborted');
      assert.equal(existsSync(fixture.approvalMarkerPath), false);
      assert.equal(existsSync(fixture.workflowAbortMarkerPath), true);
      assert.match(output.text(), /Workflow abort requested/);
    } finally {
      cleanup(fixture.dir);
    }
  });

  it('external mode prints marker instructions and does not approve', async () => {
    const fixture = approvalFixture();
    const output = collectOutput();

    try {
      const result = await runNativePlanningApprovalGate({
        issue: 'HOK-2544',
        planPath: fixture.planPath,
        approvalMarkerPath: fixture.approvalMarkerPath,
        workflowAbortMarkerPath: fixture.workflowAbortMarkerPath,
        transcriptPath: join(fixture.dir, 'transcript.jsonl'),
        provider: 'openrouter',
        model: 'z-ai/glm-5.2',
        mode: 'external',
        input: Readable.from([]),
        output: output.writable,
      });

      assert.equal(result.decision, 'external');
      assert.equal(existsSync(fixture.approvalMarkerPath), false);
      assert.equal(existsSync(fixture.workflowAbortMarkerPath), false);
      assert.match(output.text(), /Native planning is awaiting external approval/);
      assert.match(output.text(), new RegExp(`touch ${fixture.approvalMarkerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      cleanup(fixture.dir);
    }
  });
});

describe('launchNativePlanning', () => {
  it('writes plan.md, leaves approval to the monitor, and idles the native hook on success', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('success');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan(),
          }],
          stopReason: 'stop',
        }],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        title: 'Wire native planning',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(result.stopReason, 'stop');
      assert.equal(result.provider, 'scripted');
      assert.equal(result.model, `scripted:${api}`);
      const planPath = join(featureDir, 'plan.md');
      const plan = readFileSync(planPath, 'utf-8');
      assert.match(plan, /# Implementation Plan/);
      assert.match(plan, /## Release Readiness/);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'awaiting_user');
      assert.equal(stageResult.finishedAt, null);
      assert.equal(stageResult.agent, 'native');
      assert.equal(stageResult.model, `scripted:${api}`);
      assert.equal(stageResult.notes, 'Native planning ready for approval');
      // HOK-3164: native evidence carries the Pi runtime that ran the stage.
      assert.deepEqual(
        (stageResult.executionEvidence as Record<string, unknown>).piRuntimeVersions,
        { ...resolvePiRuntimeVersions() },
      );
      const sessionStarted = readdirSync(resolveSessionEventsDir(wtDir))
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => readFileSync(join(resolveSessionEventsDir(wtDir), name), 'utf-8').trim().split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.type === 'session_started');
      assert.equal(sessionStarted.length, 1);
      assert.deepEqual(sessionStarted[0].piRuntimeVersions, { ...resolvePiRuntimeVersions() });
      const artifacts = stageResult.artifacts as Record<string, any>;
      assert.equal(artifacts.type, 'planning');
      assert.equal(artifacts.planFile, 'features/demo/plan.md');
      assert.equal(artifacts.taskPacketFile, 'features/demo/task-packet.md');
      assert.equal(artifacts.planArtifactValid, true);
      assert.equal(artifacts.approvalReady, true);
      assert.equal(typeof artifacts.bounds?.maxTurns, 'number');
      assert.equal(typeof artifacts.bounds?.maxToolCalls, 'number');
      assert.equal(typeof artifacts.bounds?.maxWallClockMs, 'number');
      assert.equal(artifacts.usage?.turnsCompleted, 1);
      assert.equal(artifacts.usage?.toolCallsExecuted, 0);
      assert.equal(typeof artifacts.usage?.wallClockMs, 'number');
      assert.equal(typeof artifacts.usage?.totalInputTokens, 'number');
      assert.equal(typeof artifacts.usage?.totalOutputTokens, 'number');
      assert.equal(typeof artifacts.promptRef?.id, 'string');
      assert.equal(typeof artifacts.promptRef?.version, 'string');

      const hook = JSON.parse(readFileSync(result.hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'idle');
      assert.equal(hook.agent, 'native');
      assert.equal(hook.event, 'process_exit');
      assert.equal(hook.detail, 'planning_awaiting_user');
    } finally {
      cleanup(wtDir);
    }
  });

  it('fails before the provider when the prompt plus minimum reserved output exceeds the model context window', async () => {
    const { wtDir, featureDir, packetPath } = setupWorktree();
    const api = uniqueApi('context-window');
    const seen: ScriptedProviderContext[] = [];
    const hookPath = join(featureDir, 'native-planning.hook');
    writeFileSync(packetPath, `# Task Packet\n\n${'x'.repeat(50_000)}\n`, 'utf-8');

    try {
      registerScriptedPiProvider({
        api,
        turns: (context) => {
          seen.push(context);
          return {
            content: [{ type: 'text', text: validPlan('Unreachable Plan') }],
            stopReason: 'stop',
          };
        },
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'sess',
          issue: 'HOK-2772',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          title: 'Check context window',
          hookPath,
          loopModelOverride: {
            ...scriptedModel(api),
            contextWindow: 2_000,
          },
          runTsxCommand: stubRunTsxCommand(),
        }),
        /context window/,
      );

      assert.equal(seen.length, 0);
      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const hook = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'error');
      assert.match(String(hook.detail), /context_length_exceeded/);
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('clears approval markers that exist before native planning reaches awaiting_user', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('stale-approval-marker');
    writeFileSync(join(featureDir, '.plan-approved'), 'created too early\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Stale Approval Marker Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2544',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        title: 'Keep native planning approval gated',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'awaiting_user');
      assert.equal(stageResult.finishedAt, null);
    } finally {
      cleanup(wtDir);
    }
  });

  it('records structured failure outcome when native planning hits turn_limit', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('turn-limit');
    writeNativeConfig(wtDir, {
      nativeAgent: {
        planning: {
          maxTurns: 1,
          maxToolCalls: 120,
          maxWallClockMs: 60_000,
        },
      },
    });

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'tool_call',
            id: 'read-1',
            name: 'read_file',
            arguments: { path: 'src.ts' },
          }],
          stopReason: 'tool_calls',
        }],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'turn-limit',
          issue: 'HOK-2593',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /turn_limit/,
      );

      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.failureReason, 'turn_limit');
      assert.equal(stageResult.artifacts?.planArtifactValid, false);
      assert.equal(stageResult.artifacts?.approvalReady, false);
      assert.equal(stageResult.artifacts?.bounds?.maxTurns, 1);
      assert.equal(stageResult.artifacts?.usage?.turnsCompleted, 1);
      assert.equal(stageResult.artifacts?.usage?.toolCallsExecuted, 1);
      assert.equal(typeof stageResult.artifacts?.usage?.wallClockMs, 'number');
      assert.equal(typeof stageResult.artifacts?.promptRef?.id, 'string');
    } finally {
      cleanup(wtDir);
    }
  });

  it('preserves approval markers created after awaiting_user is published', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('approval-after-awaiting-user');
    const approvalMarkerPath = join(featureDir, '.plan-approved');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Approval Marker Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2544',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        title: 'Do not delete explicit approvals',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
        onAwaitingUserStagePublished: () => {
          writeFileSync(approvalMarkerPath, 'approved after awaiting_user\n');
        },
      });

      assert.equal(readFileSync(approvalMarkerPath, 'utf-8'), 'approved after awaiting_user\n');
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'awaiting_user');
    } finally {
      cleanup(wtDir);
    }
  });

  it('expands challenger task packets with the canonical Linear issue id', async () => {
    const { wtDir, featureDir, packetPath } = setupWorktree();
    const api = uniqueApi('challenger-linear-issue');
    const expandedIssues: string[] = [];
    const expandArgs: string[][] = [];
    writeFileSync(packetPath, 'raw challenger context without task packet sections\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Challenger Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        linearIssue: 'HOK-2464',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        title: 'Plan challenger',
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommandWithExpansion(expandedIssues, expandArgs),
      });

      assert.deepEqual(expandedIssues, ['HOK-2464']);
      // HOK-3115: a challenger expansion must never write the primary's Linear issue.
      assert.ok(expandArgs[0]?.includes('--no-update'), 'challenger expansion must pass --no-update');
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Challenger Plan/);
    } finally {
      cleanup(wtDir);
    }
  });

  it('falls back from a synthetic challenger id to the root Linear issue id during expansion', async () => {
    const { wtDir, packetPath } = setupWorktree();
    const api = uniqueApi('challenger-suffix-fallback');
    const expandedIssues: string[] = [];
    writeFileSync(packetPath, 'raw challenger context without task packet sections\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Challenger Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommandWithExpansion(expandedIssues),
      });

      assert.deepEqual(expandedIssues, ['HOK-2464']);
    } finally {
      cleanup(wtDir);
    }
  });

  it('materializes task-packet.md from structured selected-task.json before expanding', async () => {
    const { wtDir, featureDir, packetPath } = setupWorktree();
    const api = uniqueApi('selected-task-materialized');
    const helperCommands: string[] = [];
    rmSync(packetPath, { force: true });
    writeFileSync(join(featureDir, 'selected-task.json'), `${JSON.stringify({
      taskId: 'HOK-2464_c',
      title: 'Wavemill auto-advances blocked coding',
      description: [
        '# Wavemill Auto-Advances Blocked Coding - Quick Reference',
        '## Objective',
        'Add a liveness guard.',
        '## Success Criteria',
        '- no silent advance',
      ].join('\n'),
    }, null, 2)}\n`);

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Selected Task Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        linearIssue: 'HOK-2464',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: (args: string[]) => {
          helperCommands.push(basename(args[0] ?? ''));
          if (basename(args[0] ?? '') === 'expand-issue.ts') {
            throw new Error('expand should not run when selected-task has structured task content');
          }
          if (basename(args[0] ?? '') === 'route-task.ts') {
            const outputIndex = args.indexOf('--output');
            assert.ok(outputIndex >= 0, 'route-task must receive --output');
            writeFileSync(args[outputIndex + 1]!, `${JSON.stringify({
              planner: 'gpt-5.4',
              coder: 'gpt-5.4',
              reviewer: 'gpt-5.4',
              planDepth: 'light',
            }, null, 2)}\n`);
            return '';
          }
          throw new Error(`unexpected tsx command: ${args.join(' ')}`);
        },
      });

      assert.deepEqual(helperCommands, ['route-task.ts']);
      assert.match(readFileSync(packetPath, 'utf-8'), /Quick Reference/);
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Selected Task Plan/);
    } finally {
      cleanup(wtDir);
    }
  });

  it('normalizes helper ETIMEDOUT errors with command context', () => {
    const timeout = new Error('spawnSync npx ETIMEDOUT') as Error & { code: string };
    timeout.code = 'ETIMEDOUT';

    const error = describeNativePlanningHelperFailure(timeout, [
      '/wavemill/install/tools/expand-issue.ts',
      'HOK-2464',
      '--output',
      '/tmp/task-packet.md',
    ], 720000);

    assert.match(error.message, /Native planning helper timed out after 720000ms/);
    assert.match(error.message, /expand-issue\.ts HOK-2464 --output \/tmp\/task-packet\.md/);
    assert.doesNotMatch(error.message, /^spawnSync npx ETIMEDOUT$/);
  });

  it('selects the ready provider matching the routed OpenRouter alias', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const qwenApi = uniqueApi('qwen-provider');
    const kimiApi = uniqueApi('kimi-provider');

    try {
      registerScriptedPiProvider({
        api: qwenApi,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Wrong Provider'),
          }],
          stopReason: 'stop',
        }],
      });
      registerScriptedPiProvider({
        api: kimiApi,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Kimi Provider'),
          }],
          stopReason: 'stop',
        }],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2464_c',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        resolvedModel: 'kimi-k2.7-code',
        providerEntries: [
          readyOpenRouterEntry('qwen/qwen3-coder', qwenApi),
          readyOpenRouterEntry('moonshotai/kimi-k2.7-code', kimiApi),
        ],
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(result.model, 'moonshotai/kimi-k2.7-code');
      assert.match(readFileSync(join(featureDir, 'plan.md'), 'utf-8'), /# Kimi Provider/);
    } finally {
      cleanup(wtDir);
    }
  });

  it('denies a registered mutation tool and keeps source unchanged', async () => {
    const { wtDir, sourcePath } = setupWorktree();
    const api = uniqueApi('registered-mutation');
    const executed = { value: false };

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{
              type: 'tool_call',
              id: 'mut-1',
              name: 'write_source',
              arguments: { path: 'src.ts', content: 'export const value = 2;\n' },
            }],
            stopReason: 'toolUse',
          },
          {
            content: [{ type: 'text', text: validPlan('Registered Mutation Tool Plan') }],
            stopReason: 'stop',
          },
        ],
      });

      const result = await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        extraDescriptors: [makeMutationTool(executed)],
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(executed.value, false);
      assert.equal(readFileSync(sourcePath, 'utf-8'), 'export const value = 1;\n');
      const hook = JSON.parse(readFileSync(result.hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'idle');
      assert.equal(hook.event, 'process_exit');
      assert.equal(hook.detail, 'planning_awaiting_user');
    } finally {
      cleanup(wtDir);
    }
  });

  it('denies an unregistered mutation tool name', async () => {
    const { wtDir, sourcePath } = setupWorktree();
    const api = uniqueApi('unregistered-mutation');

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{
              type: 'tool_call',
              id: 'mut-2',
              name: 'patch_source',
              arguments: { path: 'src.ts', content: 'bad' },
            }],
            stopReason: 'toolUse',
          },
          {
            content: [{ type: 'text', text: validPlan('Unregistered Mutation Tool Plan') }],
            stopReason: 'stop',
          },
        ],
      });

      await launchNativePlanning({
        session: 'sess',
        issue: 'HOK-2313',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      assert.equal(readFileSync(sourcePath, 'utf-8'), 'export const value = 1;\n');
    } finally {
      cleanup(wtDir);
    }
  });

  it('writes an error hook and no approval marker when the final assistant text is empty', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('empty-final');
    const hookPath = `/tmp/wavemill-empty-final-${Date.now()}.hook`;

    try {
      registerScriptedPiProvider({
        api,
        turns: [{ content: [], stopReason: 'length' }],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'empty-final',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /without a final plan/,
      );

      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const hook = JSON.parse(readFileSync(hookPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(hook.state, 'error');
      assert.equal(hook.agent, 'native');
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('fails planning with tool_stagnation for repeated identical searches without approval artifacts', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('stagnant-search');
    const hookPath = `/tmp/wavemill-stagnant-search-${Date.now()}.hook`;
    writeNativeConfig(wtDir, {
      nativeAgent: {
        planning: {
          maxTurns: 10,
          maxToolCalls: 10,
          maxWallClockMs: 60_000,
          toolStagnation: {
            maxRepeatedSignatureCalls: 3,
            maxNoNovelProgressCalls: 2,
          },
        },
      },
    });

    try {
      registerScriptedPiProvider({
        api,
        turns: [
          {
            content: [{
              type: 'tool_call',
              id: 'search-1',
              name: 'search_text',
              arguments: { query: 'export const value', path: '.', maxResults: 5 },
            }],
            stopReason: 'tool_calls',
          },
          {
            content: [{
              type: 'tool_call',
              id: 'search-2',
              name: 'search_text',
              arguments: { maxResults: 5, path: '.', query: 'export const value' },
            }],
            stopReason: 'tool_calls',
          },
          {
            content: [{
              type: 'tool_call',
              id: 'search-3',
              name: 'search_text',
              arguments: { query: 'export const value', path: '.', maxResults: 5 },
            }],
            stopReason: 'tool_calls',
          },
          {
            content: [{ type: 'text', text: validPlan('Should Not Be Approved') }],
            stopReason: 'stop',
          },
        ],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'stagnant-search',
          issue: 'HOK-2577',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /tool_stagnation/,
      );

      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.failureReason, 'tool_stagnation');
      assert.ok(stageResult.artifacts?.transcriptFile);
      assert.equal(stageResult.artifacts?.planArtifactValid, false);
      assert.equal(stageResult.artifacts?.approvalReady, false);
      assert.equal(stageResult.artifacts?.bounds?.maxTurns, 10);
      assert.equal(stageResult.artifacts?.usage?.toolCallsExecuted, 3);
      assert.equal(existsSync(stageResult.artifacts.transcriptFile), true);
      assert.match(readFileSync(stageResult.artifacts.transcriptFile, 'utf-8'), /search_text/);
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('rejects tool-control final assistant text without publishing awaiting_user', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('control-text-final');
    const hookPath = `/tmp/wavemill-control-final-${Date.now()}.hook`;
    let awaitingPublished = false;
    writeFileSync(join(featureDir, 'plan.md'), 'stale plan\n');
    writeFileSync(join(featureDir, '.plan-approved'), 'stale approval\n');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: [
              '<|assistant to=functions.search_text|>{"query":"loop","path":"."}<|tool_call|>',
              'recipient_name: functions.search_text',
              'arguments_json: {"query":"loop"}',
            ].join('\n'),
          }],
          stopReason: 'stop',
        }],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'control-final',
          issue: 'HOK-2577',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
          onAwaitingUserStagePublished: () => {
            awaitingPublished = true;
          },
        }),
        /control_text_leakage/,
      );

      assert.equal(awaitingPublished, false);
      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      assert.equal(existsSync(join(featureDir, '.plan-approved')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.failureReason, 'invalid_final_plan');
      assert.equal(stageResult.artifacts?.validationError, 'control_text_leakage');
      assert.ok(stageResult.artifacts?.transcriptFile);
      assert.equal(stageResult.artifacts?.planArtifactValid, false);
      assert.equal(stageResult.artifacts?.approvalReady, false);
      assert.equal(stageResult.artifacts?.usage?.turnsCompleted, 1);
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('rejects final plans missing required release readiness fields', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('missing-readiness-final');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: [
              '# Missing Readiness Plan',
              '',
              '## Phase 1',
              '- Implement the scoped launcher changes.',
              '',
              '## Release Readiness',
              '- **database_change_risk**: none',
            ].join('\n'),
          }],
          stopReason: 'stop',
        }],
      });

      await assert.rejects(
        () => launchNativePlanning({
          session: 'missing-readiness',
          issue: 'HOK-2577',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
        }),
        /missing_release_readiness_env_changes/,
      );

      assert.equal(existsSync(join(featureDir, 'plan.md')), false);
      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, any>;
      assert.equal(stageResult.status, 'failed');
      assert.equal(stageResult.failureReason, 'invalid_final_plan');
      assert.equal(stageResult.artifacts?.validationError, 'missing_release_readiness_env_changes');
      assert.equal(stageResult.artifacts?.planArtifactValid, false);
      assert.equal(stageResult.artifacts?.approvalReady, false);
      assert.equal(stageResult.artifacts?.usage?.turnsCompleted, 1);
    } finally {
      cleanup(wtDir);
    }
  });

  it('writes cleanup details to the planning stage result on abort', async () => {
    const { wtDir, featureDir } = setupWorktree();
    const api = uniqueApi('aborted');
    const hookPath = `/tmp/wavemill-aborted-${Date.now()}.hook`;
    const controller = new AbortController();
    controller.abort();

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'aborted',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          hookPath,
          loopModelOverride: scriptedModel(api),
          runTsxCommand: stubRunTsxCommand(),
          signal: controller.signal,
        }),
        /aborted/,
      );

      const stageResult = JSON.parse(
        readFileSync(join(featureDir, '.planning-result.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(stageResult.status, 'aborted');
      assert.equal(stageResult.failureReason, 'aborted');
      assert.equal((stageResult.artifacts as Record<string, any>)?.planArtifactValid, false);
      assert.equal((stageResult.artifacts as Record<string, any>)?.approvalReady, false);
      assert.equal((stageResult.artifacts as Record<string, any>)?.usage?.turnsCompleted, 0);
      assert.equal(stageResult.finalTreeState, 'clean');
      assert.equal(stageResult.cleanupDecision, 'no-action-needed');
      assert.equal((stageResult.cleanupReport as Record<string, unknown>).reason, 'aborted');
    } finally {
      cleanup(wtDir);
      rmSync(hookPath, { force: true });
    }
  });

  it('rejects non-planning phases before launching the loop', async () => {
    const { wtDir } = setupWorktree();
    const api = uniqueApi('wrong-phase');

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'sess',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          phase: 'coding',
          loopModelOverride: scriptedModel(api),
        }),
        /planning phase/,
      );
    } finally {
      cleanup(wtDir);
    }
  });

  it('surfaces actionable provider-resolution failures when no planning provider is ready', async () => {
    const { wtDir } = setupWorktree();
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    writeNativeConfig(wtDir, {
      nativeAgent: {
        enabled: true,
        allowedPhases: ['planning'],
        providers: {
          openai: {
            models: ['uncertified-model'],
          },
        },
      },
    });

    try {
      await assert.rejects(
        () => launchNativePlanning({
          session: 'sess',
          issue: 'HOK-2313',
          slug: 'demo',
          wtDir,
          repoDir: wtDir,
          runTsxCommand: stubRunTsxCommand(),
        }),
        (error: unknown) => error instanceof Error
          && /Repo-local model configuration removed/.test(error.message)
          && /nativeAgent\.providers\.openai\.models/.test(error.message)
          && /wavemill config migrate-model-settings/.test(error.message),
      );
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      cleanup(wtDir);
    }
  });

  it('writes session events and tool decisions under the supplied repoDir only', async () => {
    const { wtDir } = setupWorktree();
    const api = uniqueApi('hermetic-repo-dir');

    try {
      registerScriptedPiProvider({
        api,
        turns: [{
          content: [{
            type: 'text',
            text: validPlan('Hermetic Repo Dir Plan'),
          }],
          stopReason: 'stop',
        }],
      });

      await launchNativePlanning({
        session: 'hermetic-sess',
        issue: 'HOK-3121',
        slug: 'demo',
        wtDir,
        repoDir: wtDir,
        loopModelOverride: scriptedModel(api),
        runTsxCommand: stubRunTsxCommand(),
      });

      const sessionEventsDir = join(wtDir, '.wavemill', 'session-events');
      assert.equal(existsSync(sessionEventsDir), true, 'session events dir should exist under the temp repo');
      const streams = readdirSync(sessionEventsDir).filter((name) => name.endsWith('.jsonl'));
      assert.ok(
        streams.some((name) => name.includes('hermetic-sess') && name.includes('HOK-3121')),
        `expected planning stream for hermetic-sess/HOK-3121 in ${streams.join(', ')}`,
      );

      const corpusPath = join(wtDir, '.wavemill', 'tool-decisions', 'corpus.jsonl');
      if (existsSync(corpusPath)) {
        const rows = readFileSync(corpusPath, 'utf-8')
          .split('\n')
          .filter((line) => line.trim() !== '');
        for (const line of rows) {
          const row = JSON.parse(line) as { model?: string; provider?: string };
          assert.ok(
            !(row.model?.startsWith('scripted:') || row.provider === 'scripted'),
            `scripted row leaked into corpus: ${line.slice(0, 120)}`,
          );
        }
      }
    } finally {
      cleanup(wtDir);
    }
  });
});
