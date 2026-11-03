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
