import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuardSource } from '../../tools/lib/source-guard.ts';
import { STATE_LOCK_GUARD } from './state-lock-guard.ts';

const names = (file: string, source: string) => checkGuardSource(STATE_LOCK_GUARD, file, source).map((finding) => finding.pattern);

test('state-lock guard catches private cross-runtime lock forms', () => {
  assert.deepEqual(names('tools/private.ts', "openSync(lockPath, 'wx');"), ['private-exclusive-file-lock']);
  assert.deepEqual(names('tools/private.ts', 'mkdirSync(lockPath);'), ['private-directory-lock-ts']);
  assert.deepEqual(names('tools/private.sh', 'mkdir "$state.lock" && break'), ['private-directory-lock-sh']);
  assert.deepEqual(names('tools/private.sh', 'if flock -n 9; then'), ['private-flock']);
  assert.deepEqual(names('tools/private.sh', 'if kill -0 "$pid"; then'), ['private-shell-pid-liveness']);
  assert.deepEqual(names('tools/private.ts', 'process.kill(pid, 0);'), ['private-node-pid-liveness']);
  assert.deepEqual(names('tools/private.ts', 'mkdirSync(dirname(lockPath));'), []);
});

test('state-lock guard catches direct lock-path removal outside the rename-away helper (HOK-3516)', () => {
  assert.deepEqual(names('tools/private.ts', 'rmSync(lockPath, { recursive: true, force: true });'), ['private-lock-removal-ts']);
  // allow-template-curly: the ${...} is a literal guard-test sample line
  assert.deepEqual(names('tools/private.ts', "rmSync(`${statePath}.lock`, { recursive: true });"), ['private-lock-removal-ts']);
  assert.deepEqual(names('tools/private.ts', 'rmdirSync(lockPath);'), ['private-lock-removal-ts']);
  assert.deepEqual(names('tools/private.sh', 'rm -rf "$lock_path" 2>/dev/null || true'), ['private-lock-removal-sh']);
  assert.deepEqual(names('tools/private.sh', 'rm -r "$state.lock"'), ['private-lock-removal-sh']);
  assert.deepEqual(names('tools/private.sh', 'rmdir "$lock_path"'), ['private-lock-removal-sh']);
  // Single-step unlinks of a lock file and unrelated removals stay allowed.
  assert.deepEqual(names('tools/private.ts', 'rmSync(lockPath, { force: true });'), []);
  assert.deepEqual(names('tools/private.sh', 'rm -f "$lock_path/owner.json"'), []);
  assert.deepEqual(names('tools/private.sh', 'rm -rf "$temp"'), []);
});
