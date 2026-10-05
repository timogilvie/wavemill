import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  MAX_FILES_PER_IDENTIFIER,
  MAX_PREDICTED_FILES_PER_TASK,
  buildTouchSetPredictionPrompt,
  createGitRepoProbe,
  extractIdentifierCandidates,
  extractPathCandidates,
  parseTouchSetPrediction,
  predictTouchSet,
  predictTouchSetDeterministic,
  predictTouchSets,
  type RepoProbe,
  type TouchSetPredictionInput,
} from './touch-set-predictor.ts';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TRACKED = [
  'shared/lib/wavemill-monitor.sh',
  'shared/lib/tend-challenge-gate.ts',
  'shared/lib/tend-challenge-gate.test.ts',
  'shared/lib/task-dependency-planner.ts',
  'shared/lib/plan-queue-utils.ts',
  'tools/plan-queue.ts',
  'docs/queue-health.md',
];

function fakeProbe(opts: { grep?: Record<string, string[]>; definitions?: Record<string, string[]> } = {}): RepoProbe & { grepCalls: string[] } {
  const grepCalls: string[] = [];
  return {
    grepCalls,
    fileExists: (path) => TRACKED.includes(path),
    findByBasename: (name) => TRACKED.filter((path) => path.split('/').pop() === name),
    findBySuffix: (suffix) => TRACKED.filter((path) => path.endsWith(`/${suffix}`)),
    grepFiles: (identifier) => {
      grepCalls.push(identifier);
      return opts.grep?.[identifier] ?? [];
    },
    ...(opts.definitions ? { definitionFiles: (identifier: string) => opts.definitions![identifier] ?? [] } : {}),
  };
}

describe('extractPathCandidates', () => {
  it('finds backticked, bare, line-suffixed and ./-prefixed paths', () => {
    const result = extractPathCandidates(
      'Refactor `shared/lib/wavemill-monitor.sh`; fix `tend-challenge-gate.ts:878` and ./tools/plan-queue.ts:10-20.',
    );
    assert.deepEqual(result.paths.sort(), ['shared/lib/wavemill-monitor.sh', 'tools/plan-queue.ts']);
    assert.deepEqual(result.basenames, ['tend-challenge-gate.ts']);
  });

  it('ignores URLs, version numbers, and paths escaping the repo', () => {
    const result = extractPathCandidates('See https://example.com/docs/guide.md, v1.2.3, ../outside/file.ts, /etc/hosts.txt');
    assert.deepEqual(result.paths, []);
    assert.deepEqual(result.basenames, []);
  });
});

describe('extractIdentifierCandidates', () => {
  it('keeps camelCase, snake_case and CONST_CASE identifiers from backticks', () => {
    assert.deepEqual(
      extractIdentifierCandidates('Use `packWaves`, `wavemill_hook_read()`, `MAX_RETRIES`, `Foo.selectFirstWave(plan)`.'),
      ['packWaves', 'wavemill_hook_read', 'MAX_RETRIES', 'selectFirstWave'],
    );
  });

  it('ignores prose, file paths, issue IDs and verdict words', () => {
    assert.deepEqual(
      extractIdentifierCandidates('`Thin Tools` `config` `HOK-3128` `tools/plan-queue.ts` `must_precede` `README` `x`'),
      [],
    );
  });

  it('deduplicates identifiers', () => {
    assert.deepEqual(extractIdentifierCandidates('`packWaves` and again `packWaves()`'), ['packWaves']);
  });
});

