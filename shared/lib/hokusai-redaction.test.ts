import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadUserConfig } from './hokusai-consent.ts';
import {
  getOrCreateRedactionSalt,
  PROTECTED_EGRESS_FIELD_FIXTURE,
  protectedEgressSentinelValues,
  redactHokusaiSubmission,
} from './hokusai-redaction.ts';
import type { HokusaiSubmission } from './hokusai-schema.ts';
import { validateHokusaiSubmission } from './hokusai-schema.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSubmission(overrides: Partial<HokusaiSubmission> = {}): HokusaiSubmission {
  return {
    schema_version: '1.0',
    run_id: 'run-user@example.com',
    task_id: 'issue-/Users/tim/project/private-repo',
    constraints: { max_cost_usd: 12.5 },
    route_taken: {
      planner_model: 'gpt-5.4',
      coder_model: 'gpt-5.3-codex',
      reviewer_model: 'claude-opus-4-6',
    },
    observed_outcomes: {
      completed_successfully: true,
      actual_cost_usd: 3.14,
      actual_time_seconds: 912,
      intervention_count: 2,
    },
    ...overrides,
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hokusai-redaction', () => {
  it('hashes identifiers and preserves training fields', () => {
    const input = makeSubmission({ constraints: { max_cost_usd: null } });
    const result = redactHokusaiSubmission(input, { salt: 'a'.repeat(64) });

    assert.match(result.run_id, /^redacted-[a-f0-9]{16}$/);
    assert.match(result.task_id, /^redacted-[a-f0-9]{16}$/);
    assert.notEqual(result.run_id, input.run_id);
    assert.notEqual(result.task_id, input.task_id);
    assert.deepEqual(result.constraints, { max_cost_usd: null });
    assert.equal(result.schema_version, '1.0');
    assert.deepEqual(result.route_taken, input.route_taken);
    assert.deepEqual(result.observed_outcomes, input.observed_outcomes);
  });

  it('is deterministic for the same salt and input', () => {
    const input = makeSubmission();
    const first = redactHokusaiSubmission(input, { salt: 'b'.repeat(64) });
    const second = redactHokusaiSubmission(input, { salt: 'b'.repeat(64) });

    assert.equal(first.run_id, second.run_id);
    assert.equal(first.task_id, second.task_id);
  });

  it('changes hashes when the salt changes', () => {
    const input = makeSubmission();
    const first = redactHokusaiSubmission(input, { salt: 'c'.repeat(64) });
    const second = redactHokusaiSubmission(input, { salt: 'd'.repeat(64) });

    assert.notEqual(first.run_id, second.run_id);
    assert.notEqual(first.task_id, second.task_id);
  });

  it('strips unexpected free text fields to guard future schema growth', () => {
    const input = {
      ...makeSubmission(),
      description: 'Customer issue from jane@example.com in acme/private-repo',
      repo_url: 'https://github.com/acme/private-repo',
      metadata: {
        notes: '/Users/jane/src/private-repo',
      },
    } as HokusaiSubmission & {
      description: string;
      repo_url: string;
      metadata: { notes: string };
    };

    const result = redactHokusaiSubmission(input, { salt: 'e'.repeat(64) }) as typeof input;

    assert.equal(result.description, '');
    assert.equal(result.repo_url, '');
    assert.equal(result.metadata.notes, '');
  });

  it('preserves allow-listed rubric signal fields and strips unexpected text', () => {
    const input = {
      ...makeSubmission({
        schema_version: '1.1',
        rubric_signals: {
          rubric_version: '2026-04',
          criterion_count: 5,
          mean_score: 0.72,
          criteria_scores: {
            completeness: 0.9,
            correctness: 0.8,
            code_quality: 0.7,
            intervention_impact: 0.6,
            autonomy: 0.5,
          },
          determinative_boundary: 'functional_bug',
          rubric_provenance: 'judge',
        },
      }),
      rubric_notes: 'Reviewer named jane@example.com in rationale',
    } as HokusaiSubmission & { rubric_notes: string };

    const result = redactHokusaiSubmission(input, { salt: '2'.repeat(64) }) as typeof input;

    assert.equal(result.schema_version, '1.1');
    assert.deepEqual(result.rubric_signals, input.rubric_signals);
    assert.equal(result.rubric_notes, '');
    assert.deepEqual(validateHokusaiSubmission(result), {
      valid: true,
      errors: [],
    });
  });

  it('strips every protected vendor-telemetry and reviewer-evidence field (HOK-2787)', () => {
    const input = {
      ...makeSubmission(),
      ...structuredClone(PROTECTED_EGRESS_FIELD_FIXTURE),
      vendor_telemetry: structuredClone(PROTECTED_EGRESS_FIELD_FIXTURE),
    } as HokusaiSubmission & Record<string, unknown>;

    const result = redactHokusaiSubmission(input, { salt: '3'.repeat(64) });
    const serialized = JSON.stringify(result);

    const sentinels = protectedEgressSentinelValues();
    assert.ok(sentinels.length >= 12, 'fixture must cover the September protected fields');
    for (const sentinel of sentinels) {
      const needle = JSON.stringify(sentinel).slice(1, -1);
      assert.ok(
        !serialized.includes(needle),
        `protected value must not survive redaction: ${sentinel}`,
      );
    }
  });

  it('returns a submission that still validates', () => {
    const result = redactHokusaiSubmission(makeSubmission(), {
      salt: 'f'.repeat(64),
    });

    assert.deepEqual(validateHokusaiSubmission(result), {
      valid: true,
      errors: [],
    });
  });

  it('creates and persists a redaction salt on first use', () => {
    const configDir = makeTempDir('hokusai-redaction-config-');

    const first = getOrCreateRedactionSalt(configDir);
    const second = getOrCreateRedactionSalt(configDir);
    const config = loadUserConfig(configDir);

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.equal(config.hokusai?.redactionSalt, first);
  });

  it('uses the persisted salt when options omit one', () => {
    const configDir = makeTempDir('hokusai-redaction-config-');
    const savedSalt = getOrCreateRedactionSalt(configDir);
    const input = makeSubmission();

    const implicit = redactHokusaiSubmission(input, { configDir });
    const explicit = redactHokusaiSubmission(input, { salt: savedSalt });

    assert.equal(implicit.run_id, explicit.run_id);
    assert.equal(implicit.task_id, explicit.task_id);
  });

  it('does not leak obvious pii-like patterns after redaction', () => {
    const input = {
      ...makeSubmission(),
      description: 'Email jane@example.com and open https://github.com/acme/private',
      notes: '/Users/jane/private',
    } as HokusaiSubmission & { description: string; notes: string };

    const result = redactHokusaiSubmission(input, { salt: '1'.repeat(64) });
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    assert.doesNotMatch(serialized, /https?:\/\/[^\s"'<>)}\]]+/);
    assert.doesNotMatch(serialized, /(?:\/[a-zA-Z0-9._-]+){2,}/);
  });
});
