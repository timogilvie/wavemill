/**
 * tools/migrate-state-archive.ts (HOK-3190)
 *
 * Archive the overflow in a wavemill `workflow-state.json`:
 * - `terminalTaskHistory.tasks` and `terminalTaskHistory.challengePairs`
 * - `terminalTaskTombstones`
 *
 * The archive lives in `<state-dir>/.wavemill/state-archive/*.jsonl`. Writes
 * to it are append-only and idempotent (fingerprinted); the hot file is
 * rewritten atomically with the pruned sub-trees.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  archiveFromHotState,
  DEFAULT_KEEP,
  DEFAULT_MAX_AGE_DAYS,
} from '../shared/lib/state-archive.ts';

function acquireLockDir(statePath: string, timeoutMs: number): string {
  const lock = `${statePath}.lock`;
  const started = Date.now();
  // Match shared/lib/wavemill-common.sh state_mutate lock protocol: mkdir
  // the lock dir, back off on EEXIST.
  while (true) {
    try {
      mkdirSync(lock);
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out acquiring ${lock}`);
      }
      // Short blocking sleep via Atomics.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function releaseLock(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    // ignore
  }
}

runTool({
  name: 'migrate-state-archive',
  description:
    'Move overflow terminalTaskHistory / terminalTaskTombstones out of the hot workflow-state.json into append-only JSONL archives.',
  options: {
    'state-file': {
      type: 'string',
      description: 'Absolute path to workflow-state.json',
    },
    keep: {
      type: 'string',
      description: `Keep at most N most-recent records in hot state (default ${DEFAULT_KEEP})`,
    },
    'max-age-days': {
      type: 'string',
      description: `Also drop records older than this many days (default ${DEFAULT_MAX_AGE_DAYS})`,
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress informational output',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would change without writing',
    },
  },
  examples: [
    'npx tsx tools/migrate-state-archive.ts --state-file .wavemill/workflow-state.json',
    'npx tsx tools/migrate-state-archive.ts --state-file .wavemill/workflow-state.json --keep 25 --max-age-days 7',
  ],
  async run({ args }) {
    const statePath = args['state-file'];
    if (!statePath) {
      console.error('Error: --state-file is required');
      process.exit(1);
    }
    const absState = resolve(statePath);
    if (!existsSync(absState)) {
      // Nothing to migrate — this is normal on a fresh startup.
      if (!args.quiet) console.log(`[migrate-state-archive] no state file at ${absState}; nothing to do`);
      return;
    }

    const keep = args.keep ? Number.parseInt(args.keep, 10) : DEFAULT_KEEP;
    const maxAgeDays = args['max-age-days'] ? Number.parseInt(args['max-age-days'], 10) : DEFAULT_MAX_AGE_DAYS;
    if (!Number.isFinite(keep) || keep < 0) {
      console.error(`Error: invalid --keep ${args.keep}`);
      process.exit(1);
    }
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
      console.error(`Error: invalid --max-age-days ${args['max-age-days']}`);
      process.exit(1);
    }

    const stateDir = dirname(absState);
    const lock = acquireLockDir(absState, 15_000);
    try {
      const raw = readFileSync(absState, 'utf-8');
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(raw);
      } catch (err) {
        console.error(`Error: cannot parse ${absState}: ${(err as Error).message}`);
        process.exit(1);
      }

      const summary = archiveFromHotState(state, { stateDir, keep, maxAgeDays });

      if (args['dry-run']) {
        if (!args.quiet) {
          console.log('[migrate-state-archive] dry-run — not writing state file');
          console.log(JSON.stringify(summary, null, 2));
        }
        return;
      }

      const tmp = `${absState}.tmp.${process.pid}`;
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf-8');
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, absState);

      if (!args.quiet) {
        const before = summary.before;
        const after = summary.after;
        const kb = (n: number) => `${Math.round(n / 1024)} KB`;
        console.log(
          `[migrate-state-archive] ${kb(before.bytes)} → ${kb(after.bytes)}` +
            ` | history ${before.history}→${after.history}` +
            ` tombstones ${before.tombstones}→${after.tombstones}` +
            ` pairs ${before.pairs}→${after.pairs}` +
            ` | archived h=${summary.archivedHistory} t=${summary.archivedTombstones} p=${summary.archivedPairs}` +
            ` skipped-dup=${summary.skippedAlreadyArchived}`,
        );
      }
    } finally {
      releaseLock(lock);
      try {
        unlinkSync(`${absState}.tmp.${process.pid}`);
      } catch {
        // ignore
      }
    }
  },
});
