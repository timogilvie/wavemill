import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  LABEL_CLASS,
  OPERATOR_COMMAND_CLASS,
  OPERATOR_INTERVENTION_FILENAME,
  appendOperatorTouch,
  buildOperatorInterventionRecord,
  classifyOperatorTouch,
  evalDetectorName,
  operatorTouchClass,
  operatorTouchLogPath,
  readOperatorTouchLog,
  formatOperatorInterventionDetail,
  parseOperatorInterventions,
  readOperatorInterventions,
  resolveOperatorInterventionTarget,
  writeOperatorIntervention,
} from './operator-intervention.ts';

let tmp: string | undefined;

function tempDir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'operator-intervention-'));
  return tmp;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('operator-intervention', () => {
  it('parses the incident artifact shape', () => {
    const records = parseOperatorInterventions({
      schemaVersion: '1.0',
      issue: 'HOK-537_c',
      stage: 'coding',
      attempt: 1,
      type: 'operator_recovery',
      severity: 'major',
      occurredAt: '2026-08-14T13:25:00Z',
      operator: 'human-directed',
      trigger: 'native_coding_failed_invalid_artifact',
      summary: 'Triaged failed suite and relaunched.',
      actionsTaken: ['ran tests'],
      codeWrittenByOperator: false,
      scoringNote: 'Attempt 1 should be scored as failed.',
      relatedCommit: '3e9a474',
      challengePairId: 'HOK-537',
    }, 'fixture');

    assert.equal(records.length, 1);
    assert.equal(records[0].severity, 'major');
    assert.equal(records[0].attempt, 1);
  });

  it('skips invalid array entries leniently', () => {
    const records = parseOperatorInterventions([
      { severity: 'critical', type: 'operator_recovery' },
      { severity: 'minor', summary: 'ok' },
    ], 'fixture');

    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'operator_recovery');
  });

  it('reads missing, empty, and malformed files as empty arrays', () => {
    const dir = tempDir();
    assert.deepEqual(readOperatorInterventions(dir), []);
    writeFileSync(join(dir, OPERATOR_INTERVENTION_FILENAME), '');
    assert.deepEqual(readOperatorInterventions(dir), []);
    writeFileSync(join(dir, OPERATOR_INTERVENTION_FILENAME), '{bad');
    assert.deepEqual(readOperatorInterventions(dir), []);
  });

  it('appends by converting to an array and replace writes a single object', () => {
    const dir = tempDir();
    const first = buildOperatorInterventionRecord({ severity: 'major', trigger: 'one', summary: 'first' });
    const second = buildOperatorInterventionRecord({ severity: 'minor', trigger: 'two', summary: 'second' });
    writeOperatorIntervention(dir, first);
    writeOperatorIntervention(dir, second);
    assert.equal(readOperatorInterventions(dir).length, 2);

    writeOperatorIntervention(dir, first, { append: false });
    const raw = JSON.parse(readFileSync(join(dir, OPERATOR_INTERVENTION_FILENAME), 'utf-8'));
    assert.equal(Array.isArray(raw), false);
    assert.equal(readOperatorInterventions(dir).length, 1);
    assert.equal(existsSync(join(dir, '.tmp-operator-intervention')), false);
  });

  it('resolves direct, slug, worktree, and task-key targets', () => {
    const repo = tempDir();
    mkdirSync(join(repo, 'features', 'slug'), { recursive: true });
    assert.equal(resolveOperatorInterventionTarget('features/slug', repo).featureDir, join(repo, 'features', 'slug'));
    assert.equal(resolveOperatorInterventionTarget('slug', repo).featureDir, join(repo, 'features', 'slug'));

    mkdirSync(join(repo, 'worktrees', 'wt', 'features', 'wt'), { recursive: true });
    assert.equal(resolveOperatorInterventionTarget('wt', repo).featureDir, join(repo, 'worktrees', 'wt', 'features', 'wt'));

    mkdirSync(join(repo, 'features', 'by-key'), { recursive: true });
    writeFileSync(join(repo, 'features', 'by-key', 'selected-task.json'), JSON.stringify({ taskId: 'HOK-1' }));
    assert.equal(resolveOperatorInterventionTarget('HOK-1', repo).featureDir, join(repo, 'features', 'by-key'));

    mkdirSync(join(repo, 'worktrees', 'other-slug', 'features', 'other-slug'), { recursive: true });
    writeFileSync(join(repo, 'worktrees', 'other-slug', 'features', 'other-slug', 'selected-task.json'), JSON.stringify({ taskId: 'HOK-2' }));
    assert.equal(resolveOperatorInterventionTarget('HOK-2', repo).featureDir, join(repo, 'worktrees', 'other-slug', 'features', 'other-slug'));
  });

  it('formats detail with scoring note', () => {
    const detail = formatOperatorInterventionDetail(buildOperatorInterventionRecord({
      severity: 'major',
      trigger: 'invalid_artifact',
      summary: 'Relaunched',
      scoringNote: 'Do not score clean first pass.',
    }));
    assert.match(detail, /scoringNote=Do not score clean first pass/);
  });
});

