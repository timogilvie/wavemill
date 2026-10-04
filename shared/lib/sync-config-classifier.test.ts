import assert from 'node:assert/strict';
import { CANONICAL_CONFIG_TEMPLATE } from './config-sync.ts';
import { classifyLocalOverrideFields } from './sync-config-classifier.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

console.log('\n--- sync-config-classifier tests ---\n');

test('canonical local field missing from base => will add to repo default', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: {},
    localConfig: { router: { defaultAgent: 'claude' } },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.equal(entries[0]?.path, 'router.defaultAgent');
  assert.equal(entries[0]?.label, 'will add to repo default');
});

test('unknown local field missing from base => already local-only', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: {},
    localConfig: { custom: { devOnlyFlag: true } },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.equal(entries[0]?.path, 'custom.devOnlyFlag');
  assert.equal(entries[0]?.label, 'already local-only');
});

test('secret-like keys => requires decision', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: {},
    localConfig: { router: { apiKey: 'abc' }, auth: { token: 'xyz' }, login: { password: 'pw' } },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.ok(entries.some(entry => entry.path === 'router.apiKey' && entry.label === 'requires decision'));
  assert.ok(entries.some(entry => entry.path === 'auth.token' && entry.label === 'requires decision'));
  assert.ok(entries.some(entry => entry.path === 'login.password' && entry.label === 'requires decision'));
});

test('absolute Unix and Windows paths => requires decision', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: {},
    localConfig: {
      tool: { cachePath: '/Users/dev/cache' },
      win: { homePath: 'C:\\Users\\dev\\cache' },
    },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.ok(entries.some(entry => entry.path === 'tool.cachePath' && entry.label === 'requires decision'));
  assert.ok(entries.some(entry => entry.path === 'win.homePath' && entry.label === 'requires decision'));
});

test('nested object and arrays containing absolute paths => requires decision', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: {},
    localConfig: {
      extra: {
        nested: {
          logs: ['relative/file.log', '/var/log/app.log'],
        },
      },
    },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.ok(entries.some(entry => entry.path === 'extra.nested.logs' && entry.label === 'requires decision'));
});

test('paths already present in base config are omitted', () => {
  const entries = classifyLocalOverrideFields({
    baseConfig: { router: { defaultModel: 'claude-sonnet-4-6' } },
    localConfig: { router: { defaultModel: 'gpt-5.6-terra' } },
    canonicalConfig: CANONICAL_CONFIG_TEMPLATE as unknown as Record<string, unknown>,
  });

  assert.equal(entries.length, 0);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