describe('predictTouchSetDeterministic', () => {
  it('Issue A: explicit path → explicit source', () => {
    const set = predictTouchSetDeterministic(
      { id: 'A', title: 'Readability', description: 'Refactor `shared/lib/wavemill-monitor.sh` to improve readability.' },
      fakeProbe(),
    );
    assert.deepEqual(set.entries, [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit' }]);
    assert.equal(set.vague, false);
  });

  it('Issue B: bare filename with line ref → resolved, preferring the implementation over its test', () => {
    const set = predictTouchSetDeterministic(
      { id: 'B', title: 'Gate bug', description: 'Fix bug in `tend-challenge-gate.ts:878`.' },
      fakeProbe(),
    );
    assert.deepEqual(set.entries, [{ path: 'shared/lib/tend-challenge-gate.ts', source: 'resolved' }]);
  });

  it('resolves a partial path by unique suffix', () => {
    const set = predictTouchSetDeterministic({ id: 'P', description: 'Edit lib/plan-queue-utils.ts' }, fakeProbe());
    assert.deepEqual(set.entries, [{ path: 'shared/lib/plan-queue-utils.ts', source: 'resolved' }]);
  });

  it('Issue C: no candidates at all marks the task vague', () => {
    const set = predictTouchSetDeterministic({ id: 'C', title: 'Improve scheduling', description: 'Improve the overall task scheduling logic.' }, fakeProbe());
    assert.deepEqual(set.entries, []);
    assert.equal(set.vague, true);
  });

  it('a non-existent path yields an empty, non-vague touch set', () => {
    const set = predictTouchSetDeterministic({ id: 'N', description: 'Delete `shared/lib/does-not-exist.ts`.' }, fakeProbe());
    assert.deepEqual(set.entries, []);
    assert.equal(set.vague, false);
  });

  it('combines explicit paths and resolved identifiers, attaching symbols', () => {
    const probe = fakeProbe({ grep: { packWaves: ['shared/lib/task-dependency-planner.ts'], pollLoop: ['shared/lib/wavemill-monitor.sh'] } });
    const set = predictTouchSetDeterministic(
      { id: 'M', description: 'Touch `tools/plan-queue.ts`, `packWaves`, and `pollLoop`.' },
      probe,
    );
    assert.deepEqual(set.entries, [
      { path: 'shared/lib/task-dependency-planner.ts', source: 'resolved', symbols: ['packWaves'] },
      { path: 'shared/lib/wavemill-monitor.sh', source: 'resolved', symbols: ['pollLoop'] },
      { path: 'tools/plan-queue.ts', source: 'explicit' },
    ]);
  });

  it('keeps the explicit source when an identifier resolves into an explicit file', () => {
    const probe = fakeProbe({ grep: { pollLoop: ['shared/lib/wavemill-monitor.sh'] } });
    const set = predictTouchSetDeterministic(
      { id: 'E', description: '`shared/lib/wavemill-monitor.sh`: split `pollLoop`' },
      probe,
    );
    assert.deepEqual(set.entries, [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit', symbols: ['pollLoop'] }]);
  });

  it('prefers definition files over call sites', () => {
    const probe = fakeProbe({
      grep: { wavemill_hook_read: ['shared/lib/wavemill-monitor.sh', 'tools/plan-queue.ts', 'shared/lib/plan-queue-utils.ts'] },
      definitions: { wavemill_hook_read: ['shared/lib/wavemill-monitor.sh'] },
    });
    const set = predictTouchSetDeterministic({ id: 'D', description: 'Fix `wavemill_hook_read`' }, probe);
    assert.deepEqual(set.entries.map((entry) => entry.path), ['shared/lib/wavemill-monitor.sh']);
  });

  it('skips identifiers that match too many files to be evidence', () => {
    const many = Array.from({ length: MAX_FILES_PER_IDENTIFIER + 1 }, (_, index) => `src/file${index}.ts`);
    const set = predictTouchSetDeterministic({ id: 'G', description: 'Rename `loadConfig`' }, fakeProbe({ grep: { loadConfig: many } }));
    assert.deepEqual(set.entries, []);
    assert.equal(set.vague, false);
  });

  it('caps identifier resolution at five per task', () => {
    const probe = fakeProbe();
    predictTouchSetDeterministic({ id: 'F', description: '`aaaOne` `aaaTwo` `aaaThree` `aaaFour` `aaaFive` `aaaSix`' }, probe);
    assert.equal(probe.grepCalls.length, 5);
  });
});

describe('parseTouchSetPrediction', () => {
  const probe = fakeProbe();

  it('accepts fenced JSON, drops unknown tasks and missing files, and labels entries predicted', () => {
    const raw = '```json\n{"predictions":[{"id":"C","files":["tools/plan-queue.ts","./shared/lib/plan-queue-utils.ts","nope.ts","/abs.ts"]},{"id":"Z","files":["tools/plan-queue.ts"]}]}\n```';
    const result = parseTouchSetPrediction(raw, ['C'], probe);
    assert.deepEqual([...result.keys()], ['C']);
    assert.deepEqual(result.get('C'), [
      { path: 'shared/lib/plan-queue-utils.ts', source: 'predicted' },
      { path: 'tools/plan-queue.ts', source: 'predicted' },
    ]);
  });

  it('caps predicted files per task', () => {
    const lots = Array.from({ length: 20 }, () => TRACKED).flat();
    const result = parseTouchSetPrediction(JSON.stringify({ predictions: [{ id: 'C', files: lots }] }), ['C'], { fileExists: () => true });
    assert.ok(result.get('C')!.length <= MAX_PREDICTED_FILES_PER_TASK);
  });

  it('throws on malformed output', () => {
    assert.throws(() => parseTouchSetPrediction('not json', ['C'], probe));
    assert.throws(() => parseTouchSetPrediction('{"files":[]}', ['C'], probe), /predictions array/);
  });
});

describe('buildTouchSetPredictionPrompt', () => {
  it('fills tree and task placeholders', () => {
    const prompt = buildTouchSetPredictionPrompt(
      'TREE:\n{{DIRECTORY_TREE}}\nTASKS:\n{{TASKS}}',
      [{ task: { id: 'C', title: 'Improve scheduling', description: 'desc' }, keywordHits: 'Keyword: "scheduling"\n./tools/plan-queue.ts' }],
      './shared\n./tools',
    );
    assert.match(prompt, /TREE:\n\.\/shared\n\.\/tools/);
    assert.match(prompt, /- id: C\n  title: "Improve scheduling"/);
    assert.match(prompt, /keywordHits: \|\n    Keyword: "scheduling"\n    \.\/tools\/plan-queue\.ts/);
    assert.doesNotMatch(prompt, /\{\{/);
  });
});

describe('predictTouchSets', () => {
  it('Issue C: predicts vague tasks with one batched LLM call', async () => {
    const calls: TouchSetPredictionInput[][] = [];
    const sets = await predictTouchSets(
      [
        { id: 'A', description: '`shared/lib/wavemill-monitor.sh`' },
        { id: 'C', title: 'Improve scheduling', description: 'Improve the overall task scheduling logic.' },
        { id: 'D', title: 'Improve dashboard', description: 'Make it nicer.' },
      ],
      {
        probe: fakeProbe(),
        keywordHits: (task) => `hits for ${task.id}`,
        llmPredict: async (inputs) => {
          calls.push(inputs);
          return JSON.stringify({ predictions: [{ id: 'C', files: ['tools/plan-queue.ts', 'ghost.ts'] }, { id: 'D', files: [] }] });
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((input) => input.task.id), ['C', 'D']);
    assert.equal(calls[0][0].keywordHits, 'hits for C');
    assert.deepEqual(sets, [
      { taskId: 'A', entries: [{ path: 'shared/lib/wavemill-monitor.sh', source: 'explicit' }] },
      { taskId: 'C', entries: [{ path: 'tools/plan-queue.ts', source: 'predicted' }] },
      { taskId: 'D', entries: [] },
    ]);
  });

  it('does not call the LLM for non-vague tasks, even with empty touch sets', async () => {
    let called = false;
    const sets = await predictTouchSets([{ id: 'N', description: '`shared/lib/missing.ts`' }], {
      probe: fakeProbe(),
      llmPredict: async () => {
        called = true;
        return '{"predictions":[]}';
      },
    });
    assert.equal(called, false);
    assert.deepEqual(sets, [{ taskId: 'N', entries: [] }]);
  });

  it('never throws when the LLM fails; vague tasks keep empty touch sets', async () => {
    const warnings: string[] = [];
    const set = await predictTouchSet({ id: 'C', title: 'Vague' }, {
      probe: fakeProbe(),
      llmPredict: async () => {
        throw new Error('quota exhausted');
      },
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(set, { taskId: 'C', entries: [] });
    assert.match(warnings[0], /quota exhausted/);
  });

  it('leaves vague tasks empty when no LLM is configured', async () => {
    assert.deepEqual(await predictTouchSet({ id: 'C', title: 'Vague' }, { probe: fakeProbe() }), { taskId: 'C', entries: [] });
  });
});

describe('createGitRepoProbe (this repository)', () => {
  const probe = createGitRepoProbe(repoDir);

  it('checks files on disk and rejects directories and escapes', () => {
    assert.equal(probe.fileExists('shared/lib/touch-set-predictor.ts'), true);
    assert.equal(probe.fileExists('shared/lib'), false);
    assert.equal(probe.fileExists('../etc/passwd'), false);
    assert.equal(probe.fileExists('shared/lib/definitely-missing-file.ts'), false);
  });

  it('resolves basenames and suffixes against tracked files', () => {
    assert.ok(probe.findByBasename('tend-challenge-gate.ts').includes('shared/lib/tend-challenge-gate.ts'));
    assert.deepEqual(probe.findBySuffix('lib/plan-queue-utils.ts'), ['shared/lib/plan-queue-utils.ts']);
  });

  it('greps identifiers and finds their definition file', () => {
    assert.ok(probe.grepFiles('planTaskDependencies').includes('shared/lib/task-dependency-planner.ts'));
    assert.deepEqual(probe.definitionFiles!('planTaskDependencies'), ['shared/lib/task-dependency-planner.ts']);
    assert.deepEqual(probe.grepFiles('not an identifier'), []);
  });

  it('reads a historical commit when given a ref', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'touch-set-ref-probe-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: tmp, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(tmp, 'lib'));
      writeFileSync(join(tmp, 'lib', 'old.ts'), 'export function oldHelper() {}\n');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      const first = git('rev-parse', 'HEAD');
      writeFileSync(join(tmp, 'lib', 'new.ts'), 'export function newHelper() { oldHelper(); }\n');
      git('add', '.');
      git('commit', '-q', '-m', 'two');

      const before = createGitRepoProbe(tmp, { ref: first });
      assert.equal(before.fileExists('lib/old.ts'), true);
      assert.equal(before.fileExists('lib/new.ts'), false, 'a file created later is invisible at the earlier ref');
      assert.deepEqual(before.findByBasename('new.ts'), []);
      assert.deepEqual(before.grepFiles('newHelper'), []);
      assert.deepEqual(before.grepFiles('oldHelper'), ['lib/old.ts']);
      assert.deepEqual(before.definitionFiles!('oldHelper'), ['lib/old.ts']);

      const now = createGitRepoProbe(tmp);
      assert.equal(now.fileExists('lib/new.ts'), true);
      assert.deepEqual(now.grepFiles('oldHelper').sort(), ['lib/new.ts', 'lib/old.ts']);
      assert.deepEqual(now.definitionFiles!('oldHelper'), ['lib/old.ts']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
