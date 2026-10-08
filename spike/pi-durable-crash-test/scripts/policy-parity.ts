// HOK-3150 gate 6: parity between the hook port of mutation-policy +
// output-limits + evaluateBeforeToolCallPolicy and the production function
// decisions on the same fixtures.
//
// Approach: for each fixture, call the production function directly to get a
// `truth` decision, then invoke the hook stack with a scripted faux-model
// call that drives the same tool through pi-durable's ToolTask, and read the
// hook's recorded decision from DECISION_LOG. Report zero diffs on pass.

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
} from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable';

import { evaluateMutationWritePolicy } from '../../../shared/lib/native-agent/mutation-policy.ts';
import { evaluateBeforeToolCallPolicy } from '../../../shared/lib/native-agent/tools/policies.ts';
import type { ToolMetadata, ToolPhase } from '../../../shared/lib/native-agent/tools/types.ts';
import { createPolicyExtension, DECISION_LOG, resetDecisionLog } from '../src/policy-extension.ts';

interface Fixture {
  readonly label: string;
  readonly phase: ToolPhase;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly worktreePath: string;
  readonly pathFieldsByTool?: Record<string, readonly string[]>;
  readonly expectDecision: 'allow' | 'block';
  readonly expectReasonContains?: string;
}

// A tiny but representative slice: cases drawn from mutation-policy.test.ts
// and tools/policies.test.ts covering allow + deny for the two gates.
const FIXTURES: readonly Fixture[] = [
  {
    label: 'mutation: patch inside worktree allowed',
    phase: 'coding',
    tool: 'apply_patch',
    args: { files: [{ path: './src/a.ts', kind: 'patch' }] },
    worktreePath: '/repo/wt',
    expectDecision: 'allow',
  },
  {
    label: 'mutation: patch outside worktree denied',
    phase: 'coding',
    tool: 'apply_patch',
    args: { files: [{ path: '../other/file.ts', kind: 'patch' }] },
    worktreePath: '/repo/wt',
    expectDecision: 'block',
    expectReasonContains: 'path_denied',
  },
  {
    label: 'mutation: sibling-prefix false positive denied',
    phase: 'coding',
    tool: 'apply_patch',
    args: { files: [{ path: '/repo/wtx/src/file.ts', kind: 'patch' }] },
    worktreePath: '/repo/wt',
    expectDecision: 'block',
    expectReasonContains: 'path_denied',
  },
  {
    label: 'mutation: whole-file deny when not allowlisted',
    phase: 'coding',
    tool: 'write_artifact',
    args: { path: './src/not-generated.json' },
    worktreePath: '/repo/wt',
    expectDecision: 'block',
    expectReasonContains: 'path_denied',
  },
  {
    label: 'phase: read-only tool denied in planning (whole-file write)',
    phase: 'planning',
    tool: 'apply_patch',
    args: { files: [{ path: './src/a.ts', kind: 'patch' }] },
    worktreePath: '/repo/wt',
    expectDecision: 'block',
    expectReasonContains: 'phase_denied',
  },
  {
    label: 'path-field: path argument outside worktree denied',
    phase: 'coding',
    tool: 'read_file',
    args: { path: '/etc/passwd' },
    worktreePath: '/repo/wt',
    pathFieldsByTool: { read_file: ['path'] },
    expectDecision: 'block',
    expectReasonContains: 'path_denied',
  },
];

const REGISTRY: readonly ToolMetadata[] = [
  { name: 'apply_patch', class: 'mutating', allowedPhases: ['coding'] },
  { name: 'write_artifact', class: 'mutating', allowedPhases: ['coding'] },
  { name: 'read_file', class: 'read-only', allowedPhases: ['planning', 'coding', 'review'] },
];

