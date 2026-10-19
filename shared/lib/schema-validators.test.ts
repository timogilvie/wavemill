import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clearConfigCache, loadWavemillConfig } from './config.ts';
import {
  checkPrecompiledValidators,
  compileSchemaValidator,
  DEFAULT_REPO_ROOT,
  DEFAULT_VALIDATORS_DIR,
  hasValidationStamp,
  loadPrecompiledValidator,
  PRECOMPILED_SCHEMAS,
  readRefSchemas,
  recordValidationStamp,
  schemaSourceText,
  type PrecompiledSchemaSpec,
} from './schema-validators.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** One accepted and one rejected document per precompiled schema. */
const SAMPLES: Record<string, { good: unknown; bad: unknown[] }> = {
  'model-registry': {
    good: JSON.parse(readFileSync(join(repoRoot, 'shared', 'fixtures', 'model-registry.v1.json'), 'utf-8')),
    bad: [{ schemaVersion: '2', models: [], ladders: {} }, { schemaVersion: '1', models: 'nope', ladders: {} }],
  },
  'wavemill-config': {
    good: JSON.parse(readFileSync(join(repoRoot, '.wavemill-config.json'), 'utf-8')),
    bad: [{ totallyUnknownTopLevelKey: true }, { router: { enabled: 'yes' } }],
  },
  'eval-record': {
    good: {},
    bad: [{ schemaVersion: 42 }, []],
  },
  'workflow-state': {
    good: {
      session: 'wavemill',
      tasks: {
        'HOK-1': {
          slug: 'one',
          pr: '12',
          challenge: true,
          lifecycle: { schemaVersion: 1, workflowOutcome: 'active', resourceDisposition: 'allocated', attempt: null },
        },
      },
    },
    bad: [
      { tasks: { 'HOK-1': { challenge: 'true' } } },
      { tasks: { 'HOK-1': { lifecycle: { schemaVersion: 2 } } } },
      { tasks: [] },
    ],
  },
};

function schemaText(spec: PrecompiledSchemaSpec): string {
  return schemaSourceText(spec, repoRoot);
}

/** Copy the schemas + committed artifacts into a scratch repo root. */
function makeScratchRepo(): { root: string; validatorsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'schema-validators-'));
  for (const spec of PRECOMPILED_SCHEMAS) {
    for (const path of [spec.schemaPath, ...(spec.refSchemaPaths ?? [])]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repoRoot, path), join(root, path));
    }
  }
  const validatorsDir = join(root, 'shared', 'validators');
  cpSync(DEFAULT_VALIDATORS_DIR, validatorsDir, { recursive: true });
  return { root, validatorsDir };
}

describe('committed standalone validators', () => {
  it('are in sync with their schemas', () => {
    assert.deepEqual(checkPrecompiledValidators(), []);
  });

  for (const spec of PRECOMPILED_SCHEMAS) {
    it(`${spec.name}: accepts and rejects exactly like a runtime compile`, () => {
      const text = schemaText(spec);
      const precompiled = loadPrecompiledValidator(spec.name, text, spec.ajvOptions, spec.ajvModule);
      assert.ok(precompiled, 'precompiled validator should load for the current schema');
      const compiled = compileSchemaValidator(
        JSON.parse(readFileSync(join(repoRoot, spec.schemaPath), 'utf-8')),
        spec.ajvOptions,
        spec.ajvModule,
        readRefSchemas(spec, repoRoot),
      );
      const samples = SAMPLES[spec.name];
      assert.ok(samples, `add SAMPLES for ${spec.name}`);

      for (const doc of [samples.good, ...samples.bad]) {
        const expected = compiled(doc);
        assert.equal(precompiled(doc), expected);
        assert.deepEqual(precompiled.errors ?? null, compiled.errors ?? null);
      }
      assert.equal(precompiled(samples.bad[0]), false, 'bad sample must be rejected');
    });
  }
});

