import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { SESSION_OWNERSHIP_GUARD } from './session-ownership-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(SESSION_OWNERSHIP_GUARD, file, source).map((finding) => finding.pattern);

describe('session-ownership guard — forbidden shapes (HOK-3328)', () => {
  // protects: a reader labelling a session's stage itself instead of reading the launch row
  it('flags a stageRole object built outside session-ownership.ts', () => {
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "  const stageRole = { value: 'review', confidence: 'branch_worktree', evidence: null };\n"),
      ['stage-role-construction'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "  return { stageRole: { value: null, kind: 'operator', confidence: 'unowned', evidence: null } };\n"),
      ['stage-role-construction'],
    );
    assert.deepEqual(patternsOf('shared/lib/a.ts', "  session.stageRole = {\n"), ['stage-role-construction']);
  });

  // protects: the retired timestamp_window stage tier coming back
  it('flags emitting the timestamp_window tier', () => {
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "      confidence: 'timestamp_window',\n"),
      ['timestamp-window-tier'],
    );
  });

  // protects: helper sessions inside the review window being labelled review again
  it('flags session-timestamp vs stage-window comparisons and the retired window machinery', () => {
    for (const line of [
      'const windows = buildStageWindows(stageResults);',
      'function attributeStage(session, windows) {',
      'interface StageWindow { stage: string }',
      'return start <= windowEnd && end >= window.startedAt;',
      'if (candidate.timestampMs < windowStartMs) continue;',
      'if (session.startedAt >= stageResult.startedAt) labelled.push(session);',
    ]) {
      assert.deepEqual(patternsOf('shared/lib/a.ts', `${line}\n`), ['session-window-overlap'], line);
    }
  });

  // protects: workflowCost being one harness's summary (the HOK-3237 $4.93 instead of $48.64)
  it('flags single-harness selection and Wavemill-side summary totals', () => {
    assert.deepEqual(patternsOf('a.ts', 'const primary = selectPrimaryTaskCostSummary(summaries, agentType);\n'), ['single-harness-pick']);
    assert.deepEqual(patternsOf('a.ts', "const HARNESS_ORDER = ['native', 'claude-code', 'codex'] as const;\n"), ['single-harness-pick']);
    assert.deepEqual(
      patternsOf('a.ts', "const native = summaries.find((summary) => summary.harness === 'native');\n"),
      ['single-harness-pick'],
    );
    assert.deepEqual(
      patternsOf('a.ts', 'const total = summaries.reduce((sum, s) => sum + (s.total_cost_usd ?? 0), 0);\n'),
      ['summary-total-sum'],
    );
  });

  // protects: the guard firing on unrelated code and being suppressed wholesale
  it('does not flag ordinary windows, SDK boundaries, or stageRole reads', () => {
    for (const line of [
      'const windowStartMs = untilMs - 7 * 24 * 3600 * 1000;',
      'window: { startedAt: input.window.startedAt, endedAt: input.window.endedAt },',
      "if (session.stageRole.value === 'coding') count++;",
      'const stageRole = ownershipStageRole(owner);',
      'stageRole,',
      "type StageRole = 'planner' | 'coder';",
    ]) {
      assert.deepEqual(patternsOf('shared/lib/a.ts', `${line}\n`), [], line);
    }
  });
});

describe('session-ownership guard — repository', () => {
  // protects: a merged change reintroducing a second ownership/cost answer
  it('passes on the repository as committed', () => {
    const result = runSourceGuard(SESSION_OWNERSHIP_GUARD, repoRoot);
    assert.deepEqual(result.findings.map((finding) => `${finding.file}:${finding.line} ${finding.pattern}`), []);
    assert.equal(result.ok, true);
  });
});
