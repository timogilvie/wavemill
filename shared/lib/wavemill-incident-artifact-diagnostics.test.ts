import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readPlanningResult,
  redactIncidentData,
} from './artifact-diagnostics.ts';

test('readPlanningResult returns structured terminal fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incident-artifacts-'));
  try {
    const file = join(dir, '.planning-result.json');
    writeFileSync(file, JSON.stringify({
      status: 'failed',
      failureReason: 'turn_limit',
      agent: 'codex',
      model: 'gpt-5',
      finishedAt: '2026-08-03T12:00:00.000Z',
      planFile: 'plan.md',
    }));

    assert.deepEqual(readPlanningResult(file), {
      status: 'failed',
      failureReason: 'turn_limit',
      agent: 'codex',
      model: 'gpt-5',
      startedAt: undefined,
      finishedAt: '2026-08-03T12:00:00.000Z',
      planFile: 'plan.md',
      transcriptFile: undefined,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactIncidentData strips secrets and bounds long command context', () => {
  const dirty = 'Authorization: Bearer sk-secretsecretsecret OPENAI_API_KEY=sk-testsecretsecretsecret command='.concat('x'.repeat(600));
  const clean = redactIncidentData(dirty);
  assert.doesNotMatch(clean, /sk-secret|sk-test/);
  assert.match(clean, /\[REDACTED\]|\[REDACTED_TOKEN\]/);
  assert.ok(clean.length <= 140);
});
