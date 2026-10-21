import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildReviewInput,
  classifyTier,
  reviewInputBudgetFromAdapter,
  splitDiffByFile,
  type ReviewInputBudget,
} from './review-input-budget.ts';
import { ClaudeCliAdapter } from './model-adapters/claude-cli-adapter.ts';
import { CodexCliAdapter } from './model-adapters/codex-cli-adapter.ts';

/** A `git diff` chunk adding `path` with `content`. */
function added(path: string, content: string): string {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function modified(path: string, before: string, after: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '',
  ].join('\n');
}

const bytes: ReviewInputBudget['countTokens'] = (text) => Buffer.byteLength(text, 'utf8');

/** HOK-2804-shaped report contract: a large base fixture plus near-copies. */
function reportFixture(repoName: string, schemaRef?: string): string {
  const scanners = Array.from({ length: 400 }, (_, i) => ({
    id: `scanner-${i}`,
    findings: [{ rule: `rule-${i}`, severity: i % 3 === 0 ? 'high' : 'low', line: i }],
  }));
  return `${JSON.stringify({ ...(schemaRef ? { $schema: schemaRef } : {}), version: 1, repo: { name: repoName }, scanners }, null, 2)}\n`;
}

const REPORT_SCHEMA = `${JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'repo', 'scanners'],
  properties: {
    version: { const: 1 },
    repo: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[a-z-]+$' } } },
    scanners: { type: 'array' },
  },
}, null, 2)}\n`;

function hok2804Diff(): string {
  return [
    added('contracts/report.schema.json', REPORT_SCHEMA),
    added('contracts/fixtures/full.v1.json', reportFixture('hokusai-site')),
    added('contracts/fixtures/invalid/dotdot-name.json', reportFixture('..')),
    added('contracts/fixtures/invalid/upper-name.json', reportFixture('Hokusai')),
    added('src/report/scanner.ts', 'export function scan(): number {\n  return 1;\n}\n'),
    added('src/report/scanner.test.ts', "import { scan } from './scanner.ts';\nscan();\n"),
    added('docs/report-contract.md', '# Report contract\n\nVersioned JSON.\n'),
  ].join('');
}

describe('classifyTier (HOK-3249)', () => {
  it('orders source, tests, docs/config, then data/fixture/generated', () => {
    assert.equal(classifyTier('shared/lib/review-engine.ts'), 1);
    assert.equal(classifyTier('tools/wavemill'), 1);
    assert.equal(classifyTier('app/styles/theme.css'), 1);
    assert.equal(classifyTier('shared/lib/review-engine.test.ts'), 2);
    assert.equal(classifyTier('tests/launch-ready-phase.test.sh'), 2);
    assert.equal(classifyTier('tests/fixtures/helper.ts'), 2);
    assert.equal(classifyTier('docs/feature-flags.md'), 3);
    assert.equal(classifyTier('wavemill-config.schema.json'), 3);
    assert.equal(classifyTier('.gitignore'), 3);
    assert.equal(classifyTier('tests/fixtures/task-identity-cases.json'), 4);
    assert.equal(classifyTier('shared/lib/foo.fixtures.json'), 4);
    assert.equal(classifyTier('package-lock.json'), 4);
    assert.equal(classifyTier('dist/bundle.js'), 4);
    assert.equal(classifyTier('.wavemill/evals/evals.jsonl'), 4);
  });
});

describe('splitDiffByFile (HOK-3249)', () => {
  it('keeps every chunk byte-for-byte and names its path', () => {
    const diff = added('a.ts', 'x\n') + modified('b/c.md', 'old', 'new');
    const files = splitDiffByFile(diff);
    assert.deepEqual(files.map((file) => file.path), ['a.ts', 'b/c.md']);
    assert.equal(files.map((file) => file.chunk).join(''), diff);
  });
});

