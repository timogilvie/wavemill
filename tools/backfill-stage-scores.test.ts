import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resolveProviderForModel } from '../shared/lib/llm-cli.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolSource = readFileSync(join(__dirname, 'backfill-stage-scores.ts'), 'utf-8');

// Verify the default model used in the tool routes to codex
const BACKFILL_DEFAULT_MODEL = 'gpt-5.6-terra';

describe('backfill-stage-scores provider routing', () => {
  it('default model (gpt-5.6-terra) resolves to codex', () => {
    assert.equal(resolveProviderForModel(BACKFILL_DEFAULT_MODEL, process.cwd()), 'codex');
  });

  it('claude-sonnet-4-6 override resolves to claude', () => {
    assert.equal(resolveProviderForModel('claude-sonnet-4-6', process.cwd()), 'claude');
  });

  it('claude-haiku-4-5-20251001 resolves to claude', () => {
    assert.equal(resolveProviderForModel('claude-haiku-4-5-20251001', process.cwd()), 'claude');
  });
});

describe('backfill-stage-scores.ts source', () => {
  it('contains no direct claude binary shellout', () => {
    assert.doesNotMatch(
      toolSource,
      /execSync\s*\(\s*['"`]claude|spawn\s*\(\s*['"`]claude|exec\s*\(\s*['"`]claude/,
      'Found direct claude shellout — should use callLLM instead',
    );
  });

  it('imports resolveProviderForModel from llm-cli', () => {
    assert.match(
      toolSource,
      /resolveProviderForModel/,
      'should import resolveProviderForModel',
    );
  });

  it('passes explicit provider to callLLM', () => {
    assert.match(
      toolSource,
      /provider,/,
      'callLLM call should include explicit provider',
    );
  });

  it('passes repoDir to callLLM', () => {
    assert.match(
      toolSource,
      /repoDir:\s*process\.cwd\(\)/,
      'callLLM call should include repoDir: process.cwd()',
    );
  });

  it('uses gpt-5.6-terra as the default model', () => {
    assert.match(
      toolSource,
      /gpt-5\.6-terra/,
      'default model should be gpt-5.6-terra (routes to codex)',
    );
  });
});
