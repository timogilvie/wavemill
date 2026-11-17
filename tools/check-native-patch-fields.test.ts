import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NATIVE_PATCH_FIELDS_GUARD } from '../shared/lib/native-patch-fields-guard.ts';
import { checkGuardSource, runSourceGuard } from './lib/source-guard.ts';

const toolPath = join(process.cwd(), 'tools/check-native-patch-fields.ts');

describe('check-native-patch-fields', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'native-patch-fields-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function writeAndTrack(relPath: string, contents: string): void {
    const fullPath = join(repo, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
    execFileSync('git', ['add', relPath], { cwd: repo });
  }

  it('allows the contract owner and residual runtime files', () => {
    const allowed = [
      'shared/lib/native-agent/patch-contract.ts',
      'shared/lib/native-agent/patch-runtime.ts',
      'shared/lib/native-agent/tools/apply-patch-tool.ts',
    ];
    for (const file of allowed) {
      writeAndTrack(file, 'const x = input.atomic;\nconst y = operation.path;\n');
    }
    const result = runSourceGuard(NATIVE_PATCH_FIELDS_GUARD, repo);
    assert.deepEqual(result.findings, []);
  });

  it('flags raw envelope and operation field checks in other files', () => {
    const findings = checkGuardSource(
      NATIVE_PATCH_FIELDS_GUARD,
      'shared/lib/native-agent/consumer.ts',
      'function f(input: unknown) { return input.atomic && input.operations.length; }\n'
        + 'function g(operation: unknown) { return operation.oldText; }\n',
    );
    const patterns = findings.map((finding) => finding.pattern).sort();
    assert.deepEqual(patterns, ['raw-envelope-field-access', 'raw-operation-field-access']);
  });

  it('fails a temporary repo with a forbidden access and passes once removed', () => {
    writeAndTrack('shared/lib/native-agent/consumer.ts', 'export const x = input.atomic;\n');

    const failing = spawnSync('npx', ['tsx', toolPath, repo], { encoding: 'utf-8' });
    assert.equal(failing.status, 1, failing.stdout + failing.stderr);
    assert.match(failing.stderr, /raw-envelope-field-access/);

    writeAndTrack('shared/lib/native-agent/consumer.ts', 'export const x = 1;\n');
    const clean = spawnSync('npx', ['tsx', toolPath, repo], { encoding: 'utf-8' });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  });
});
