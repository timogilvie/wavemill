import { createProviderContributionReplay } from '../../../tests/fixtures/provider-evidence/contribution-replay.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { NativeSessionAdapter } from '../session-adapters.ts';
import { appendOwnershipRow, locateLaunchHistory, getSdkMeteringProjection } from '../session-ownership.ts';
import { challengerTaskId } from '../task-identity.ts';
import { attachWorkflowCostMetadata } from '../eval-record-builder.ts';
import { validateEvalRecord } from '../eval-validator.ts';
import type { EvalRecord } from '../eval-schema.ts';
import type { OpenRouterGenerationCost } from '../openrouter-generation-api.ts';
import { mergeNativeProviderExecutions } from '../workflow-cost.ts';
import { meterWorkflowCost } from './meter.ts';

// allow-source-text-assertion: JSON input fixture, not implementation source; assertions exercise the real adapter and meter.
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/provider-evidence/reconstructed-generations.json', import.meta.url), 'utf8')) as {
  generations: Record<string, OpenRouterGenerationCost>;
};
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function replay(ids: string[], lookup = true, discoverByOwnership = false) {
  const repo = mkdtempSync(join(tmpdir(), 'provider-evidence-'));
  roots.push(repo);
  const state = join(repo, 'features', 'provider');
  const transcripts = join(repo, '.wavemill', 'runs', 'test', 'native-sessions');
  mkdirSync(transcripts, { recursive: true });
  for (const [index, id] of ids.entries()) {
    const sessionId = `session-${index}`;
    appendOwnershipRow(state, { sessionRef: sessionId, harness: 'native', kind: 'coding', model: 'kimi-k3',
      attemptId: `attempt-${index}`, launchedAt: '2026-11-15T12:00:00Z' });
    const fileIssue = discoverByOwnership ? challengerTaskId('HOK-3495') : 'HOK-3495';
    writeFileSync(join(transcripts, `coding-${fileIssue}-${index}.jsonl`), [
      { seq: 0, sessionId, timestamp: 1, type: 'session_started', model: 'kimi-k3', provider: 'openrouter', worktreePath: repo },
      { seq: 1, sessionId, timestamp: 2, type: 'assistant_message', model: 'kimi-k3', responseModel: 'moonshotai/kimi-k3', responseId: id,
        providerRequest: { requestedRouting: { only: ['host-a'], allow_fallbacks: false }, pricingSnapshot: { scope: 'model', inputCostPerMTok: 3, outputCostPerMTok: 16 } },
        stopReason: index === 0 ? 'error' : 'end_turn', usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010 } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
  }
  writeFileSync(join(transcripts, 'coding-HOK-9999.jsonl'), [
    { sessionId: 'foreign', type: 'session_started', model: 'kimi-k3', provider: 'openrouter' },
    { sessionId: 'foreign', type: 'assistant_message', responseId: 'gen-foreign', usage: { input: 9000000, output: 1 } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const scanned = new NativeSessionAdapter().scan({ worktreePath: repo, repoDir: repo, branchName: 'task/provider', issueId: 'HOK-3495',
    sessionRefs: ids.map((_, index) => `session-${index}`) });
  assert.equal(scanned?.nativeSessions?.length, ids.length);
  const seen: string[] = [];
  const result = await meterWorkflowCost({
    worktreePath: repo, repoDir: repo, branchName: 'task/provider', issueId: 'HOK-3495', slug: 'provider',
    // Duplicate archive discovery must not duplicate either billing or evidence.
    ...(discoverByOwnership ? {} : { nativeSessions: [...scanned!.nativeSessions!, ...structuredClone(scanned!.nativeSessions!)] }),
    pricingTable: { 'kimi-k3': { inputCostPerMTok: 3, outputCostPerMTok: 16, cacheReadCostPerMTok: 0.3 } },
    exactPricing: { enabled: lookup, fetchGenerationCost: async id => { seen.push(id); return fixture.generations[id] ?? null; } },
    roots: { claude: [], codex: [] }, label: 'test', logger: { log() {}, warn() {} },
  });
  assert.equal(result.outcome.status, 'success');
  if (result.outcome.status !== 'success') throw new Error('measurement failed');
  return { outcome: result.outcome, seen };
}

describe('owned provider execution evidence (HOK-3495)', () => {
  it('canonical issue filename filtering cannot exclude owned challenger sessions or include a sibling', async () => {
    const { outcome, seen } = await replay(['gen-failed', 'gen-success'], true, true);
    assert.equal(outcome.totalCostUsd, 1.5);
    assert.equal(outcome.nativeProviderExecutions?.length, 2);
    assert.deepEqual(seen.sort(), ['gen-failed', 'gen-success']);
  });
  it('retains failed and successful attempts, charges each response once, and persists validated eval evidence', async () => {
    const { outcome, seen } = await replay(['gen-failed', 'gen-success']);
    assert.equal(outcome.totalCostUsd, 1.5, 'both attempts are charged through the SDK, not model reference rates');
    assert.deepEqual(seen.sort(), ['gen-failed', 'gen-success']);
    assert.equal(outcome.nativeProviderExecutions?.length, 2);
    assert.deepEqual(outcome.nativeProviderExecutions?.map(row => row.generation?.providerName), ['Host A', 'Host B']);
    assert.deepEqual(outcome.nativeProviderExecutions?.map(row => row.ownershipAttemptIds), [['attempt-0'], ['attempt-1']]);
    assert.equal(outcome.nativeProviderExecutions?.[0].requestedModel, 'kimi-k3');
    assert.deepEqual(outcome.nativeProviderExecutions?.[0].requestedRouting, { only: ['host-a'], allow_fallbacks: false });
    assert.equal(outcome.nativeProviderExecutions?.[0].pricingSnapshot?.scope, 'model');
    assert.equal(outcome.nativeProviderExecutions?.[0].responseModel, 'moonshotai/kimi-k3');

    // allow-source-text-assertion: historical JSON eval fixture, not implementation source; validate its enriched record through the real schema.
    const { record } = JSON.parse(readFileSync(new URL('../../../tests/fixtures/contribution-v4-replay/hok-3385.json', import.meta.url), 'utf8')) as { record: EvalRecord };
    attachWorkflowCostMetadata(record, outcome);
    attachWorkflowCostMetadata(record, outcome);
    assert.equal(record.nativeProviderExecutions?.length, 2, 'reattachment is idempotent');
    const roundtrip = JSON.parse(JSON.stringify(record));
    const violations = validateEvalRecord(roundtrip, { file: 'replay', line: 1 }).filter(issue => issue.code === 'SCHEMA_VIOLATION');
    assert.deepEqual(violations, []);
    roundtrip.nativeProviderExecutions[0].generation.totalCostUsd = -1;
    assert.ok(validateEvalRecord(roundtrip, { file: 'replay', line: 1 }).some(issue => issue.code === 'SCHEMA_VIOLATION'));
  });

  it('keeps host evidence when billing is pending and uses the existing SDK estimate', async () => {
    const { outcome } = await replay(['gen-pending']);
    assert.equal(outcome.nativeProviderExecutions?.[0].generation?.providerName, 'Host B');
    assert.equal(outcome.nativeProviderExecutions?.[0].generation?.totalCostUsd, null);
    assert.ok(outcome.totalCostUsd > 0);
    assert.ok(outcome.attribution?.models.some(model => model.pricingSource === 'local_estimate'));
  });

  it('does not invent a host from the wire id when lookup is unavailable', async () => {
    const { outcome, seen } = await replay(['gen-unknown'], false);
    assert.deepEqual(seen, []);
    assert.equal(outcome.nativeProviderExecutions?.[0].generation, null);
    assert.equal(outcome.nativeProviderExecutions?.[0].responseModel, 'moonshotai/kimi-k3');
    assert.ok(outcome.totalCostUsd > 0);
  });

  it('late incomplete enrichment cannot erase a known charge or response model', async () => {
    const { outcome } = await replay(['gen-failed']);
    const original = outcome.nativeProviderExecutions!;
    const incomplete = [{ ...original[0], responseModel: null, generation: { totalCostUsd: null } }];
    assert.deepEqual(mergeNativeProviderExecutions(original, incomplete), original);
    assert.deepEqual(mergeNativeProviderExecutions(original, [{ ...incomplete[0], generation: null }]), original);
  });
});

// protects: historical reused sessions retain retry identity without charging their transcript twice.
it('lossless ownership retains every launch while the SDK projection bills a reused session once', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'provider-launch-history-'));
  roots.push(repo);
  const state = join(repo, 'features', 'provider');
  for (const attemptId of ['attempt-1', 'attempt-2']) appendOwnershipRow(state, {
    sessionRef: 'reused', harness: 'native', kind: 'coding', model: 'kimi-k3', attemptId,
    launchedAt: attemptId === 'attempt-1' ? '2026-11-15T12:00:00Z' : '2026-11-15T12:01:00Z',
  });
  const history = locateLaunchHistory({ repoDir: repo, slug: 'provider' });
  assert.equal(history.rows.length, 2);
  assert.equal(getSdkMeteringProjection(history.rows).length, 1);
  const warnings: string[] = [];
  const result = await meterWorkflowCost({ repoDir: repo, worktreePath: repo, branchName: '', slug: 'provider', label: 'reused',
    roots: { claude: [], codex: [] }, logger: { log() {}, warn(message) { warnings.push(message); } },
    exactPricing: { enabled: true, fetchGenerationCost: async () => ({ totalCostUsd: 0.5, providerName: 'Host A' }) },
    nativeSessions: [{ sessionId: 'reused', provider: 'openrouter', requestedModel: 'kimi-k3', modelId: 'kimi-k3', filePath: 'coding.jsonl', responseIds: ['gen-reused'], turns: [
      { responseId: 'gen-reused', responseModel: 'moonshotai/kimi-k3', usageAvailable: true, inputTokens: 100, outputTokens: 10 },
    ] }] as any,
  });
  assert.equal(result.outcome.status, 'success');
  if (result.outcome.status !== 'success') return;
  assert.equal(result.outcome.totalCostUsd, 0.5);
  assert.deepEqual(result.outcome.nativeProviderExecutions?.[0].ownershipAttemptIds, ['attempt-1', 'attempt-2']);
  assert.deepEqual(warnings, []);
});

// protects: a turn without a response ID is stable across repeated enrichment and archived copies.
it('anonymous observations are idempotent and do not erase known usage on incomplete enrichment', async () => {
  const { outcome } = await replay(['']);
  const records = outcome.nativeProviderExecutions!;
  assert.equal(records[0].responseId, null);
  assert.deepEqual(mergeNativeProviderExecutions(records, records), records);
  const incomplete = structuredClone(records);
  incomplete[0].usage!.input_tokens = null;
  assert.deepEqual(mergeNativeProviderExecutions(records, incomplete), records);
});

// protects: the actual producer, redaction, and owning SDK builder cannot drift from canonical intake.
it('round-trips the shared canonical contribution replay without leaking raw identities', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'provider-wire-replay-'));
  roots.push(repo);
  const row = await createProviderContributionReplay(repo);
  // allow-source-text-assertion: shared JSON wire fixture, not implementation source.
  const expected = JSON.parse(readFileSync(new URL('../../../tests/fixtures/provider-evidence/contribution-v4.json', import.meta.url), 'utf8'));
  assert.deepEqual(row, expected);
  assert.equal(row.actual_cost_usd, 0.02);
  assert.equal(row.inference_log_id, 'replay-routing-decision');
  assert.ok(!JSON.stringify(row).includes('replay-planning'));
  assert.ok(row.stage_executions[0].provider_executions!.every(turn => row.stage_executions[0].task_cost.session_ids.includes(turn.sessionRef)));
});
