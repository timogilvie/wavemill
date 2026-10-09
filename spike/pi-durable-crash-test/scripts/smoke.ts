// Minimal smoke test: verifies pi-durable 1.0.4 opens a SQLite storage, runs a
// faux-model turn with one tool call, closes, reopens, and sees the committed
// transcript. No real-provider calls.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pi-smoke-'));
  const dbPath = path.join(scratch, 'session.sqlite');
  const context = BACKGROUND_CONTEXT;

  // Faux provider with a scripted two-turn exchange: tool call, then final text.
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'spike-smoke' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('echo', { message: 'hi' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Done.')], { stopReason: 'stop' }),
  ]);

  // One tiny tool and one tiny section.
  const echo = defineTool({
    name: 'echo',
    description: 'Echo back the message.',
    parameters: Type.Object({ message: Type.String() }),
    replay: 'safe',
    execute: async (args) => {
      return { content: [{ type: 'text', text: `echo:${args.message}` }] };
    },
  });
  const ext = defineExtension({
    name: 'spike',
    tools: [echo],
    sections: [section('preamble', () => 'Smoke test.', { tag: false })],
  });

  const registry = createRegistry();
  registry.install(ext);

  // --- Launch 1: open storage, run one submission to settlement.
  let launch1Final = '';
  {
    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'spike-smoke' } },
    });
    const submission = await root.submit(
      { type: 'input', content: 'please echo', requestId: 'smoke:1' },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== 'done' || settled.type !== 'input') {
      throw new Error(`unexpected settlement: ${JSON.stringify(settled)}`);
    }
    const answer = await root.commit(
      (tx: any) => tx.entry(AssistantEntry, settled.answer),
      context,
    );
    const message = (answer?.model ?? [])[0] as any;
    const content = (message?.content ?? []) as Array<{ type: string; text?: string }>;
    launch1Final = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    await harness.close(context);
  }

  // --- Launch 2: reopen the same storage and read the transcript back.
  let launch2EntryCount = 0;
  let launch2Resumed = true;
  {
    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context);
    const view = await root.context(context);
    launch2EntryCount = view.entries.length;
    // Idempotent re-submit: same requestId should return the same submission.
    const resubmit = await root.submit(
      { type: 'input', content: 'please echo', requestId: 'smoke:1' },
      context,
    );
    const settled = await resubmit.status(context);
    launch2Resumed = settled.status === 'done';
    await harness.close(context);
  }

  await rm(scratch, { recursive: true, force: true });

  const result = {
    pass:
      launch1Final === 'Done.' &&
      launch2EntryCount >= 3 &&
      launch2Resumed,
    launch1Final,
    launch2EntryCount,
    launch2Resumed,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(2);
});
