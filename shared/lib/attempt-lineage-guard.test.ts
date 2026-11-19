import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { ATTEMPT_LINEAGE_GUARD } from './attempt-lineage-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(ATTEMPT_LINEAGE_GUARD, file, source).map((finding) => finding.pattern);

describe('attempt-lineage guard — forbidden shapes (HOK-3476)', () => {
  // protects: a bypass writer constructing SDK identity itself instead of calling the projector
  it('flags a hand-built TaskAttemptRef-shaped object literal', () => {
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "  const ref = { task_id: issue, run_id: id };\n"),
      ['hand-built-attempt-ref'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "  attempt: { task_id: taskId, run_id: runId, stage_attempt_id: id },\n"),
      ['hand-built-attempt-ref'],
    );
  });

  // protects: a retry edge inferred (from a head/timestamp/session) instead of explicitly named
  it('flags retry_of / retryOf assigned outside the canonical module', () => {
    assert.deepEqual(patternsOf('shared/lib/a.ts', "    retry_of: priorAttemptId,\n"), ['retry-of-literal']);
    assert.deepEqual(patternsOf('shared/lib/a.ts', "  record.retryOf = sibling.id;\n"), ['retry-of-literal']);
  });

  // protects: an unrelated object literal with similarly named fields in prose/comments
  it('does not flag task_id/run_id mentioned on separate lines', () => {
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "  const ref = {\n    task_id: issue,\n    run_id: id,\n  };\n"),
      [],
    );
  });

  // protects: the current tree, including the canonical module itself, staying clean
  it('passes over the real repo tree (the canonical module is excluded, not flagged)', () => {
    const result = runSourceGuard(ATTEMPT_LINEAGE_GUARD, repoRoot);
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });
});
