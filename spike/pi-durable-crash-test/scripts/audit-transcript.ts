// HOK-3150 §3.3: audit a SQLite transcript after a crash+resume for the two
// invariants gates 1–3 depend on:
//
//   * exactlyOneResultPerCall  — for every tool-call id in an assistant
//                                entry there is exactly one pi.tool-result
//   * hasInterruptedForUnsafe  — some pi.tool-result diagnostic carries
//                                code "interrupted" (the unsafe-tool crash
//                                marker — see fromSlot in pi-durable's
//                                tool.js)
//
// Reads the DB by opening it through pi-durable without resuming. Prints a
// single-line JSON blob on stdout for crash-harness.ts to consume.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

async function main() {
  const dbPath = process.env.HOK3150_DB_PATH!;
  if (!dbPath) throw new Error('HOK3150_DB_PATH is required');

  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'audit' }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  // Note: do NOT resume(); we only want to read.
  const root = await harness.root(BACKGROUND_CONTEXT);

  // Pull all entries by paging history.
  const perCallResults = new Map<string, number>();
  const toolCalls = new Set<string>();
  let interrupted = false;
  let cursor: any = undefined;
  while (true) {
    const page = await root.entries({ newestFirst: false }, 500, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (entry.kind === 'pi.assistant') {
        const content = (entry.model?.[0] as any)?.content ?? [];
        for (const block of content) {
          if (block?.type === 'toolCall' && typeof block.id === 'string') {
            toolCalls.add(block.id);
          }
        }
      }
      if (entry.kind === 'pi.tool-result') {
        const message = (entry.model?.[0] as any);
        const callId = message?.toolCallId;
        if (typeof callId === 'string') {
          perCallResults.set(callId, (perCallResults.get(callId) ?? 0) + 1);
        }
        // Check for interrupted diagnostic
        const data: any = (entry as any).data;
        const diags = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
        for (const d of diags) {
          if (d?.code === 'interrupted') interrupted = true;
        }
      }
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }

  // The "exactly one result per call" invariant covers only call ids the
  // assistant actually emitted; an orphan result (seen for calls the model
  // did not ask for) is pi-durable allowing writes outside the loop.
  let exactlyOne = toolCalls.size > 0;
  for (const id of toolCalls) {
    if (perCallResults.get(id) !== 1) exactlyOne = false;
  }

  await harness.close(BACKGROUND_CONTEXT);

  console.log(JSON.stringify({
    exactlyOneResultPerCall: exactlyOne,
    hasInterruptedForUnsafe: interrupted,
    toolCalls: toolCalls.size,
    resultsPerCall: Object.fromEntries(perCallResults),
  }));
}

main().catch((err) => {
  console.error('audit-transcript failed:', err);
  console.log(JSON.stringify({ exactlyOneResultPerCall: false, hasInterruptedForUnsafe: false }));
  process.exit(0);
});