describe('classifyOperatorTouch (HOK-3455)', () => {
  it('maps every operator command in the table to its class', () => {
    for (const [command, cls] of Object.entries(OPERATOR_COMMAND_CLASS)) {
      assert.equal(classifyOperatorTouch({ kind: 'operator-event', detail: `${command}: detail` }).class, cls, command);
      assert.equal(classifyOperatorTouch({ kind: 'operator-event', detail: command }).class, cls, command);
    }
  });

  it('defaults unknown operator commands to R', () => {
    assert.equal(classifyOperatorTouch({ kind: 'operator-event', detail: 'frobnicate' }).class, 'R');
    assert.equal(classifyOperatorTouch({ kind: 'operator-event' }).class, 'R');
  });

  it('classifies operator-intervention triggers, defaulting to R', () => {
    assert.equal(classifyOperatorTouch({ kind: 'operator-intervention', detail: 'orphaned-challenger' }).class, 'O');
    assert.equal(classifyOperatorTouch({ kind: 'operator-intervention', detail: 'stalled coding agent' }).class, 'L');
    assert.equal(classifyOperatorTouch({ kind: 'operator-intervention', detail: 'stale wm:blocked label' }).class, 'S');
    assert.equal(classifyOperatorTouch({ kind: 'operator-intervention', detail: 'invalid_artifact' }).class, 'R');
  });

  it('maps every label in the table and defaults unknown labels to S', () => {
    for (const [label, cls] of Object.entries(LABEL_CLASS)) {
      assert.equal(classifyOperatorTouch({ kind: 'label-edit', detail: `labeled:${label}` }).class, cls, label);
      assert.equal(classifyOperatorTouch({ kind: 'label-edit', detail: `unlabeled:${label}` }).class, cls, label);
    }
    assert.equal(classifyOperatorTouch({ kind: 'label-edit', detail: 'labeled:wm:something-new' }).class, 'S');
  });

  it('classifies eval interventions by detector prefix or legacy type', () => {
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention', detail: '[session_redirect] please fix' }).class, 'L');
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention', detail: '[operator_recovery] severity=major' }).class, 'R');
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention', detail: '[review_comment] nit' }).class, 'S');
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention', detail: 'operator_recovery' }).class, 'R');
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention', detail: 'bugfix' }).class, 'S');
    assert.equal(classifyOperatorTouch({ kind: 'eval-intervention' }).class, 'S');
  });

  it('pins the fixed class of every remaining kind', () => {
    assert.equal(classifyOperatorTouch({ kind: 'pane-message' }).class, 'L');
    assert.equal(classifyOperatorTouch({ kind: 'session-redirect', detail: 'keep going' }).class, 'L');
    assert.equal(classifyOperatorTouch({ kind: 'external-merge' }).class, 'S');
    assert.equal(classifyOperatorTouch({ kind: 'manual-push', detail: 'abc1234: fix — commit outside all recorded agent activity windows', commitAttribution: 'operator_out_of_window' }).class, 'S');
    assert.equal(classifyOperatorTouch({ kind: 'manual-push', detail: 'abc1234: wip — operator handoff commit completing uncommitted agent output', commitAttribution: 'operator_handoff' }).class, 'R');
    assert.equal(classifyOperatorTouch({ kind: 'state-edit' }).class, 'R');
  });

  it('extracts the eval detector name', () => {
    assert.equal(evalDetectorName('[manual_edit] abc: x'), 'manual_edit');
    assert.equal(evalDetectorName('review_comment'), 'review_comment');
    assert.equal(evalDetectorName(undefined), '');
  });

  it('approvals are not human touches', () => {
    assert.deepEqual(classifyOperatorTouch({ kind: 'operator-event', detail: 'approve: L' }), { attribution: 'approval', class: 'L' });
    assert.deepEqual(classifyOperatorTouch({ kind: 'session-redirect', text: 'approved, 1 in scope', sessionKind: 'planning' }), { attribution: 'approval', class: 'L' });
  });

  it('session-redirect automation is detected from provenance and patterns', () => {
    assert.equal(classifyOperatorTouch({ kind: 'session-redirect', text: 'Output token limit hit', provenance: { isMeta: true } }).attribution, 'automation');
    assert.equal(classifyOperatorTouch({ kind: 'session-redirect', text: 'You are working on: foo', firstInOwnedSession: false }).attribution, 'automation');
    assert.equal(classifyOperatorTouch({ kind: 'session-redirect', text: 'yes', sessionKind: 'planning' }).attribution, 'approval');
    assert.equal(classifyOperatorTouch({ kind: 'session-redirect', text: 'keep going' }).attribution, 'human');
  });

  it('does not count a headless session\'s first prompt as a human redirect', () => {
    // protects: the `claude -p test` auth probe and other sdk-cli launches
    // looked like operators redirecting the agent (HOK-3468).
    assert.deepEqual(
      classifyOperatorTouch({
        kind: 'session-redirect',
        text: 'test',
        firstInSession: true,
        provenance: { entrypoint: 'sdk-cli' },
      }),
      { attribution: 'automation', class: 'L' },
    );
    // Without the headless entrypoint a first message is still a person, and
    // a later message inside a headless session is a redirect too.
    assert.equal(
      classifyOperatorTouch({
        kind: 'session-redirect',
        text: 'test',
        firstInSession: true,
        provenance: {},
      }).attribution,
      'human',
    );
    assert.equal(
      classifyOperatorTouch({
        kind: 'session-redirect',
        text: 'keep going',
        firstInSession: false,
        provenance: { entrypoint: 'sdk-cli' },
      }).attribution,
      'human',
    );
  });

  it('external merge uses tend receipt and mill actor', () => {
    assert.equal(classifyOperatorTouch({ kind: 'external-merge', hasTendReceipt: true }).attribution, 'automation');
    assert.equal(classifyOperatorTouch({ kind: 'external-merge', millActor: true }).attribution, 'automation');
    assert.equal(classifyOperatorTouch({ kind: 'external-merge' }).attribution, 'human');
  });

  it('operatorTouchClass returns only the class', () => {
    assert.equal(operatorTouchClass({ kind: 'state-edit' }), 'R');
  });
});

describe('operator touch log (HOK-3182)', () => {
  it('appends classified entries and reads them back, skipping malformed lines', () => {
    const repo = tempDir();
    appendOperatorTouch(repo, { at: '2026-10-08T10:00:00Z', kind: 'state-edit', issue: 'HOK-1', actor: 'tim' });
    writeFileSync(operatorTouchLogPath(repo), `${readFileSync(operatorTouchLogPath(repo), 'utf-8')}not json\n{"kind":"state-edit"}\n`);
    appendOperatorTouch(repo, { at: '2026-10-08T10:05:00Z', kind: 'label-edit', detail: 'labeled:wm:superseded' });

    const entries = readOperatorTouchLog(repo);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { at: '2026-10-08T10:00:00Z', kind: 'state-edit', issue: 'HOK-1', actor: 'tim', class: 'R' });
    assert.equal(entries[1].class, 'O');
  });

  it('reads a missing log as empty', () => {
    assert.deepEqual(readOperatorTouchLog(tempDir()), []);
  });
});
