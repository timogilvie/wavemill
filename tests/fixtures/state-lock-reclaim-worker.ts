// HOK-3516 stress worker: one concurrent waiter racing to reclaim a dead
// owner's state lock. Prints `won` or `lost`; the parent test asserts the
// lock path is never left as an ownerless directory.
import { acquireStateLockSync, releaseStateLock } from '../../shared/lib/state-lock.ts';

const statePath = process.argv[2];
if (!statePath) { console.error('usage: state-lock-reclaim-worker.ts <state-path>'); process.exit(2); }
try {
  const handle = acquireStateLockSync(statePath, { timeoutMs: 5_000, purpose: 'hok3516-reclaim-stress' });
  releaseStateLock(handle);
  process.stdout.write('won\n');
} catch {
  process.stdout.write('lost\n');
}
