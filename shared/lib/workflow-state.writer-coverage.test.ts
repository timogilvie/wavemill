/**
 * HOK-3220: the workflow-state task schema is derived from the writers.
 *
 * - Every TaskRecord property in `workflow-task.schema.json` has at least one
 *   writer (so a reader cannot add the name it wished existed — HOK-3181).
 * - Every top-level field a writer sets is declared in the schema (so the
 *   schema stays the complete writer shape).
 * - The hand-written `TaskRecord` type mirrors the schema one-for-one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_TASK_RECORD_FIELDS, WORKFLOW_STATE_SCHEMA_PATH } from './workflow-state.ts';
import {
  collectTaskWriterFields,
  extractShellTaskWriterFields,
  extractTsTaskWriterFields,
  TS_TASK_WRITER_FILES,
} from './workflow-state-writers.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function schemaTaskProperties(): string[] {
  const schema = JSON.parse(readFileSync(join(repoRoot, WORKFLOW_STATE_SCHEMA_PATH), 'utf-8'));
  return Object.keys(schema.$defs.TaskRecord.properties).sort();
}

/** Property names declared in `export type TaskRecord = { ... };`. */
function taskRecordTypeProperties(): string[] {
  const source = readFileSync(join(repoRoot, 'shared/lib/workflow-state.ts'), 'utf-8');
  const start = source.indexOf('export type TaskRecord = {');
  assert.ok(start >= 0, 'TaskRecord type not found');
  const body = source.slice(start, source.indexOf('\n};', start));
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\?:/gm)].map((match) => match[1]).sort();
}

describe('workflow-task schema writer coverage', () => {
  const { fields } = collectTaskWriterFields(repoRoot);

  it('every schema TaskRecord property has at least one writer', () => {
    const unwritten = schemaTaskProperties().filter((field) => !fields.has(field));
    assert.deepEqual(
      unwritten,
      [],
      `schema declares task fields that no writer sets: ${unwritten.join(', ')}.\n`
        + 'The schema is derived from the writers (save_task_state, state_mutate / task_state_mutate_existing '
        + 'sites, mutateWorkflowState callers). If a reader needs one of these, the reader is wrong.',
    );
  });

  it('every field a writer sets is declared in the schema', () => {
    const declared = new Set(schemaTaskProperties());
    const undeclared = [...fields.keys()]
      .filter((field) => !declared.has(field))
      .sort()
      .map((field) => `${field} (${[...new Set(fields.get(field))].join(', ')})`);
    assert.deepEqual(
      undeclared,
      [],
      `writers set task fields the schema does not declare: ${undeclared.join('; ')}.\n`
        + `Add them to ${WORKFLOW_STATE_SCHEMA_PATH} and TaskRecord in shared/lib/workflow-state.ts, `
        + 'then run npx tsx tools/generate-schema-validators.ts.',
    );
  });

  it('the TaskRecord type mirrors the schema one-for-one', () => {
    assert.deepEqual(taskRecordTypeProperties(), schemaTaskProperties());
  });

  it('never declares a reader-only name (HOK-3181 / HOK-3212)', () => {
    const declared = new Set(schemaTaskProperties());
    for (const field of FORBIDDEN_TASK_RECORD_FIELDS) {
      assert.equal(declared.has(field), false, `${field} must not be a TaskRecord property`);
      assert.equal(fields.has(field), false, `${field} must not be written at the top level of a task record`);
    }
  });

  it('scans every listed TypeScript writer and finds at least one field in each', () => {
    for (const file of TS_TASK_WRITER_FILES) {
      const found = extractTsTaskWriterFields(readFileSync(join(repoRoot, file), 'utf-8'));
      assert.ok(found.size > 0, `${file} is listed as a task writer but no task write was recognised`);
    }
  });
});

describe('extractShellTaskWriterFields', () => {
  const fieldsOf = (source: string) => [...extractShellTaskWriterFields(source)].sort();

  it('recognises jq path writes, |= and +=, but not comparisons', () => {
    assert.deepEqual(fieldsOf(`
      state_mutate "$STATE_FILE" '.tasks[$issue].phase = "x" | .tasks[$i].retryCount += 1 | .tasks["A"].arms |= . + [1]
        | select(.tasks[$issue].status == "active")'
    `), ['arms', 'phase', 'retryCount']);
  });

  it('recognises depth-1 keys of object merges only', () => {
    assert.deepEqual(fieldsOf(`
      '.tasks[$issue] = ((.tasks[$issue] // {}) + {
        phase: $phase,
        launchFailure: { reason: $reason, nested: { deep: 1 } },
        label: "a, b: c"
      })'
      '(.tasks[$issue] // {}) as $existing | .tasks[$issue] = ($existing + { executionOwner: "queue" })'
    `), ['executionOwner', 'label', 'launchFailure', 'phase']);
  });

  it('recognises .value writes inside .tasks |= with_entries(...)', () => {
    assert.deepEqual(fieldsOf(`
      .tasks |= with_entries(
        if (.value.challengePairId // "") == $pair then
          .value.comparisonState = $state | .value.updated = (now | todate)
        else . end
      ) | .value.notATask = 1
    `), ['comparisonState', 'updated']);
  });

  it('recognises task_state_mutate_existing filters, including continued lines', () => {
    assert.deepEqual(fieldsOf(`
      task_state_mutate_existing "$issue" '.evalFailed = true | .lifecycle.deep = 1 | . + {evalRunning: null}'
      task_state_mutate_existing "$issue" \\
        '.status = "active" | del(.statusCondition)'
    `), ['evalFailed', 'evalRunning', 'status']);
  });

  it('ignores comments and tombstone history', () => {
    assert.deepEqual(fieldsOf(`
      # a raw \`.tasks[$issue].x = ...\` write re-creates the entry
      '.terminalTaskHistory.tasks[$issue].postReapEval = {} | .terminalTaskHistory.tasks[$issue] = ($t + {a: 1})'
    `), []);
  });
});

describe('extractTsTaskWriterFields', () => {
  it('recognises assignments through task locals and object-literal rows', () => {
    assert.deepEqual([...extractTsTaskWriterFields(`
      task.phase = 'aborted';
      entry.challengeAborted = reason;
      if (task.status === 'x') {}
      const fn = (task) => task.slug;
      other.notATask = 1;
      tasks[job.issueId] = { ...tasks[job.issueId], evalCompleted: true, note: 'a, b: c', nested: { deep: 1 } };
    `)].sort(), ['challengeAborted', 'evalCompleted', 'nested', 'note', 'phase']);
  });
});
