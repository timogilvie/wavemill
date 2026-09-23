import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  STAGE_FAILURE_CAUSES,
  STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES,
  deleteStageFailureEnvelope,
  getStageFailureEnvelopePath,
  readStageFailureEnvelope,
  terminalFailureKindForCause,
  terminalFailureKindForEnvelope,
  validateStageFailureEnvelope,
  writeStageFailureEnvelope,
  type StageFailureCause,
  type StageFailureEnvelope,
} from './stage-failure-envelope.ts';
import type { TerminalFailureKind } from '../arm-failure-taxonomy.ts';

function makeEnvelope(overrides: Partial<StageFailureEnvelope> = {}): StageFailureEnvelope {
  return {
    schemaVersion: '1.0',
    stage: 'review',
    cause: 'stage-timeout',
    stopReason: 'wall_clock_limit',
    retryAttempt: 1,
    configuredTimeoutMs: 600_000,
    provider: 'openrouter',
    model: 'kimi-k2',
    requestedModel: 'openrouter/kimi-k2',
    agent: 'native-openrouter',
    evidence: {
      source: 'native-runtime',
      detail: 'Native review exceeded its wall-clock budget before producing a final JSON result.',
      transcriptPath: '/tmp/native.jsonl',
    },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test('round-trips a written envelope through the validating reader', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-failure-envelope-'));
  try {
    const envelope = makeEnvelope();
    writeStageFailureEnvelope(dir, envelope);
    const filePath = getStageFailureEnvelopePath(dir, 'review');
    assert.equal(filePath, join(dir, '.review-failure-envelope.json'));

    const result = await readStageFailureEnvelope(filePath);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.value, envelope);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names the envelope file per stage', () => {
  const dir = '/features/x';
  assert.equal(getStageFailureEnvelopePath(dir, 'planning'), '/features/x/.planning-failure-envelope.json');
  assert.equal(getStageFailureEnvelopePath(dir, 'coding'), '/features/x/.coding-failure-envelope.json');
  assert.equal(getStageFailureEnvelopePath(dir, 'review'), '/features/x/.review-failure-envelope.json');
});

test('truncates evidence.detail to the byte cap on write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-failure-envelope-'));
  try {
    const huge = 'x'.repeat(STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES + 5_000);
    writeStageFailureEnvelope(dir, makeEnvelope({ evidence: { source: 'native-runtime', detail: huge } }));
    const written = JSON.parse(
      readFileSync(getStageFailureEnvelopePath(dir, 'review'), 'utf-8'),
    ) as StageFailureEnvelope;
    assert.ok(Buffer.byteLength(written.evidence.detail, 'utf8') <= STAGE_FAILURE_EVIDENCE_DETAIL_MAX_BYTES + Buffer.byteLength('…[truncated]', 'utf8'));
    assert.match(written.evidence.detail, /…\[truncated\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteStageFailureEnvelope removes a stale envelope and is a no-op when absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-failure-envelope-'));
  try {
    writeStageFailureEnvelope(dir, makeEnvelope());
    deleteStageFailureEnvelope(dir, 'review');
    // Second delete is a no-op (must not throw).
    deleteStageFailureEnvelope(dir, 'review');
    await assert.rejects(readStageFailureEnvelope(getStageFailureEnvelopePath(dir, 'review')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validation fails closed on a missing required field', () => {
  const { evidence: _evidence, ...withoutEvidence } = makeEnvelope();
  const result = validateStageFailureEnvelope(withoutEvidence);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'MISSING_REQUIRED_FIELD');
    assert.equal(result.field, 'evidence');
  }
});

test('validation fails closed on an unknown cause', () => {
  const result = validateStageFailureEnvelope(makeEnvelope({ cause: 'not-a-cause' as StageFailureCause }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'INVALID_ENUM_VALUE');
    assert.equal(result.field, 'cause');
  }
});

test('validation fails closed on the wrong schema version', () => {
  const result = validateStageFailureEnvelope(makeEnvelope({ schemaVersion: '2.0' as StageFailureEnvelope['schemaVersion'] }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, 'schemaVersion');
  }
});

test('validation fails closed on an empty provider identity', () => {
  const result = validateStageFailureEnvelope(makeEnvelope({ provider: '' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, 'provider');
  }
});

test('validation fails closed on a malformed evidence sub-object', () => {
  const result = validateStageFailureEnvelope(makeEnvelope({ evidence: { source: 'native-runtime', detail: '' } }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, 'evidence.detail');
  }
});

test('validation fails closed on a negative retryAttempt', () => {
  const result = validateStageFailureEnvelope(makeEnvelope({ retryAttempt: -1 }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.field, 'retryAttempt');
  }
});

test('terminalFailureKindForEnvelope covers the full cause table', () => {
  const table: Record<StageFailureCause, TerminalFailureKind> = {
    'stage-timeout': 'native-stage-timeout',
    'provider-rate-limited': 'provider-rate-limited',
    'provider-outage': 'provider-transient-error',
    'provider-credit-exhausted': 'provider-credit-exhausted',
    'provider-config-error': 'provider-config-error',
    'model-protocol': 'native-completion-protocol',
    'context-exhausted': 'context-exhausted',
    'context-window-exceeded': 'context-window-exceeded',
    'policy-denied': 'policy-denied',
    'cancelled': 'cancelled',
    'unknown': 'native-unclassified',
  };

  // Every declared cause must have an entry — guards against an unmapped cause.
  assert.deepEqual(new Set(Object.keys(table)), new Set(STAGE_FAILURE_CAUSES));

  for (const cause of STAGE_FAILURE_CAUSES) {
    assert.equal(terminalFailureKindForCause(cause), table[cause], `cause ${cause}`);
    assert.equal(terminalFailureKindForEnvelope(makeEnvelope({ cause })), table[cause], `envelope cause ${cause}`);
  }
});
