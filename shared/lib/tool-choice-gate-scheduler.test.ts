/**
 * Unit tests for `maybeRunToolChoiceGate` (HOK-3123).
 *
 * The scheduler owns three decisions: whether the in-memory cool-down
 * skips the check, whether the file-based staleness skips the run, and how
 * the child process's outcome (ok, exit 2, timeout, spawn error) maps to
 * a `lastRunStatus` in backstage-health.json. Every test injects a stub
 * `spawn` so no npx is executed.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  TOOL_CHOICE_GATE_INTERVAL_MS,
  maybeRunToolChoiceGate,
  type ToolChoiceGateSchedulerDeps,
} from './tool-choice-gate-scheduler.ts';

interface FakeChildOptions {
  exitCode?: number | null;
  spawnError?: Error;
  onSpawn?: (repoDir: string) => void;
  timeoutBeforeExit?: boolean;
}

function fakeSpawn(options: FakeChildOptions = {}): ToolChoiceGateSchedulerDeps['spawn'] {
  return ((cmd: string, args: readonly string[]) => {
    if (options.spawnError) {
      throw options.spawnError;
    }
    // Find the --repo-dir arg the scheduler passed.
    const repoDirIndex = args.findIndex((arg) => arg === '--repo-dir');
    const repoDir = repoDirIndex >= 0 ? args[repoDirIndex + 1] : '';
    options.onSpawn?.(repoDir);
    const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => void };
    child.kill = () => undefined;
    if (!options.timeoutBeforeExit) {
      // Emit exit asynchronously so timers/listeners register first.
      setImmediate(() => {
        child.emit('exit', options.exitCode ?? 0);
      });
    }
    return child as unknown as ReturnType<ToolChoiceGateSchedulerDeps['spawn']>;
  }) as ToolChoiceGateSchedulerDeps['spawn'];
}

function writeSnapshot(repoDir: string, updatedAt: string, extras: Record<string, unknown> = {}): void {
  const dir = join(repoDir, '.wavemill', 'tool-decisions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'latest-gate.json'),
    JSON.stringify({
      schemaVersion: 1,
      updatedAt,
      progressLine: 'tool-choice-gate: rows=0 joined=n/a models=0 sessions=0/20 menu-digest=n/a exact=0/200 rec=inconclusive',
      computedRecommendation: 'inconclusive',
      ...extras,
    }, null, 2),
  );
}

function readHealth(repoDir: string): Record<string, unknown> {
  const raw = readFileSync(join(repoDir, '.wavemill', 'backstage-health.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('maybeRunToolChoiceGate', () => {
  it('skips as fresh when latest-gate.json.updatedAt is within the interval', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    const fresh = new Date(nowMs - 60_000).toISOString();
    writeSnapshot(repoDir, fresh);
    let spawnCalls = 0;
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({ onSpawn: () => { spawnCalls += 1; } }),
        log: () => undefined,
      },
    });
    assert.equal(result.ran, false);
    assert.equal(result.skipped, 'fresh');
    assert.equal(spawnCalls, 0);
  });

  it('skips as checked-recently when lastCheckedMs is inside the check interval', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    let spawnCalls = 0;
    const result = await maybeRunToolChoiceGate({
      repoDir,
      lastCheckedMs: nowMs - 60_000,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({ onSpawn: () => { spawnCalls += 1; } }),
        log: () => undefined,
      },
    });
    assert.equal(result.ran, false);
    assert.equal(result.skipped, 'checked-recently');
    assert.equal(spawnCalls, 0);
  });

  it('runs when the snapshot is older than the interval and records status=ok', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    const stale = new Date(nowMs - TOOL_CHOICE_GATE_INTERVAL_MS - 1000).toISOString();
    writeSnapshot(repoDir, stale);
    process.env.LINEAR_API_KEY = 'test';
    let seenRepoDir = '';
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({
          exitCode: 0,
          onSpawn: (dir) => {
            seenRepoDir = dir;
            // The child would refresh the snapshot; simulate that.
            writeSnapshot(repoDir, new Date(nowMs).toISOString());
          },
        }),
        log: () => undefined,
      },
    });
    assert.equal(result.ran, true);
    assert.equal(result.status, 'ok');
    assert.equal(seenRepoDir, repoDir);
    const health = readHealth(repoDir);
    const services = (health.services ?? {}) as Record<string, Record<string, unknown>>;
    assert.equal(services.toolChoiceGate.lastRunStatus, 'ok');
    assert.equal(services.toolChoiceGate.computedRecommendation, 'inconclusive');
    assert.equal(typeof services.toolChoiceGate.progressLine, 'string');
  });

  it('records status=artifacts-only when LINEAR_API_KEY is unset and child exits 0', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    const stale = new Date(nowMs - TOOL_CHOICE_GATE_INTERVAL_MS - 1000).toISOString();
    writeSnapshot(repoDir, stale);
    delete process.env.LINEAR_API_KEY;
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({
          exitCode: 0,
          onSpawn: () => writeSnapshot(repoDir, new Date(nowMs).toISOString()),
        }),
        log: () => undefined,
      },
    });
    assert.equal(result.status, 'artifacts-only');
    const services = (readHealth(repoDir).services ?? {}) as Record<string, Record<string, unknown>>;
    assert.equal(services.toolChoiceGate.lastRunStatus, 'artifacts-only');
  });

  it('records status=artifacts-only when child exits with code 2 (Linear publish failed)', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    const stale = new Date(nowMs - TOOL_CHOICE_GATE_INTERVAL_MS - 1000).toISOString();
    writeSnapshot(repoDir, stale);
    process.env.LINEAR_API_KEY = 'test';
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({
          exitCode: 2,
          onSpawn: () => writeSnapshot(repoDir, new Date(nowMs).toISOString()),
        }),
        log: () => undefined,
      },
    });
    assert.equal(result.status, 'artifacts-only');
  });

  it('records status=error when child exits with a non-zero, non-2 code', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    const stale = new Date(nowMs - TOOL_CHOICE_GATE_INTERVAL_MS - 1000).toISOString();
    writeSnapshot(repoDir, stale);
    process.env.LINEAR_API_KEY = 'test';
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({ exitCode: 1 }),
        log: () => undefined,
      },
    });
    assert.equal(result.status, 'error');
    const services = (readHealth(repoDir).services ?? {}) as Record<string, Record<string, unknown>>;
    assert.equal(services.toolChoiceGate.lastRunStatus, 'error');
  });

  it('records status=error and does not throw when spawn itself fails', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'tcg-scheduler-'));
    const nowMs = 1_759_000_000_000;
    // No snapshot on disk → definitely stale, so scheduler will attempt to run.
    process.env.LINEAR_API_KEY = 'test';
    const result = await maybeRunToolChoiceGate({
      repoDir,
      deps: {
        now: () => new Date(nowMs),
        spawn: fakeSpawn({ spawnError: new Error('ENOENT: npx not found') }),
        log: () => undefined,
      },
    });
    assert.equal(result.status, 'error');
    assert.match(result.detail ?? '', /ENOENT/);
  });
});
