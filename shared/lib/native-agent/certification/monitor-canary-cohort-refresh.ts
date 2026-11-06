import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getNativeAgentConfig } from '../../config.ts';
import { resolveWavemillToolPath } from '../install-paths.ts';
import { evaluateCanaryCohortHealth, resolveCanaryCohort, type CanaryCohortHealth } from './canary-cohort.ts';

const execFileAsync = promisify(execFile);
const REFRESHABLE_STATES = new Set(['missing', 'stale', 'renewal-due', 'identity-invalidated', 'inconclusive']);

export interface MonitorCanaryRefreshSentinel {
  lastRunAt: string;
  attempted: number;
  summary: { refreshableMembers: string[] };
}

export interface MonitorCanaryCohortRefreshOptions {
  repoDir: string;
  now?: () => Date;
  /** Test seam for the configured interval. */
  intervalMinutes?: number;
  /** Test seam for the state evaluation. */
  evaluateHealth?: () => Promise<CanaryCohortHealth>;
  /** Test seam for the actual tracked command launch. */
  launchRefresh?: (repoDir: string) => Promise<void>;
  sentinelPath?: string;
}

export type MonitorCanaryCohortRefreshResult =
  | {
      action: 'disabled' | 'not-due' | 'no-refresh-needed';
      sentinel?: MonitorCanaryRefreshSentinel;
    }
  | { action: 'launched'; sentinel: MonitorCanaryRefreshSentinel };

function normalizeInterval(value: unknown): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

async function readSentinel(path: string): Promise<MonitorCanaryRefreshSentinel | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<MonitorCanaryRefreshSentinel>;
    if (typeof parsed.lastRunAt !== 'string' || !Number.isInteger(parsed.attempted) || !parsed.summary)
      return undefined;
    return parsed as MonitorCanaryRefreshSentinel;
  } catch {
    return undefined;
  }
}

async function writeSentinel(path: string, sentinel: MonitorCanaryRefreshSentinel): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sentinel)}\n`, 'utf8');
  await rename(temporary, path);
}

async function launchRefreshCommand(repoDir: string): Promise<void> {
  await execFileAsync(
    'npx',
    [
      'tsx',
      resolveWavemillToolPath('native-agent-certify.ts'),
      '--repo',
      repoDir,
      '--refresh-canary-cohort',
      '--respect-attempt-guard',
    ],
    { cwd: repoDir, timeout: 20 * 60_000, maxBuffer: 1_048_576 },
  );
}

/**
 * Starts one guarded, cohort-bounded canary refresh when the configured
 * monitor cadence has elapsed and stored evidence says a member needs it.
 */
export async function monitorCanaryCohortRefresh(
  options: MonitorCanaryCohortRefreshOptions,
): Promise<MonitorCanaryCohortRefreshResult> {
  const repoDir = resolve(options.repoDir);
  const intervalMinutes = normalizeInterval(
    options.intervalMinutes ?? getNativeAgentConfig(repoDir).certification?.canaryAutoRefreshIntervalMinutes,
  );
  if (intervalMinutes === 0) return { action: 'disabled' };

  const sentinelPath = options.sentinelPath ?? join(repoDir, '.wavemill', '.canary-cohort-last-refresh.json');
  const sentinel = await readSentinel(sentinelPath);
  const now = (options.now ?? (() => new Date()))();
  const lastRunAt = sentinel ? Date.parse(sentinel.lastRunAt) : Number.NaN;
  if (Number.isFinite(lastRunAt) && now.getTime() - lastRunAt < intervalMinutes * 60_000) {
    return { action: 'not-due', sentinel };
  }

  const health = options.evaluateHealth
    ? await options.evaluateHealth()
    : await evaluateCanaryCohortHealth({
        repoDir,
        cohort: resolveCanaryCohort({ repoDir }),
      });
  const refreshableMembers = health.members
    .filter((member) => REFRESHABLE_STATES.has(member.state))
    .map((member) => `${member.provider}/${member.model}`);
  if (refreshableMembers.length === 0) return { action: 'no-refresh-needed', ...(sentinel ? { sentinel } : {}) };

  await (options.launchRefresh ?? launchRefreshCommand)(repoDir);
  const next: MonitorCanaryRefreshSentinel = {
    lastRunAt: now.toISOString(),
    attempted: refreshableMembers.length,
    summary: { refreshableMembers },
  };
  await writeSentinel(sentinelPath, next);
  return { action: 'launched', sentinel: next };
}
