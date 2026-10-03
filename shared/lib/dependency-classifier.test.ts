import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  classifyDependencies,
  DEFAULT_CLASSIFIER_TEMPLATE_PATH,
  dedupEdges,
  filterInvalidIdEdges,
  filterLowConfidenceEdges,
  parseStrictClassifierJson,
  validateNoDriftFields,
  type AuthoritativeEdge,
  type ClassifierInput,
  type ClassifierOptions,
  type ClassifierOutput,
} from './dependency-classifier.ts';

let tempRoot: string;
let responsePath: string;
let logPath: string;
let cliPath: string;
let templatePath: string;

const baseIssues = [
  { id: 'HOK-1', title: 'One' },
  { id: 'HOK-2', title: 'Two' },
  { id: 'HOK-3', title: 'Three' },
];

const authoritative: AuthoritativeEdge[] = [
  { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'linear' },
];

function writeResponse(text: string): void {
  writeFileSync(responsePath, text, 'utf-8');
}

function readInvocations(): Array<{ stdin: string }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { stdin: string });
}

function baseInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    issues: baseIssues,
    authoritativeEdges: authoritative,
    confidenceThreshold: 0.7,
    ...overrides,
  };
}

function baseOptions(overrides: Partial<ClassifierOptions> = {}): ClassifierOptions {
  return {
    cliCmd: cliPath,
    templatePath,
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `dependency-classifier-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });

  responsePath = join(tempRoot, 'response.txt');
  logPath = join(tempRoot, 'invocations.log');
  templatePath = join(tempRoot, 'template.md');
  cliPath = join(tempRoot, 'mock-cli.mjs');

  writeFileSync(templatePath, 'ISSUES={{ISSUES}}\nAUTH={{AUTHORITATIVE_EDGES}}\nTH={{CONFIDENCE_THRESHOLD}}', 'utf-8');
  writeResponse('{"edges":[],"triage":[]}');

  const cliScript = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const responsePath = ${JSON.stringify(responsePath)};
const logPath = ${JSON.stringify(logPath)};
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf-8');
  appendFileSync(logPath, JSON.stringify({ stdin }) + '\\n');
  process.stdout.write(readFileSync(responsePath, 'utf-8'));
  process.exit(0);
});
process.stdin.resume();
`;
  writeFileSync(cliPath, cliScript, 'utf-8');
  chmodSync(cliPath, 0o755);
});