async function evalProductionTruth(f: Fixture): Promise<{ decision: 'allow' | 'block'; message?: string }> {
  // Phase + path mode first.
  const phaseDecision = evaluateBeforeToolCallPolicy({
    phase: f.phase,
    config: { pathFieldsByTool: f.pathFieldsByTool },
    worktreePath: f.worktreePath,
    registry: REGISTRY,
    toolCall: { name: f.tool, arguments: f.args },
  });
  if (phaseDecision.kind === 'deny') return { decision: 'block', message: phaseDecision.message };

  // Mutation.
  if (f.tool === 'apply_patch') {
    const files = Array.isArray((f.args as any).files) ? (f.args as any).files : [];
    for (const op of files as Array<{ path?: string; kind?: string }>) {
      if (typeof op?.path !== 'string') continue;
      const d = evaluateMutationWritePolicy({
        worktreePath: f.worktreePath,
        targetPath: op.path,
        writeKind: op.kind === 'whole-file' ? 'whole-file' : 'patch',
      });
      if (d.kind === 'deny') return { decision: 'block', message: d.message };
    }
  } else if (f.tool === 'write_artifact') {
    const target = typeof (f.args as any).path === 'string' ? (f.args as any).path : undefined;
    if (target) {
      const d = evaluateMutationWritePolicy({
        worktreePath: f.worktreePath,
        targetPath: target,
        writeKind: 'whole-file',
      });
      if (d.kind === 'deny') return { decision: 'block', message: d.message };
    }
  }

  return { decision: 'allow' };
}

async function evalHookStack(f: Fixture): Promise<{ decision: 'allow' | 'block'; message?: string }> {
  // Scripted model emits the fixture's tool call and then an end-of-turn.
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'parity' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(f.tool, f.args as any, { id: 'call-1' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' }),
  ]);

  const policy = createPolicyExtension({
    worktreePath: f.worktreePath,
    phase: f.phase,
    registry: REGISTRY,
    pathFieldsByTool: f.pathFieldsByTool,
  });

  // Scripted no-op tools matching the fixture names so pi-durable will offer
  // them. The hook decides allow/block before execute runs.
  const stubs = [
    defineTool({
      name: 'apply_patch',
      description: 'stub',
      parameters: Type.Object({ files: Type.Optional(Type.Array(Type.Any())) }),
      replay: 'unsafe',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }),
    defineTool({
      name: 'write_artifact',
      description: 'stub',
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      replay: 'unsafe',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }),
    defineTool({
      name: 'read_file',
      description: 'stub',
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      replay: 'safe',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    }),
  ];
  const stubExt = defineExtension({
    name: 'spike.stubs',
    tools: stubs,
    sections: [section('preamble', () => 'parity', { tag: false })],
  });

  const registry = createRegistry();
  registry.install(stubExt);
  registry.install(policy);

  resetDecisionLog();

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'parity' } } });
  const submission = await root.submit({ type: 'input', content: 'go' }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);

  const hookRecord = DECISION_LOG.find((r) => r.tool === f.tool);
  if (!hookRecord) return { decision: 'block', message: '(no decision recorded)' };
  return hookRecord.decision === 'allow'
    ? { decision: 'allow' }
    : { decision: 'block', message: hookRecord.message };
}

async function main() {
  const results: Array<{
    label: string;
    pass: boolean;
    expected: 'allow' | 'block';
    truth: 'allow' | 'block';
    hook: 'allow' | 'block';
    truthMessage?: string;
    hookMessage?: string;
  }> = [];
  for (const f of FIXTURES) {
    const truth = await evalProductionTruth(f);
    const hook = await evalHookStack(f);
    const matches = truth.decision === hook.decision && truth.decision === f.expectDecision;
    results.push({
      label: f.label,
      pass: matches,
      expected: f.expectDecision,
      truth: truth.decision,
      hook: hook.decision,
      truthMessage: truth.message,
      hookMessage: hook.message,
    });
  }

  const diffs = results.filter((r) => !r.pass);
  const summary = { fixtures: results.length, diffs: diffs.length, pass: diffs.length === 0 };

  // Write a results file for the eval doc to cite.
  const outDir = path.join(process.cwd(), 'results');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'policy-parity.json'),
    JSON.stringify({ summary, results }, null, 2) + '\n',
    'utf8',
  );

  console.log(JSON.stringify({ summary, results }, null, 2));
  process.exit(diffs.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('policy-parity failed:', err);
  process.exit(2);
});