describe('buildReviewInput (HOK-3249)', () => {
  it('passes a diff that fits through verbatim and unchanged', () => {
    const diff = added('src/a.ts', 'export const a = 1;\n') + added('src/a.test.ts', 'a;\n');
    const result = buildReviewInput(diff, { countTokens: bytes });
    assert.equal(result.summarisedCount, 0);
    assert.equal(result.withinBudget, true);
    // Tier order puts source before tests.
    assert.equal(result.text, added('src/a.ts', 'export const a = 1;\n') + added('src/a.test.ts', 'a;\n'));
  });

  it('is byte-identical across calls and input orderings', () => {
    const chunks = splitDiffByFile(hok2804Diff()).map((file) => file.chunk);
    const budget = { countTokens: bytes, maxTokens: 60_000 };
    const first = buildReviewInput(chunks.join(''), budget);
    const second = buildReviewInput(chunks.join(''), budget);
    const reversed = buildReviewInput([...chunks].reverse().join(''), budget);
    assert.equal(first.text, second.text);
    assert.equal(first.text, reversed.text);
    assert.deepEqual(first.files, reversed.files);
  });

  it('summarises data files above the size threshold even when the budget is unbounded', () => {
    const result = buildReviewInput(hok2804Diff(), { countTokens: bytes });
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    for (const path of ['contracts/fixtures/full.v1.json', 'contracts/fixtures/invalid/dotdot-name.json']) {
      assert.equal(byPath.get(path)?.mode, 'summarised');
      assert.equal(byPath.get(path)?.reason, 'size');
    }
    for (const path of ['src/report/scanner.ts', 'src/report/scanner.test.ts', 'docs/report-contract.md', 'contracts/report.schema.json']) {
      assert.equal(byPath.get(path)?.mode, 'verbatim', path);
    }
    assert.match(result.text, /^=== review input: 4 file\(s\) verbatim, 3 summarised/);
    assert.match(result.text, /summarised instead of shown verbatim/);
  });

  it('reports size, sha256, schema validation and the nearest-sibling structural diff', () => {
    const result = buildReviewInput(hok2804Diff(), { countTokens: bytes });
    const content = reportFixture('..');
    const sha = createHash('sha256').update(content).digest('hex');
    assert.ok(result.text.includes(`added; ${Buffer.byteLength(content)} B; sha256 ${sha}`));
    assert.match(result.text, /full\.v1\.json[^\n]*\nadded; \d+ B; sha256 [0-9a-f]{64}\nschema: valid against contracts\/report\.schema\.json/);
    assert.match(
      result.text,
      /invalid\/dotdot-name\.json[^\n]*\n[^\n]*\nschema: INVALID against contracts\/report\.schema\.json \(1 error\(s\)\)\n {2}\/repo\/name must match pattern/,
    );
    assert.match(result.text, /structure: = contracts\/fixtures\/full\.v1\.json with 1 change\(s\)\n {2}\/repo\/name: "hokusai-site" → "\.\."/);
    // Equal change counts prefer the shallower base over a peer in invalid/.
    assert.match(result.text, /invalid\/upper-name\.json[\s\S]*structure: = contracts\/fixtures\/full\.v1\.json with 1 change\(s\)\n {2}\/repo\/name: "hokusai-site" → "Hokusai"/);
  });

  it('keeps source and tests verbatim and summarises lower tiers once the budget is exhausted', () => {
    const source = added('src/big.ts', `${'export const x = 1;\n'.repeat(200)}`);
    const test = added('src/big.test.ts', `${'x;\n'.repeat(200)}`);
    const docs = added('docs/guide.md', `${'words\n'.repeat(400)}`);
    const data = added('tests/fixtures/small.json', '{"a": 1}\n');
    const diff = data + docs + test + source;
    const budget = { countTokens: bytes, maxTokens: Buffer.byteLength(source + test) + 1_200 };
    const result = buildReviewInput(diff, budget);
    assert.deepEqual(
      result.files.map((file) => [file.path, file.mode]),
      [['src/big.ts', 'verbatim'], ['src/big.test.ts', 'verbatim'], ['docs/guide.md', 'summarised'], ['tests/fixtures/small.json', 'summarised']],
    );
    assert.equal(result.files[2].reason, 'budget');
    assert.equal(result.withinBudget, true);
    assert.ok(result.text.includes(source) && result.text.includes(test));
    assert.ok(bytes(result.text) <= budget.maxTokens);
  });

  it('reports over budget when source alone cannot fit, never summarising code', () => {
    const source = added('src/huge.ts', 'export const y = 2;\n'.repeat(500));
    const result = buildReviewInput(source, { countTokens: bytes, maxTokens: 1_000 });
    assert.equal(result.withinBudget, false);
    assert.equal(result.files[0].mode, 'verbatim');
  });

  it('honours a character cap independently of tokens', () => {
    const fixtures = Array.from({ length: 20 }, (_, i) =>
      added(`tests/fixtures/case-${String(i).padStart(2, '0')}.json`, `${JSON.stringify({ i, pad: 'p'.repeat(2_000) })}\n`));
    const diff = added('src/a.ts', 'export {};\n') + fixtures.join('');
    const result = buildReviewInput(diff, { countTokens: () => 0, maxChars: 10_000 });
    assert.equal(result.withinBudget, true);
    assert.ok(result.text.length <= 10_000, `length ${result.text.length}`);
    assert.ok(result.summarisedCount > 0);
  });

  it('resolves a declared $schema relative to the file, inside or outside the diff', () => {
    const fixture = (ref: string) => `${JSON.stringify({ $schema: ref, version: 2, repo: { name: 'x' }, scanners: [] })}\n`;
    const diff = added('contracts/fixtures/a.json', fixture('../report.schema.json'))
      + added('contracts/fixtures/b.json', fixture('../../schemas/external.schema.json'))
      + added('contracts/report.schema.json', REPORT_SCHEMA);
    const result = buildReviewInput(diff, { countTokens: bytes }, {
      thresholdBytes: 0,
      readFile: (path) => (path === 'schemas/external.schema.json' ? '{"type": "object"}' : null),
    });
    assert.match(result.text, /fixtures\/a\.json[^\n]*\n[^\n]*\nschema: INVALID against contracts\/report\.schema\.json \(1 error\(s\)\)\n {2}\/version must be equal to constant/);
    assert.match(result.text, /fixtures\/b\.json[^\n]*\n[^\n]*\nschema: valid against schemas\/external\.schema\.json/);
  });

  it('uses readFile for modified data files and falls back to the patch sha without it', () => {
    const diff = modified('tests/fixtures/state.json', '{"a": 1}', '{"a": 2}');
    const withReader = buildReviewInput(diff, { countTokens: bytes, maxTokens: 0 }, { readFile: () => '{"a": 2}\n' });
    assert.match(withReader.text, /modified; 9 B; sha256 [0-9a-f]{64}\nschema: none declared or discoverable/);
    const withoutReader = buildReviewInput(diff, { countTokens: bytes, maxTokens: 0 });
    assert.match(withoutReader.text, /modified; diff \d+ B; patch sha256 [0-9a-f]{64}/);
  });

  it('fits the HOK-2804 shape (2.5 MB of near-copy fixtures) inside both the codex and claude limits', () => {
    const base = reportFixture('hokusai-site');
    const fixtures = Array.from({ length: 39 }, (_, i) =>
      added(`contracts/fixtures/invalid/case-${String(i).padStart(2, '0')}.json`, base.replace('"hokusai-site"', `"case-${i}"`)));
    const code = added('src/report/scanner.ts', `${'export const scanned = true;\n'.repeat(5_000)}`);
    const diff = added('contracts/report.schema.json', REPORT_SCHEMA) + fixtures.join('') + code;
    assert.ok(diff.length > 2_500_000, `diff is ${diff.length} chars`);

    const reserved = 'x'.repeat(40_000);
    for (const adapter of [
      new CodexCliAdapter({ model: 'gpt-5.5' }),
      new ClaudeCliAdapter({ model: 'claude-opus-5-5' }),
    ]) {
      const result = buildReviewInput(diff, reviewInputBudgetFromAdapter(adapter, reserved));
      assert.equal(result.withinBudget, true, adapter.kind);
      assert.ok(result.text.includes(code), `${adapter.kind}: code stays verbatim`);
      assert.equal(result.summarisedCount, 39);
      assert.equal(adapter.preflight(reserved + result.text), undefined, `${adapter.kind} preflight`);
    }
  });
});

describe('reviewInputBudgetFromAdapter (HOK-3249)', () => {
  it('leaves room for the template, harness, output and safety margin', () => {
    const budget = reviewInputBudgetFromAdapter({
      kind: 'claude-cli',
      model: 'm',
      limits: { contextWindowTokens: 110_000, maxOutputTokens: 0, cliHarnessOverheadTokens: 10_000, maxInputChars: 50_000 },
      countTokens: (text) => text.length,
      preflight: () => undefined,
      invoke: async () => ({ text: '', reportedModel: 'unverified' }),
      parseResult: () => ({ text: '', reportedModel: 'unverified' }),
    }, 'x'.repeat(1_000));
    assert.equal(budget.maxTokens, Math.floor(110_000 / 1.1) - 10_000 - 1_000 - 2_048);
    assert.equal(budget.maxChars, 50_000 - 1_000 - 2_048);
  });

  it('is unbounded in tokens when the registry has no context window', () => {
    const budget = reviewInputBudgetFromAdapter(new ClaudeCliAdapter({ model: 'not-a-registered-model' }), '');
    assert.equal(budget.maxTokens, undefined);
  });
});
