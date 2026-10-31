/**
 * Bounded LLM cell-classification adapter (HOK-3361).
 * protects: schema-constrained validation, malformed/invalid responses,
 * transport failure, the bounded retry budget, and hashes-not-content.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CELL_LLM_MAX_ATTEMPTS,
  buildCellPrompt,
  classifyCellWithLlm,
  disabledCellLlmOutcome,
  hashDiff,
  hashPrompt,
  parseCellLlmResponse,
} from './cell-llm-adapter.ts';

const DIFF = 'diff --git a/shared/lib/x.ts b/shared/lib/x.ts\n+export const x = 1;\n';

describe('cell llm adapter', () => {
  it('protects: a schema-constrained response validates and records provenance hashes', async () => {
    const outcome = await classifyCellWithLlm({
      diff: DIFF,
      deps: { classify: async () => '{"layer":"wiring","lens":"correctness"}', model: 'test-model' },
    });
    assert.equal(outcome.decided, true);
    assert.equal(outcome.layer, 'wiring');
    assert.equal(outcome.lens, 'correctness');
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.reason_codes, []);
    assert.match(outcome.prompt_hash, /^[0-9a-f]{64}$/);
    assert.equal(outcome.diff_sha256, hashDiff(DIFF));
    assert.equal(outcome.model, 'test-model');
  });

  it('protects: a malformed response is a typed failure and retries within the bounded budget', async () => {
    let calls = 0;
    const outcome = await classifyCellWithLlm({
      diff: DIFF,
      deps: { classify: async () => { calls += 1; return 'not json at all'; } },
      maxAttempts: 2,
    });
    assert.equal(outcome.decided, false);
    assert.equal(calls, 2);
    assert.ok(outcome.reason_codes.includes('llm_retries_exhausted'));
    assert.ok(outcome.reason_codes.includes('llm_malformed_response'));
  });

  it('protects: a structurally invalid cell (bad layer/lens or extra keys) is llm_invalid_cell', () => {
    assert.equal(parseCellLlmResponse('{"layer":"cosmos","lens":"correctness"}').ok, false);
    assert.equal(parseCellLlmResponse('{"layer":"wiring","lens":"correctness","extra":1}').reason, 'llm_invalid_cell');
    assert.equal(parseCellLlmResponse('[1,2]').reason, 'llm_malformed_response');
    const fenced = parseCellLlmResponse('```json\n{"layer":"use","lens":"history"}\n```');
    assert.deepEqual(fenced.ok ? fenced : fenced, { ok: true, layer: 'use', lens: 'history' });
  });

  it('protects: a provider outage is llm_unavailable and never silently substituted', async () => {
    const outcome = await classifyCellWithLlm({
      diff: DIFF,
      deps: { classify: async () => { throw new Error('provider down'); } },
      maxAttempts: 2,
    });
    assert.equal(outcome.decided, false);
    assert.ok(outcome.reason_codes.includes('llm_unavailable'));
    assert.ok(outcome.reason_codes.includes('llm_retries_exhausted'));
  });

  it('protects: the default attempt budget is bounded', async () => {
    assert.equal(CELL_LLM_MAX_ATTEMPTS, 2);
    let calls = 0;
    await classifyCellWithLlm({
      diff: DIFF,
      deps: { classify: async () => { calls += 1; return 'garbage'; } },
    });
    assert.equal(calls, CELL_LLM_MAX_ATTEMPTS);
  });

  it('protects: raw diffs and prompts are never stored — only hashes and versions', async () => {
    const outcome = await classifyCellWithLlm({
      diff: DIFF,
      deps: { classify: async (prompt) => { assert.ok(prompt.includes('Corrective diff')); return '{"layer":"form","lens":"correctness"}'; } },
    });
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes('export const x'));
    assert.ok(!serialized.includes('diff --git'));
    assert.equal(outcome.prompt_hash, hashPrompt(buildCellPrompt({ diff: DIFF })));
  });

  it('protects: the disabled LLM channel records an explicit typed reason', () => {
    const outcome = disabledCellLlmOutcome(hashDiff(DIFF));
    assert.equal(outcome.decided, false);
    assert.deepEqual(outcome.reason_codes, ['llm_disabled']);
    assert.equal(outcome.attempts, 0);
    assert.equal(outcome.diff_sha256, hashDiff(DIFF));
  });
});