afterEach(() => {
  if (existsSync(tempRoot)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('parseStrictClassifierJson', () => {
  it('parses valid JSON object with required keys', () => {
    assert.deepEqual(parseStrictClassifierJson('{"edges":[],"triage":[]}'), { edges: [], triage: [] });
  });

  it('rejects markdown fence prefix', () => {
    assert.throws(
      () => parseStrictClassifierJson('```json\n{"edges":[],"triage":[]}\n```'),
      /markdown fence/
    );
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseStrictClassifierJson('not json'), /not valid JSON/);
  });

  it('rejects extra top-level keys', () => {
    assert.throws(() => parseStrictClassifierJson('{"edges":[],"triage":[],"extra":1}'), /exactly: edges, triage/);
  });

  it('rejects missing triage key', () => {
    assert.throws(() => parseStrictClassifierJson('{"edges":[]}'), /exactly: edges, triage/);
  });

  it('rejects top-level null', () => {
    assert.throws(() => parseStrictClassifierJson('null'), /must be a JSON object/);
  });

  it('rejects BOM prefix', () => {
    assert.throws(() => parseStrictClassifierJson('\uFEFF{"edges":[],"triage":[]}'), /BOM/);
  });
});

describe('validateNoDriftFields', () => {
  it('accepts clean object', () => {
    assert.doesNotThrow(() => validateNoDriftFields({ edges: [], triage: [] }));
  });

  it('rejects top-level waves', () => {
    assert.throws(() => validateNoDriftFields({ edges: [], triage: [], waves: [] }), /waves/);
  });

  it('rejects queues/order/schedule/sequence fields', () => {
    assert.throws(() => validateNoDriftFields({ edges: [{ queues: [] }], triage: [] }), /queues/);
    assert.throws(() => validateNoDriftFields({ edges: [{ order: 1 }], triage: [] }), /order/);
    assert.throws(() => validateNoDriftFields({ edges: [{ schedule: [] }], triage: [] }), /schedule/);
    assert.throws(() => validateNoDriftFields({ edges: [{ sequence: [] }], triage: [] }), /sequence/);
  });
});

describe('filter helpers', () => {
  it('filterInvalidIdEdges removes unknown from/to', () => {
    const valid = new Set(['HOK-1', 'HOK-2']);
    const result = filterInvalidIdEdges(
      [
        { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'linear' },
        { from: 'HOK-X', to: 'HOK-2', type: 'blocks', source: 'linear' },
        { from: 'HOK-1', to: 'HOK-Y', type: 'shared_surface', source: 'inferred', confidence: 0.9 },
      ],
      valid
    );

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'linear' });
  });

  it('filterLowConfidenceEdges applies only to inferred', () => {
    const result = filterLowConfidenceEdges(
      [
        { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'linear' },
        { from: 'HOK-1', to: 'HOK-2', type: 'shared_surface', source: 'inferred', confidence: 0.69 },
        { from: 'HOK-1', to: 'HOK-3', type: 'shared_surface', source: 'inferred', confidence: 0.7 },
      ],
      0.7
    );

    assert.equal(result.length, 2);
    assert.ok(result.some((edge) => edge.source === 'linear'));
    assert.ok(result.some((edge) => edge.source === 'inferred' && edge.confidence === 0.7));
  });

  it('dedupEdges enforces linear precedence and inferred confidence tie-break', () => {
    const deduped = dedupEdges([
      { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'inferred', confidence: 0.8 },
      { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'linear' },
      { from: 'HOK-2', to: 'HOK-1', type: 'blocks', source: 'inferred', confidence: 0.5 },
      { from: 'HOK-2', to: 'HOK-1', type: 'blocks', source: 'inferred', confidence: 0.9 },
      { from: 'HOK-1', to: 'HOK-2', type: 'shared_surface', source: 'inferred', confidence: 0.7 },
    ]);

    assert.equal(deduped.length, 3);
    assert.ok(deduped.some((edge) => edge.from === 'HOK-1' && edge.to === 'HOK-2' && edge.type === 'blocks' && edge.source === 'linear'));
    assert.ok(deduped.some((edge) => edge.from === 'HOK-2' && edge.to === 'HOK-1' && edge.type === 'blocks' && edge.source === 'inferred' && edge.confidence === 0.9));
    assert.ok(deduped.some((edge) => edge.from === 'HOK-1' && edge.to === 'HOK-2' && edge.type === 'shared_surface'));
  });
});

