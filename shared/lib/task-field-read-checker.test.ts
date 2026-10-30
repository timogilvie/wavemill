import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTaskFieldReads,
  checkTaskFieldReadsForFile,
  extractTaskFieldReads,
  formatTaskFieldReads,
  loadAllowedTaskFields,
  WORKFLOW_TASK_SCHEMA_PATH,
} from './task-field-read-checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Narrow allowlist for extract* tests: the fixture file uses `prNumber` as its
// forbidden field. Fields in this set are tolerated; everything else fires.
const SMALL_ALLOWED = new Set([
  'pr', 'challenge', 'challengePairId', 'challengeRole', 'lifecycle',
]);

const fieldsOf = (source: string, file = 'shared/lib/example.sh') =>
  extractTaskFieldReads(file, source, SMALL_ALLOWED).map((f) => `${f.pattern}:${f.field}`);

describe('loadAllowedTaskFields', () => {
  it('returns every top-level TaskRecord property from the schema', () => {
    const allowed = loadAllowedTaskFields(repoRoot);
    assert.ok(allowed.has('pr'), '.pr must be present (writer: save_task_state)');
    assert.ok(allowed.has('challengePairId'));
    assert.ok(allowed.has('lifecycle'));
    assert.equal(allowed.has('prNumber'), false, 'reader-only drift from HOK-3212 must stay out');
    assert.equal(allowed.has('pullRequest'), false);
  });

  it('throws (fail-closed) when the schema file is missing or malformed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'task-field-schema-'));
    try {
      assert.throws(() => loadAllowedTaskFields(repo), /ENOENT|cannot parse|no \$defs/);
      mkdirSync(join(repo, 'shared/schemas'), { recursive: true });
      writeFileSync(join(repo, WORKFLOW_TASK_SCHEMA_PATH), '{ not json');
      assert.throws(() => loadAllowedTaskFields(repo), /cannot parse/);
      writeFileSync(join(repo, WORKFLOW_TASK_SCHEMA_PATH), '{"$defs": {}}');
      assert.throws(() => loadAllowedTaskFields(repo), /no \$defs/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('extractTaskFieldReads', () => {
  it('allows reads of fields that live in TaskRecord', () => {
    assert.deepEqual(fieldsOf('x=$(jq -r \'.tasks[$i].pr // empty\' "$F")'), []);
    assert.deepEqual(fieldsOf('role=$(get_task_meta "$issue" "challengeRole")'), []);
    assert.deepEqual(fieldsOf('role=$(get_task_meta "$issue" challengeRole)'), []);
  });

  it('flags .tasks[].prNumber (the HOK-3212 drift)', () => {
    assert.deepEqual(
      fieldsOf('v=$(jq -r \'.tasks[$i].prNumber // empty\' "$F")'),
      ['tasks-field-read:prNumber'],
    );
  });

  it('flags get_task_meta "$i" prNumber (bare, single-quoted, double-quoted)', () => {
    assert.deepEqual(
      fieldsOf('pr=$(get_task_meta "$issue" prNumber)'),
      ['get-task-meta:prNumber'],
    );
    assert.deepEqual(
      fieldsOf('pr=$(get_task_meta "$issue" "prNumber")'),
      ['get-task-meta:prNumber'],
    );
    assert.deepEqual(
      fieldsOf("pr=$(get_task_meta \"$issue\" 'prNumber')"),
      ['get-task-meta:prNumber'],
    );
  });

  it('ignores .terminalTaskHistory.tasks[$i].prNumber — tombstone, not a task record', () => {
    assert.deepEqual(
      fieldsOf('v=$(jq -r \'.terminalTaskHistory.tasks[$i].prNumber // empty\' "$F")'),
      [],
    );
  });

  it('validates only the first segment of nested paths', () => {
    assert.deepEqual(
      fieldsOf('v=$(jq -r \'.tasks[$i].lifecycle.deliveryEvidence.prNumber // empty\' "$F")'),
      [],
    );
  });

  it('honours `# allow-task-field:` on the finding line or just above', () => {
    assert.deepEqual(
      fieldsOf('v=$(jq -r \'.tasks[$i].prNumber\' "$F") # allow-task-field: legacy fallback'),
      [],
    );
    assert.deepEqual(
      fieldsOf('# allow-task-field: legacy fallback\nv=$(jq -r \'.tasks[$i].prNumber\' "$F")'),
      [],
    );
  });

  it('honours a marker up to the full suppression window above the finding', () => {
    const source = [
      '# allow-task-field: covers a multi-line jq filter',
      'state_mutate "$STATE_FILE" \\',
      '    \'.tasks[$issue].prNumber = $value',
      '     | .tasks[$issue].prNumber += 1\'',
    ].join('\n');
    assert.deepEqual(fieldsOf(source), []);
  });

  it('honours `// allow-task-field:` in TypeScript sources', () => {
    assert.deepEqual(
      fieldsOf('const v = row.tasks[id].prNumber; // allow-task-field: legacy', 'shared/lib/example.ts'),
      [],
    );
  });

  it('ignores whole-line comments that merely mention a forbidden field', () => {
    assert.deepEqual(fieldsOf('# .tasks[$i].prNumber is the HOK-3212 drift'), []);
    assert.deepEqual(fieldsOf('// row.tasks[id].prNumber is the drift pattern', 'shared/lib/example.ts'), []);
    assert.deepEqual(fieldsOf(' * `.tasks[$i].prNumber` in prose', 'shared/lib/example.ts'), []);
  });

  it('skips files whose extension is not shell/TS', () => {
    assert.deepEqual(fieldsOf('.tasks[$i].prNumber', 'shared/lib/example.md'), []);
  });

  it('reports fixture tests/fixtures/task-field-reads/reverted-hok-3212.sh with both drift reads on prNumber', () => {
    const path = join(repoRoot, 'tests/fixtures/task-field-reads/reverted-hok-3212.sh');
    const src = readFileSync(path, 'utf-8');
    const findings = extractTaskFieldReads('tests/fixtures/task-field-reads/reverted-hok-3212.sh', src, loadAllowedTaskFields(repoRoot));
    assert.equal(findings.length, 2, `expected 2 findings; got ${JSON.stringify(findings, null, 2)}`);
    for (const f of findings) assert.equal(f.field, 'prNumber');
    const patterns = findings.map((f) => f.pattern).sort();
    assert.deepEqual(patterns, ['get-task-meta', 'tasks-field-read']);
  });
});

describe('checkTaskFieldReadsForFile', () => {
  it('reports ok when no findings', () => {
    const result = checkTaskFieldReadsForFile('shared/lib/x.sh', 'echo hello', SMALL_ALLOWED);
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.match(formatTaskFieldReads(result), /^task-field-reads: ok/);
  });

  it('reports findings when fields are not allowed', () => {
    const result = checkTaskFieldReadsForFile(
      'shared/lib/x.sh',
      'v=$(jq -r \'.tasks[$i].prNumber\' "$F")',
      SMALL_ALLOWED,
    );
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].field, 'prNumber');
    assert.match(formatTaskFieldReads(result), /prNumber/);
  });
});

describe('checkTaskFieldReads', () => {
  it('this repository has no un-suppressed task-field drifts', () => {
    const result = checkTaskFieldReads(repoRoot);
    assert.deepEqual(result.findings, [], formatTaskFieldReads(result));
    assert.ok(result.scannedFiles > 0);
  });

  it('scans only tracked shared/hooks/tools shell and TS files, excluding tests', () => {
    const repo = mkdtempSync(join(tmpdir(), 'task-field-reads-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'shared/lib'), { recursive: true });
      mkdirSync(join(repo, 'shared/schemas'), { recursive: true });
      mkdirSync(join(repo, 'tests/fixtures/task-field-reads'), { recursive: true });

      // Minimal valid schema with a tiny TaskRecord.
      const schema = {
        $defs: {
          TaskRecord: {
            type: 'object',
            properties: { pr: { type: 'string' }, slug: { type: 'string' } },
          },
        },
      };
      writeFileSync(join(repo, WORKFLOW_TASK_SCHEMA_PATH), JSON.stringify(schema));

      // Forbidden read in a scanned file.
      writeFileSync(join(repo, 'shared/lib/drift.sh'), '#!/usr/bin/env bash\nv=$(jq -r \'.tasks[$i].prNumber\' "$F")\n');
      // Same read inside tests/ — must NOT fire in the main sweep.
      writeFileSync(
        join(repo, 'tests/fixtures/task-field-reads/drift.sh'),
        '#!/usr/bin/env bash\nv=$(jq -r \'.tasks[$i].prNumber\' "$F")\n',
      );
      // Suppressed read — must not fire.
      writeFileSync(
        join(repo, 'shared/lib/suppressed.sh'),
        '#!/usr/bin/env bash\n# allow-task-field: legacy fallback\nv=$(jq -r \'.tasks[$i].pullRequest\' "$F")\n',
      );
      execFileSync('git', ['add', '.'], { cwd: repo });

      const result = checkTaskFieldReads(repo);
      assert.equal(result.ok, false);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].file, 'shared/lib/drift.sh');
      assert.equal(result.findings[0].field, 'prNumber');

      // CLI exits 1 and prints the finding.
      const cli = spawnSync(process.execPath, [join(repoRoot, 'tools/check-task-field-reads.ts'), repo], { encoding: 'utf-8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /shared\/lib\/drift\.sh:2:\d+ \[tasks-field-read\]/);
      assert.match(cli.stderr, /prNumber/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 with a diagnostic when the schema is missing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'task-field-reads-noschema-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const cli = spawnSync(process.execPath, [join(repoRoot, 'tools/check-task-field-reads.ts'), repo], { encoding: 'utf-8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /check-task-field-reads:/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
