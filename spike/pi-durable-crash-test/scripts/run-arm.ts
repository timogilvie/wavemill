// HOK-3150 P1/P2/P4 child: open SQLite storage, run or resume one submission.
//
// Env knobs the parent sets:
//   HOK3150_DB_PATH         absolute SQLite path for the Harness
//   HOK3150_WORKTREE        absolute worktree dir
//   HOK3150_FEATURE_DIR     absolute features/<slug> dir
//   HOK3150_READY_FILE      file crash-points writes before blocking
//   HOK3150_EXEC_LOG        append-only JSONL of (name, callId, pid, t)
//   HOK3150_FAUX_SCRIPT     JSON file of scripted faux responses (parent built)
//   HOK3150_REQUEST_ID      submission requestId (idempotence)
//   HOK3150_CRASH_POINT     A | B | C1 | C2 | C3 | none
//   HOK3150_MODE            fresh | resume
//
// Prints the final state JSON on stdout: { settled, workedPartial, resumed }.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import { buildCodingExtension, SPIKE_TOOL_NAMES } from '../src/coding-arm.ts';
import { assertReplayLabelsCover } from '../src/replay-labels.ts';
import { readCrashPoint } from '../src/crash-points.ts';
import { createPolicyExtension } from '../src/policy-extension.ts';

interface FauxStep {
  readonly kind: 'tool' | 'text' | 'partial';
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly text?: string;
  readonly delayMs?: number;
}

async function main() {
  const dbPath = required('HOK3150_DB_PATH');
  const worktree = required('HOK3150_WORKTREE');
  const featureDir = required('HOK3150_FEATURE_DIR');
  const readyFile = required('HOK3150_READY_FILE');
  const execLog = required('HOK3150_EXEC_LOG');
  const scriptFile = required('HOK3150_FAUX_SCRIPT');
  const requestId = required('HOK3150_REQUEST_ID');
  const crashPoint = readCrashPoint(process.env);
  const mode = process.env.HOK3150_MODE ?? 'fresh';

  // Replay-label coverage check (plan.md §2.2 last sentence).
  assertReplayLabelsCover(SPIKE_TOOL_NAMES);

  const script = JSON.parse(await readFile(scriptFile, 'utf8')) as FauxStep[];
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'spike' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  // Durable scripted provider: a single factory inspects the message history
  // (which pi-durable rebuilds from the SQLite transcript on every restart)
  // and chooses the response matching the number of pi.tool-result messages
  // already committed. This makes the "faux" model deterministic across
  // crashes, which is the only way to compare resume vs relaunch.
  const script2: FauxStep[] = script;
  const responses: any[] = [];
  for (let k = 0; k < script2.length * 3 + 2; k += 1) {
    responses.push((context: any) => {
      const results = (context?.messages ?? []).filter(
        (m: any) => m?.role === 'toolResult',
      ).length;
      const idx = Math.min(results, script2.length - 1);
      const step = script2[idx];
      if (step.kind === 'tool') {
        return fauxAssistantMessage(
          fauxToolCall(step.name!, step.args as any, { id: `t${idx}-${step.name}` }),
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage([fauxText(step.text ?? 'done')], { stopReason: 'stop' });
    });
  }
  faux.setResponses(responses);

  const codingExt = buildCodingExtension({
    worktree,
    featureDir,
    crashPoint,
    readyFile,
    executeLogPath: execLog,
  });

  const policyExt = createPolicyExtension({
    worktreePath: worktree,
    phase: 'coding',
    registry: [
      { name: 'read_file', class: 'read-only', allowedPhases: ['coding'] },
      { name: 'list_files', class: 'read-only', allowedPhases: ['coding'] },
      { name: 'search_text', class: 'read-only', allowedPhases: ['coding'] },
      { name: 'apply_patch', class: 'mutating', allowedPhases: ['coding'] },
      { name: 'write_artifact', class: 'mutating', allowedPhases: ['coding'] },
    ],
    wholeFileAllowlist: {
      wavemillOwnedPaths: ['features/**'],
    },
  });

  const registry = createRegistry();
  registry.install(codingExt);
  registry.install(policyExt);

  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? worktree }),
    },
    BACKGROUND_CONTEXT,
  );

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'spike' }, cwd: worktree },
  });

  // For crash point A, subscribe to pi.live and signal when a partial
  // appears (an assistant generation is in-flight with pending content).
  if (crashPoint === 'A') {
    void (async () => {
      const view = await root.viewState(BACKGROUND_CONTEXT);
      view.subscribe((v: any) => {
        const live = v?.docs?.['pi.live'];
        const gen = live?.generation ?? live?.generations?.[0];
        if (gen && gen.message && Array.isArray(gen.message.content) && gen.message.content.length > 0) {
          void writeFile(
            readyFile,
            JSON.stringify({ point: 'A', pid: process.pid, t: Date.now() }) + '\n',
            'utf8',
          ).catch(() => {});
        }
      });
    })();
  }

  harness.resume(); // kick the scheduler for the fresh case too

  const submission = await root.submit(
    { type: 'input', content: 'carry out the plan', requestId },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);

  const out = {
    settled: settled.status,
    reason: (settled as any).reason,
    detail: (settled as any).detail,
    mode,
    pid: process.pid,
    crashPoint,
  };
  console.log(JSON.stringify(out));
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

main().catch((err) => {
  console.error('run-arm failed:', err);
  process.exit(1);
});