describe('classifyDependencies', () => {
  it('returns only edges and triage keys', async () => {
    writeResponse('{"edges":[],"triage":[]}');

    const result = await classifyDependencies(baseInput(), baseOptions());
    assert.deepEqual(Object.keys(result).sort(), ['edges', 'triage']);
  });

  it('drops invalid ID edges and invalid triage ids', async () => {
    writeResponse(JSON.stringify({
      edges: [
        { from: 'HOK-1', to: 'HOK-3', type: 'shared_surface', source: 'inferred', confidence: 0.8 },
        { from: 'HOK-404', to: 'HOK-3', type: 'shared_surface', source: 'inferred', confidence: 0.99 },
      ],
      triage: [{ id: 'HOK-1', risk: 'low' }, { id: 'HOK-404', risk: 'high' }],
    }));

    const result = await classifyDependencies(baseInput({ authoritativeEdges: [] }), baseOptions());
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].from, 'HOK-1');
    assert.deepEqual(result.triage, [{ id: 'HOK-1', risk: 'low' }]);
  });

  it('drops low-confidence inferred edges and keeps authoritative edges; threshold 0 keeps all', async () => {
    writeResponse(JSON.stringify({
      edges: [
        { from: 'HOK-1', to: 'HOK-2', type: 'shared_surface', source: 'inferred', confidence: 0.2 },
        { from: 'HOK-1', to: 'HOK-3', type: 'shared_surface', source: 'inferred', confidence: 0.7 },
      ],
      triage: [],
    }));

    const dropped = await classifyDependencies(baseInput(), baseOptions());
    assert.ok(dropped.edges.some((edge) => edge.source === 'linear'));
    assert.ok(dropped.edges.some((edge) => edge.source === 'inferred' && edge.to === 'HOK-3'));
    assert.ok(!dropped.edges.some((edge) => edge.source === 'inferred' && edge.to === 'HOK-2'));

    const keepAll = await classifyDependencies(baseInput({ confidenceThreshold: 0 }), baseOptions());
    assert.ok(keepAll.edges.some((edge) => edge.source === 'inferred' && edge.to === 'HOK-2'));
  });

  it('deduplicates with authoritative edges winning', async () => {
    writeResponse(JSON.stringify({
      edges: [
        { from: 'HOK-1', to: 'HOK-2', type: 'blocks', source: 'inferred', confidence: 0.95 },
      ],
      triage: [],
    }));

    const result = await classifyDependencies(baseInput(), baseOptions());
    const matching = result.edges.filter((edge) => edge.from === 'HOK-1' && edge.to === 'HOK-2' && edge.type === 'blocks');

    assert.equal(matching.length, 1);
    assert.equal(matching[0].source, 'linear');
  });

  it('rejects forbidden drift fields', async () => {
    writeResponse('{"edges":[],"triage":[],"waves":[]}');
    await assert.rejects(() => classifyDependencies(baseInput(), baseOptions()), /forbidden ordering field: waves/);

    writeResponse('{"edges":[{"order":1}],"triage":[]}');
    await assert.rejects(() => classifyDependencies(baseInput(), baseOptions()), /forbidden ordering field: order/);

    writeResponse('{"edges":[{"queues":[]}],"triage":[]}');
    await assert.rejects(() => classifyDependencies(baseInput(), baseOptions()), /forbidden ordering field: queues/);
  });

  it('rejects markdown fence output', async () => {
    writeResponse('```json\n{"edges":[],"triage":[]}\n```');
    await assert.rejects(() => classifyDependencies(baseInput(), baseOptions()), /markdown fence/);
  });

  it('rejects non-JSON output', async () => {
    writeResponse('plain text');
    await assert.rejects(() => classifyDependencies(baseInput(), baseOptions()), /not valid JSON/);
  });

  it('preserves authoritative edges verbatim', async () => {
    writeResponse('{"edges":[],"triage":[]}');
    const result = await classifyDependencies(baseInput(), baseOptions());
    assert.deepEqual(result.edges, authoritative);
  });

  it('validates threshold bounds and accepts 0/1', async () => {
    writeResponse('{"edges":[],"triage":[]}');

    await assert.rejects(() => classifyDependencies(baseInput({ confidenceThreshold: -0.1 }), baseOptions()), RangeError);
    await assert.rejects(() => classifyDependencies(baseInput({ confidenceThreshold: 1.5 }), baseOptions()), RangeError);
    await assert.rejects(() => classifyDependencies(baseInput({ confidenceThreshold: Number.NaN }), baseOptions()), RangeError);

    const zero = await classifyDependencies(baseInput({ confidenceThreshold: 0 }), baseOptions());
    const one = await classifyDependencies(baseInput({ confidenceThreshold: 1 }), baseOptions());
    assert.deepEqual(Object.keys(zero).sort(), ['edges', 'triage']);
    assert.deepEqual(Object.keys(one).sort(), ['edges', 'triage']);
  });

  it('uses default dependency-classifier template path when templatePath is omitted', async () => {
    writeResponse('{"edges":[],"triage":[]}');

    // Read-only hermetic check: load the real default template, extract a
    // distinctive non-placeholder line, and assert the CLI received a stdin
    // rendered from it. The test must never write to the tracked template —
    // a killed run otherwise leaves the worktree dirty (HOK-3157).
    const defaultTemplate = readFileSync(DEFAULT_CLASSIFIER_TEMPLATE_PATH, 'utf-8');
    const defaultSignature = defaultTemplate
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0 && !line.includes('{{'));
    assert.ok(defaultSignature, 'default classifier template has no non-placeholder line');

    await classifyDependencies(baseInput(), {
      cliCmd: cliPath,
    });

    const invocations = readInvocations();
    assert.ok(invocations.length > 0);
    assert.ok(
      invocations[0].stdin.includes(defaultSignature),
      'stdin should include a line from the default template',
    );
    // The beforeEach temp template renders "ISSUES=...": its presence would
    // mean classifyDependencies picked up the temp templatePath instead of
    // the default. Prove the default — not the beforeEach fixture — was used.
    assert.ok(
      !invocations[0].stdin.startsWith('ISSUES='),
      'stdin should not come from the beforeEach temp template',
    );
  });

  it('throws when modelsAvailable is empty', async () => {
    await assert.rejects(
      () => classifyDependencies(baseInput({ modelsAvailable: [] }), baseOptions()),
      /No models available/
    );
  });
});
