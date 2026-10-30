import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTaskRecordShapes,
  checkTaskRecordShapeSource,
  formatTaskRecordShapes,
  parseTaskRecordShapeAllowlist,
  TASK_RECORD_SHAPE_ALLOWLIST_FILE,
} from './task-record-shape-checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (source: string, file = 'shared/lib/example.ts') =>
  checkTaskRecordShapeSource(file, source).map((finding) => finding.pattern);

describe('checkTaskRecordShapeSource', () => {
  it('flags private task-map annotations, including inline JSON.parse casts', () => {
    assert.deepEqual(patternsOf('interface S {\n  tasks?: Record<string, JsonRecord>;\n}'), ['tasks-record-annotation']);
    assert.deepEqual(
      patternsOf("const s = JSON.parse(raw) as { tasks?: Record<string, { branch?: unknown }> };"),
      ['tasks-record-annotation'],
    );
    assert.deepEqual(patternsOf('function f(tasks: Record<string, unknown>) {}'), ['tasks-record-annotation']);
  });

  it('allows the canonical Record<string, TaskRecord> map', () => {
    assert.deepEqual(patternsOf('function f(tasks: Record<string, TaskRecord>) {}'), []);
  });

  it('flags `.tasks as Record<...>` casts', () => {
    assert.deepEqual(patternsOf('const tasks = state.tasks as Record<string, unknown>;'), ['tasks-record-cast']);
  });

  it('flags private WorkflowState / TaskState / TaskRecord declarations but not imports or other names', () => {
    assert.deepEqual(patternsOf('interface WorkflowState {'), ['workflow-state-type']);
    assert.deepEqual(patternsOf('export interface WorkflowStateLike extends X {'), ['workflow-state-type']);
    assert.deepEqual(patternsOf('type WorkflowStateFile = WorkflowStateLike & {'), ['workflow-state-type']);
    assert.deepEqual(patternsOf('interface TaskState {'), ['task-record-type']);
    assert.deepEqual(patternsOf('type TaskRecord = {'), ['task-record-type']);
    assert.deepEqual(patternsOf("import { type WorkflowState, type TaskRecord } from './workflow-state.ts';"), []);
    assert.deepEqual(patternsOf("export type TaskState = 'pending' | 'running';"), [], 'ledger TaskState is a different concept');
    assert.deepEqual(patternsOf('export interface WorkflowStateChallengeData {'), []);
  });

  it('honours the suppression marker on the line or the line above, and skips comments', () => {
    assert.deepEqual(patternsOf('tasks?: Record<string, X>; // allow-task-record-shape: other file'), []);
    assert.deepEqual(patternsOf('// allow-task-record-shape: other file\ntasks?: Record<string, X>;'), []);
    assert.deepEqual(patternsOf(' * tasks?: Record<string, unknown> in prose'), []);
  });

  it('ignores non-TypeScript files', () => {
    assert.deepEqual(patternsOf('tasks?: Record<string, X>;', 'shared/lib/example.sh'), []);
  });
});

describe('parseTaskRecordShapeAllowlist', () => {
  it('requires a reason on every entry', () => {
    const parsed = parseTaskRecordShapeAllowlist('# header\n\nshared/lib/a.ts  # render view\nshared/lib/b.ts\n');
    assert.deepEqual(parsed.entries, [{ path: 'shared/lib/a.ts', reason: 'render view' }]);
    assert.deepEqual(parsed.missingReason, ['shared/lib/b.ts']);
  });
});

describe('checkTaskRecordShapes', () => {
  it('the repository has no private workflow-state task shapes', () => {
    const result = checkTaskRecordShapes(repoRoot);
    assert.deepEqual(result.findings, [], formatTaskRecordShapes(result));
    assert.ok(result.scannedFiles > 0);
  });

  it('scans tracked non-test files, skips tests and allowlisted files, and rejects reasonless entries', () => {
    const repo = mkdtempSync(join(tmpdir(), 'task-record-shape-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'shared', 'lib'), { recursive: true });
      mkdirSync(join(repo, 'tools'), { recursive: true });
      writeFileSync(join(repo, 'shared/lib/bad.ts'), 'interface S {\n  tasks?: Record<string, unknown>;\n}\n');
      writeFileSync(join(repo, 'shared/lib/bad.test.ts'), 'const tasks: Record<string, unknown> = {};\n');
      writeFileSync(join(repo, 'shared/lib/listed.ts'), 'interface WorkflowState {}\n');
      writeFileSync(join(repo, 'shared/lib/unexplained.ts'), 'interface TaskState {}\n');
      writeFileSync(join(repo, TASK_RECORD_SHAPE_ALLOWLIST_FILE), 'shared/lib/listed.ts # reason\nshared/lib/unexplained.ts\n');
      execFileSync('git', ['add', '.'], { cwd: repo });

      const result = checkTaskRecordShapes(repo);
      assert.equal(result.ok, false);
      assert.deepEqual(
        result.findings.map((finding) => `${finding.file}:${finding.pattern}`).sort(),
        [
          'shared/lib/bad.ts:tasks-record-annotation',
          'shared/lib/unexplained.ts:task-record-type',
          `${TASK_RECORD_SHAPE_ALLOWLIST_FILE}:allowlist-missing-reason`,
        ].sort(),
      );

      const cli = spawnSync(process.execPath, [join(repoRoot, 'tools/check-task-record-shape.ts'), repo], { encoding: 'utf-8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /shared\/lib\/bad\.ts:2:3 \[tasks-record-annotation\]/);
      assert.match(cli.stderr, /shared\/lib\/workflow-state\.ts/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