describe('loadPrecompiledValidator', () => {
  const spec = PRECOMPILED_SCHEMAS.find((entry) => entry.name === 'model-registry')!;

  it('misses when the schema bytes differ from the generated artifact', () => {
    assert.equal(loadPrecompiledValidator(spec.name, `${schemaText(spec)} `, spec.ajvOptions), null);
  });

  it('misses when the requested Ajv options or module differ', () => {
    assert.equal(loadPrecompiledValidator(spec.name, schemaText(spec), { allErrors: false }), null);
    assert.equal(loadPrecompiledValidator(spec.name, schemaText(spec), spec.ajvOptions, 'ajv/dist/2020'), null);
  });

  it('misses when the artifact is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'schema-validators-empty-'));
    try {
      assert.equal(loadPrecompiledValidator(spec.name, schemaText(spec), spec.ajvOptions, 'ajv', empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('checkPrecompiledValidators drift detection', () => {
  let scratch: { root: string; validatorsDir: string };
  beforeEach(() => {
    scratch = makeScratchRepo();
  });
  afterEach(() => {
    rmSync(scratch.root, { recursive: true, force: true });
  });

  it('passes on an untouched copy', () => {
    assert.deepEqual(checkPrecompiledValidators(scratch.root, scratch.validatorsDir), []);
  });

  it('fails when a schema changes without regenerating', () => {
    const schemaPath = join(scratch.root, 'shared', 'schemas', 'model-registry.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    schema.description = 'edited';
    writeFileSync(schemaPath, JSON.stringify(schema));
    const problems = checkPrecompiledValidators(scratch.root, scratch.validatorsDir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /model-registry: .*schema sha256 mismatch/);
  });

  it('fails when a referenced schema changes without regenerating', () => {
    const refPath = join(scratch.root, 'shared', 'schemas', 'task-lifecycle-state.schema.json');
    writeFileSync(refPath, `${readFileSync(refPath, 'utf-8')}\n`);
    const problems = checkPrecompiledValidators(scratch.root, scratch.validatorsDir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /workflow-state: .*schema sha256 mismatch/);
  });

  it('fails when a schema is malformed JSON (HOK-2908 class)', () => {
    writeFileSync(join(scratch.root, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');
    const problems = checkPrecompiledValidators(scratch.root, scratch.validatorsDir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /wavemill-config\.schema\.json: schema is unreadable or not valid JSON/);
  });

  it('fails when the generated code is hand-edited or the meta is missing', () => {
    writeFileSync(join(scratch.validatorsDir, 'eval-record.validator.cjs'), 'module.exports = () => true;\n');
    rmSync(join(scratch.validatorsDir, 'model-registry.validator.meta.json'));
    const problems = checkPrecompiledValidators(scratch.root, scratch.validatorsDir);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((problem) => /model-registry: missing or unreadable/.test(problem)));
    assert.ok(problems.some((problem) => /eval-record: .*code sha256 mismatch/.test(problem)));
  });

  it('CLI exits non-zero on drift and names the regenerate command', () => {
    const schemaPath = join(scratch.root, 'shared', 'lib', 'eval-schema.json');
    writeFileSync(schemaPath, `${readFileSync(schemaPath, 'utf-8')}\n`);
    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        'npx',
        ['tsx', join(DEFAULT_REPO_ROOT, 'tools', 'check-schema-validators.ts'), scratch.root, scratch.validatorsDir],
        { stdio: 'pipe', encoding: 'utf-8' },
      );
    } catch (error) {
      status = (error as { status: number }).status;
      stderr = (error as { stderr: string }).stderr;
    }
    assert.equal(status, 1);
    assert.match(stderr, /eval-record: .*schema sha256 mismatch/);
    assert.match(stderr, /npx tsx tools\/generate-schema-validators\.ts/);
  });

  it('CLI fails when a schema no longer compiles', () => {
    writeFileSync(join(scratch.root, 'shared', 'schemas', 'model-registry.schema.json'), '{"type":5}\n');
    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        'npx',
        ['tsx', join(DEFAULT_REPO_ROOT, 'tools', 'check-schema-validators.ts'), scratch.root, scratch.validatorsDir],
        { stdio: 'pipe', encoding: 'utf-8' },
      );
    } catch (error) {
      status = (error as { status: number }).status;
      stderr = (error as { stderr: string }).stderr;
    }
    assert.equal(status, 1);
    assert.match(stderr, /model-registry\.schema\.json: schema does not compile/);
  });
});

describe('config loading with a malformed schema', () => {
  it('still fails loudly when the worktree schema is malformed JSON', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'schema-validators-config-'));
    try {
      writeFileSync(join(repoDir, 'wavemill-config.schema.json'), '{\n  "type": "object"\n}\n,\n{}\n');
      writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n');
      clearConfigCache();
      assert.throws(() => loadWavemillConfig(repoDir));
    } finally {
      clearConfigCache();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('validation stamps', () => {
  let stampDir: string;
  const savedDir = process.env.WAVEMILL_SCHEMA_STAMP_DIR;
  const savedDisable = process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
  beforeEach(() => {
    stampDir = mkdtempSync(join(tmpdir(), 'schema-stamps-'));
    process.env.WAVEMILL_SCHEMA_STAMP_DIR = stampDir;
    delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
  });
  afterEach(() => {
    rmSync(stampDir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.WAVEMILL_SCHEMA_STAMP_DIR;
    else process.env.WAVEMILL_SCHEMA_STAMP_DIR = savedDir;
    if (savedDisable === undefined) delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
    else process.env.WAVEMILL_DISABLE_SCHEMA_STAMP = savedDisable;
  });

  it('records and finds a stamp by scope and key, leaving no tmp file', () => {
    assert.equal(hasValidationStamp('scope', 'abc'), false);
    recordValidationStamp('scope', 'abc');
    assert.equal(hasValidationStamp('scope', 'abc'), true);
    assert.equal(hasValidationStamp('scope', 'other'), false);
    assert.equal(hasValidationStamp('other-scope', 'abc'), false);
    assert.equal(existsSync(join(stampDir, 'scope', `abc.${process.pid}.tmp`)), false);
  });

  it('WAVEMILL_DISABLE_SCHEMA_STAMP=1 ignores and does not write stamps', () => {
    recordValidationStamp('scope', 'abc');
    process.env.WAVEMILL_DISABLE_SCHEMA_STAMP = '1';
    assert.equal(hasValidationStamp('scope', 'abc'), false);
    recordValidationStamp('scope', 'def');
    delete process.env.WAVEMILL_DISABLE_SCHEMA_STAMP;
    assert.equal(hasValidationStamp('scope', 'def'), false);
  });
});
