/**
 * Tend heartbeat writing utilities for backstage health reporting.
 *
 * Extracted from tend-loop.ts to avoid circular imports with tend-controller.ts.
 * Used by both tend-loop and tend-controller for progress tracking.
 */

import { join } from 'node:path';
import { mutateJsonState } from './state-mutex.ts';
import type { AdvisoryCheckFailure } from './tend-controller.ts';

export type TendProgressState = 'progressing' | 'idle' | 'stalled';
export type TendLaneCondition =
  | 'progressing'
  | 'no-eligible'
  | 'needs-user-hold'
  | 'idle-blocked-stall'
  | 'integration-unhealthy'
  | 'integration-unhealthy-stall';

interface BackstageHealthFile {
  updatedAt?: string;
  status?: string;
  detail?: string | null;
  restartAttemptCount?: number;
  lastRestartAttemptAt?: string | null;
  executorPaneId?: string | null;
  services?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Write tend heartbeat to backstage-health.json.
 *
 * Updates the tend service status with operational details (iteration, polls,
 * progress state, lane condition). Used to keep the watchdog alive and provide
 * observability during long operations.
 */
export async function writeTendHeartbeat(
  repoDir: string,
  timestamp: string,
  health: {
    failureCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
    lastProgressAt?: string;
    progressState?: TendProgressState;
    laneCondition?: TendLaneCondition;
    laneEvidenceId?: string;
    status?: 'healthy' | 'degraded' | 'unhealthy';
    detail?: string;
    integrationAdvisory?: AdvisoryCheckFailure[];
  },
): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      const status = health.status ?? 'healthy';
      const detail = health.detail ?? (health.progressState === 'stalled'
        ? 'backstage tend loop is alive but the merge lane is not progressing'
        : 'backstage tend loop is running');
      services.tend = {
        ...existing,
        status,
        detail,
        heartbeatAt: timestamp,
        lastSuccessfulPollAt: timestamp,
        updatedAt: timestamp,
        repoDir,
        failureCount: health.failureCount,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        iteration: health.iteration,
        pollStartedAt: health.pollStartedAt,
        pollCompletedAt: health.pollCompletedAt ?? timestamp,
        ...(health.lastProgressAt !== undefined ? { lastProgressAt: health.lastProgressAt } : {}),
        ...(health.progressState !== undefined ? { progressState: health.progressState } : {}),
        ...(health.laneCondition !== undefined ? { laneCondition: health.laneCondition } : {}),
        ...(health.laneEvidenceId !== undefined ? { laneEvidenceId: health.laneEvidenceId } : {}),
        ...(health.integrationAdvisory !== undefined ? { integrationAdvisory: health.integrationAdvisory } : {}),
      };
      next.updatedAt = timestamp;
      next.status = status;
      next.detail = detail;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

/**
 * Best-effort heartbeat writer that silently catches errors.
 *
 * Used to ensure heartbeat failures do not stop the merge process.
 */
export async function writeTendPollHeartbeatBestEffort(
  repoDir: string,
  options: {
    failureCount?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    timestamp?: string;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
    lastProgressAt?: string;
    progressState?: TendProgressState;
    laneCondition?: TendLaneCondition;
    laneEvidenceId?: string;
    status?: 'healthy' | 'degraded' | 'unhealthy';
    detail?: string;
    integrationAdvisory?: AdvisoryCheckFailure[];
  } = {},
): Promise<void> {
  try {
    await writeTendHeartbeat(
      repoDir,
      options.timestamp ?? new Date().toISOString(),
      {
        failureCount: options.failureCount ?? 0,
        lastError: options.lastError ?? null,
        lastErrorAt: options.lastErrorAt ?? null,
        iteration: options.iteration,
        pollStartedAt: options.pollStartedAt,
        pollCompletedAt: options.pollCompletedAt,
        lastProgressAt: options.lastProgressAt,
        progressState: options.progressState,
        laneCondition: options.laneCondition,
        laneEvidenceId: options.laneEvidenceId,
        status: options.status,
        detail: options.detail,
        integrationAdvisory: options.integrationAdvisory,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tend: failed to write heartbeat: ${message}`);
  }
}

/**
 * Write tend failure state (degraded or unhealthy).
 */
export async function writeTendFailureState(
  repoDir: string,
  timestamp: string,
  health: {
    status: 'degraded' | 'unhealthy';
    detail: string;
    failureCount: number;
    lastError: string | null;
    lastErrorAt: string | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  },
): Promise<void> {
  const healthPath = join(repoDir, '.wavemill', 'backstage-health.json');
  await mutateJsonState<BackstageHealthFile>(
    healthPath,
    (current) => {
      const next = { ...(current ?? {}) };
      const services = { ...(next.services ?? {}) };
      const existing = { ...(services.tend ?? {}) };
      services.tend = {
        ...existing,
        status: health.status,
        detail: health.detail,
        updatedAt: timestamp,
        repoDir,
        failureCount: health.failureCount,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        iteration: health.iteration,
        pollStartedAt: health.pollStartedAt,
        pollCompletedAt: health.pollCompletedAt ?? null,
      };
      next.updatedAt = timestamp;
      next.status = health.status;
      next.detail = health.detail;
      next.services = services;
      return next;
    },
    { createIfMissing: true, initial: {} },
  );
}

/**
 * Best-effort failure state writer.
 */
export async function writeTendFailureStateBestEffort(
  repoDir: string,
  options: {
    status?: 'degraded' | 'unhealthy';
    detail?: string;
    failureCount?: number;
    lastError?: string | null;
    lastErrorAt?: string | null;
    timestamp?: string;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  } = {},
): Promise<void> {
  try {
    await writeTendFailureState(
      repoDir,
      options.timestamp ?? new Date().toISOString(),
      {
        status: options.status ?? 'degraded',
        detail: options.detail ?? 'backstage tend loop encountered an error',
        failureCount: options.failureCount ?? 0,
        lastError: options.lastError ?? null,
        lastErrorAt: options.lastErrorAt ?? null,
        iteration: options.iteration,
        pollStartedAt: options.pollStartedAt,
        pollCompletedAt: options.pollCompletedAt,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`tend: failed to write failure state: ${message}`);
  }
}
