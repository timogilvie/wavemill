import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { ATTENTION_GUARD } from './attention-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(ATTENTION_GUARD, file, source).map((finding) => finding.pattern);

describe('attention guard (HOK-3423)', () => {
  it('flags the retired inbox classifier and a new actionable classification', () => {
    // protects: is_actionable_state (or a copy) coming back as an eighth
    // "does this task need a human?" site.
    assert.deepEqual(patternsOf('shared/lib/wavemill-status.sh', 'classification=$(is_actionable_state "$s")\n'), ['actionable-classification']);
    assert.deepEqual(patternsOf('shared/lib/wavemill-status.sh', '      echo "actionable"\n'), ['actionable-classification']);
    assert.deepEqual(patternsOf('shared/lib/wavemill-status.sh', 'd=$(planning_rejection_detail "$wt" "$slug")\n'), ['actionable-classification']);
  });

  it('flags inbox membership written outside the projection reader', () => {
    // protects: a renderer adding rows to the inbox from its own signal.
    assert.deepEqual(patternsOf('shared/lib/wavemill-status.sh', '  inbox_tasks+=("$task_data")\n'), ['inbox-membership']);
    assert.deepEqual(patternsOf('tools/dashboard.ts', 'inboxItems.push(task);\n'), ['inbox-membership']);
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-status.sh', '  # allow-attention: renders the projection\n  inbox_tasks+=("$x")\n'),
      [],
    );
  });

  it('flags raw .needs-attention reads but not writes, clears or sibling files', () => {
    // protects: a new consumer re-deriving attention from the raw marker
    // (the HOK-2916 latch) instead of the projection.
    assert.deepEqual(patternsOf('shared/lib/x.sh', 'if [[ -f "$fd/.needs-attention" ]]; then\n'), ['raw-needs-attention-read']);
    assert.deepEqual(patternsOf('shared/lib/x.sh', 'if [[ -n "$r" && ! -f "$fd/.needs-attention" ]]; then\n'), ['raw-needs-attention-read']);
    assert.deepEqual(patternsOf('shared/lib/x.ts', "const body = readFileSync(join(fd, '.needs-attention'), 'utf8');\n"), ['raw-needs-attention-read']);
    assert.deepEqual(patternsOf('shared/lib/x.sh', 'marker_clear "$state_dir/.needs-attention"\n'), []);
    assert.deepEqual(patternsOf('shared/lib/x.ts', "const e = join(fd, '.needs-attention.evidence.json');\n"), []);
    assert.deepEqual(patternsOf('shared/lib/x.sh', '# reads [[ -f .needs-attention ]] in prose\n'), []);
  });

  it('flags a raw hook-state inbox case and a private exhaustion re-check', () => {
    // protects: the dashboard paging on a hook `error` the failure policy would
    // retry, or re-deciding exhaustion the escalation step already recorded.
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-status.sh', '    exited|waiting|blocked|approval-needed|policy-denied|error) echo "actionable" ;;\n'),
      ['raw-hook-state-inbox-case', 'actionable-classification'],
    );
    assert.deepEqual(
      patternsOf('shared/lib/wavemill-status.sh', 'if bounded_retry_is_exhausted "$fd" "stage-failure-ready"; then\n'),
      ['private-exhaustion-recheck'],
    );
  });

  it('passes on the live tree with the seeded ratchet', () => {
    // protects: the guard shipping red, or the allowlist over-allowing.
    const result = runSourceGuard(ATTENTION_GUARD, repoRoot);
    assert.deepEqual(result.findings, []);
  });
});
