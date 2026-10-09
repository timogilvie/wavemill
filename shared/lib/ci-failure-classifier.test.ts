import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCiFailure, lookupLocalCommand, tailBytes } from './ci-failure-classifier.ts';

describe('classifyCiFailure', () => {
  it('classifies deterministic locally replayable failures with the exact command', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      rawStatus: 'FAILURE',
      text: 'Assertion failed: expected 1 actual 2',
    }, {
      localCommandMap: { 'Unit Tests': 'npm test -- --runInBand' },
      logMaxBytes: 200,
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.failingJob, 'Unit Tests');
    assert.equal(result.localCommand, 'npm test -- --runInBand');
    assert.match(result.reason, /locally replayable/);
    assert.match(result.logExcerpt, /Assertion failed/);
  });

  it('classifies config validation failures as locally replayable', () => {
    const result = classifyCiFailure({
      name: 'Shell and Unit Tests',
      rawStatus: 'FAILURE',
      text: 'Config validation failed:\n  /nativeAgent/providers/openai/models: Repo-local model configuration removed',
    }, {
      localCommandMap: { 'Shell and Unit Tests': 'npm test' },
      logMaxBytes: 500,
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm test');
    assert.match(result.logExcerpt, /Repo-local model configuration removed/);
  });

  it('classifies ERR_TEST_FAILURE as locally replayable', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      rawStatus: 'FAILURE',
      text: 'node:test reported ERR_TEST_FAILURE after assertion output',
    }, {
      localCommandMap: { 'Unit Tests': 'npm test' },
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm test');
    assert.match(result.reason, /ERR_TEST_FAILURE/);
  });

  it('classifies transient infrastructure failures without requiring a command', () => {
    const result = classifyCiFailure({
      name: 'build',
      text: 'The hosted runner encountered an error while running your job.',
    }, {
      localCommandMap: { build: 'npm run build' },
    });

    assert.equal(result.category, 'transient-infra');
    assert.equal(result.localCommand, 'npm run build');
    assert.match(result.reason, /transient infrastructure/);
  });

  it('classifies approval and security checks as github-only', () => {
    const result = classifyCiFailure({
      name: 'Code scanning results',
      text: 'Security review required before merge.',
    });

    assert.equal(result.category, 'github-only');
    assert.match(result.reason, /approval\/security/);
  });

  it('classifies unmapped deterministic-looking failures as unknown', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      text: 'Tests failed: expected false to equal true',
    });

    assert.equal(result.category, 'unknown');
    assert.equal(result.localCommand, undefined);
  });

  it('classifies mapped failures without deterministic signatures as unknown', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      text: 'Process completed with exit code 2',
    }, {
      localCommandMap: { 'unit tests': 'npm test' },
    });

    assert.equal(result.category, 'unknown');
    assert.equal(result.localCommand, 'npm test');
  });

  it('classifies the HOK-3162 Pi vendor seam guard FAIL as deterministic-local', () => {
    const log = [
      'Error: Pi vendor seam guard: found code outside shared/lib/native-agent/providers/pi/compat',
      '  shared/lib/native-agent/models.ts:12',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const result = classifyCiFailure({
      name: 'Preflight Checks',
      rawStatus: 'FAILURE',
      text: log,
    }, {
      localCommandMap: { 'Preflight Checks': 'npm run lint && npm run test:preflight' },
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm run lint && npm run test:preflight');
    assert.match(result.reason, /exit code 1/i);
    assert.match(result.logExcerpt, /Pi vendor seam guard/);
  });

  it('classifies the HOK-3162 test-registration drift as deterministic-local', () => {
    const log = [
      'test-registration: test registry drift found:',
      '',
      'Unregistered test files:',
      '- shared/lib/native-agent/models.test.ts',
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const result = classifyCiFailure({
      name: 'Preflight Checks',
      rawStatus: 'FAILURE',
      text: log,
    }, {
      localCommandMap: { 'Preflight Checks': 'npm run lint && npm run test:preflight' },
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm run lint && npm run test:preflight');
    assert.match(result.reason, /drift found/i);
    assert.match(result.logExcerpt, /Unregistered test files:/);
  });

  it('ranks a code-failure signature above an ambient transient fragment', () => {
    const log = [
      'FAIL shared/lib/foo.test.ts',
      '  something broke',
      'Took 507ms',
    ].join('\n');
    const result = classifyCiFailure({
      name: 'Unit Tests',
      text: log,
    }, {
      localCommandMap: { 'Unit Tests': 'npm test' },
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm test');
    assert.match(result.reason, /FAIL/);
  });

  it('classifies a test timeout as deterministic-local, not transient', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      text: 'test timed out after 2000ms',
    }, {
      localCommandMap: { 'Unit Tests': 'npm test' },
    });

    assert.equal(result.category, 'deterministic-local');
    assert.equal(result.localCommand, 'npm test');
    assert.notEqual(result.category, 'transient-infra');
  });

  it('surfaces a code-failure signature without a recipe as unknown, not transient', () => {
    const result = classifyCiFailure({
      name: 'Preflight Checks',
      text: 'FAIL some/thing.test.ts',
    });

    assert.equal(result.category, 'unknown');
    assert.equal(result.localCommand, undefined);
    assert.match(result.reason, /FAIL/);
    assert.match(result.reason, /no configured local recipe/i);
  });

  it('still classifies runner-provisioning failures as transient-infra', () => {
    const result = classifyCiFailure({
      name: 'build',
      text: 'Error: Received workflow does not match expected... not acquired by Runner within 00:05:00',
    });

    assert.equal(result.category, 'transient-infra');
    assert.match(result.reason, /not acquired by Runner/i);
  });

  it('classifies cancelled jobs via rawStatus as transient-infra', () => {
    const result = classifyCiFailure({
      name: 'build',
      rawStatus: 'CANCELLED',
    });

    assert.equal(result.category, 'transient-infra');
    assert.match(result.reason, /CANCELLED/i);
  });

  it('no longer classifies 5xx-looking numbers in prose as transient-infra', () => {
    const result = classifyCiFailure({
      name: 'Unit Tests',
      text: 'size: 512 bytes allocated at line 507',
    }, {
      localCommandMap: { 'Unit Tests': 'npm test' },
    });

    assert.equal(result.category, 'unknown');
    assert.notEqual(result.category, 'transient-infra');
  });

  it('bounds large logs with a truncation marker and tail bias', () => {
    const log = `${'a'.repeat(100)}\nfinal failure line`;
    const result = classifyCiFailure({
      name: 'lint',
      text: log,
    }, {
      localCommandMap: { lint: 'npm run lint' },
      logMaxBytes: 24,
    });

    assert.equal(result.category, 'unknown');
    assert.match(result.logExcerpt, /^\[\.\.\.truncated\.\.\.\]/);
    assert.match(result.logExcerpt, /final failure line/);
    assert.doesNotMatch(result.logExcerpt, /^a{20}/);
  });
});

describe('tailBytes', () => {
  it('returns small strings unchanged', () => {
    assert.equal(tailBytes('small', 10), 'small');
  });
});

describe('lookupLocalCommand', () => {
  it('resolves sharded CI job names through the base job key', () => {
    assert.equal(
      lookupLocalCommand('Shell Tests (shard 2/4)', { 'Shell Tests': 'npm run test:shell' }),
      'npm run test:shell',
    );
  });

  it('does not strip malformed shard-like suffixes', () => {
    assert.equal(
      lookupLocalCommand('Shell Tests (shard 2)', { 'Shell Tests': 'npm run test:shell' }),
      undefined,
    );
  });

  it('keeps exact-match recipes ahead of stripped shard fallback', () => {
    assert.equal(
      lookupLocalCommand('Shell Tests (shard 2/4)', {
        'Shell Tests': 'npm run test:shell',
        'Shell Tests (shard 2/4)': 'npm run test:shell -- --shard 2/4',
      }),
      'npm run test:shell -- --shard 2/4',
    );
  });
});
