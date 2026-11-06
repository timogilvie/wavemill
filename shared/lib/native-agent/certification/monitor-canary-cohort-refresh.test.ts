import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { CanaryCohortHealth } from './canary-cohort.ts';
import { monitorCanaryCohortRefresh } from './monitor-canary-cohort-refresh.ts';

const now = new Date('2026-11-06T12:00:00.000Z');

function health(state: CanaryCohortHealth['members'][number]['state']): CanaryCohortHealth {
  return {
    configuredCount: 1,
    invalidCount: 0,
    codingReadyCount: state === 'ready' ? 1 : 0,
    minCodingReady: 1,
    belowMinimum: state !== 'ready',
    members: [
      {
        provider: 'openrouter',
        model: 'kimi-k3',
        state,
        codingEligible: state === 'ready',
      },
    ],
    invalid: [],
    remediationCommand: 'npx tsx tools/native-agent-certify.ts --refresh-canary-cohort',
  };
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'monitor-canary-refresh-'));
  const repoDir = join(root, 'repo');
  return {
    repoDir,
    sentinelPath: join(repoDir, '.wavemill', '.canary-cohort-last-refresh.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('monitorCanaryCohortRefresh', () => {
  it('does nothing when the interval is disabled', async () => {
    const ws = workspace();
    try {
      let launches = 0;
      const result = await monitorCanaryCohortRefresh({
        repoDir: ws.repoDir,
        intervalMinutes: 0,
        evaluateHealth: async () => health('missing'),
        launchRefresh: async () => {
          launches += 1;
        },
      });
      assert.deepEqual(result, { action: 'disabled' });
      assert.equal(launches, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('launches exactly once for a stale refreshable member and records the sentinel', async () => {
    const ws = workspace();
    try {
      let launches = 0;
      const result = await monitorCanaryCohortRefresh({
        repoDir: ws.repoDir,
        intervalMinutes: 360,
        now: () => now,
        evaluateHealth: async () => health('stale'),
        launchRefresh: async () => {
          launches += 1;
        },
        sentinelPath: ws.sentinelPath,
      });
      assert.equal(result.action, 'launched');
      assert.equal(launches, 1);
      assert.deepEqual(JSON.parse(readFileSync(ws.sentinelPath, 'utf8')), {
        lastRunAt: now.toISOString(),
        attempted: 1,
        summary: { refreshableMembers: ['openrouter/kimi-k3'] },
      });
    } finally {
      ws.cleanup();
    }
  });

  it('preserves a recent sentinel without launching another refresh', async () => {
    const ws = workspace();
    try {
      const sentinel = {
        lastRunAt: new Date(now.getTime() - 60_000).toISOString(),
        attempted: 1,
        summary: { refreshableMembers: ['openrouter/kimi-k3'] },
      };
      mkdirSync(join(ws.repoDir, '.wavemill'), { recursive: true });
      writeFileSync(ws.sentinelPath, JSON.stringify(sentinel));
      const result = await monitorCanaryCohortRefresh({
        repoDir: ws.repoDir,
        intervalMinutes: 360,
        now: () => now,
        evaluateHealth: async () => {
          throw new Error('should not inspect health before interval is due');
        },
        launchRefresh: async () => {
          throw new Error('should not launch before interval is due');
        },
        sentinelPath: ws.sentinelPath,
      });
      assert.equal(result.action, 'not-due');
      assert.deepEqual(JSON.parse(readFileSync(ws.sentinelPath, 'utf8')), sentinel);
    } finally {
      ws.cleanup();
    }
  });
});
