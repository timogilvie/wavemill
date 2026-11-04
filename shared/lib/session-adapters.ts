import { TASK_ID_EMBEDDED_GLOBAL_RE } from './task-identity.ts';
/**
 * Session adapters — native runtime session parsing for workflow cost
 * and intervention detection.
 *
 * Only the NativeSessionAdapter remains here (HOK-3407): Claude Code and
 * Codex transcripts are read through `@hokusai/costs` sources (the SDK's
 * own `parseClaudeCodeTranscript` and `parseCodexRollout`), surfaced from
 * `shared/lib/sdk-task-cost/measure.ts` as per-session SDK usage rows. The
 * meter exposes them on `MeteredWorkflowCost.sessionUsageRows`; downstream
 * (execution-economics, executed-model-resolver) reads from there. There is
 * exactly one parser per harness.
 *
 * @module session-adapters
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJsonlFile } from './jsonl-utils.ts';
import { piUsageToSessionModelUsage } from './native-agent/pi-usage-cost.ts';
import type { TranscriptEvent } from './native-agent/transcript.ts';
import { resolveProjectsDirs } from './wavemill-session-paths.ts';

/**
 * Claude transcript projects dirs for a set of working directories.
 *
 * This is the one session-discovery seam for Claude Code roots: it owns the
 * path primitive so the HOK-3077 cost-ownership guard's "session-path
 * primitive outside session-discovery sites" check keeps every other module
 * out of `wavemill-session-paths.ts`.
 */
export function resolveClaudeProjectsDirsFor(cwds: readonly string[]): string[] {
  return [...new Set(cwds.flatMap((cwd) => resolveProjectsDirs(cwd)))];
}

// ────────────────────────────────────────────────────────────────
// Common types
// ────────────────────────────────────────────────────────────────

/** Per-model aggregated token usage (without cost — cost is computed later). */
export interface SessionModelUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface NativeSessionUsageRecord {
  sessionId: string;
  filePath: string;
  provider: string;
  modelId: string;
  turnCount: number;
  responseIds: string[];
  turns: Array<{
    responseId?: string;
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    providerReportedCostUsd?: number;
    usageAvailable: boolean;
    invalidUsage: boolean;
  }>;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerReportedCostUsd?: number;
  usageAvailable: boolean;
  invalidUsage: boolean;
}

/** Result of scanning sessions for a given agent. */
export interface SessionUsageResult {
  /** Per-model token usage breakdown. */
  models: Record<string, SessionModelUsage>;
  /** Number of session files that contributed data. */
  sessionCount: number;
  /** Number of assistant turns counted (or 1 per session for agents with cumulative totals). */
  turnCount: number;
  /** Source identifier; `native` is the only remaining harness here (HOK-3407). */
  source?: 'native';
  /** Native per-session usage details. Present only for native transcript scans. */
  nativeSessions?: NativeSessionUsageRecord[];
}

/** Options for scanning sessions. */
export interface SessionScanOptions {
  worktreePath: string;
  branchName: string;
  /**
   * Main repository directory. Native transcripts are written under the *repo*
   * (`makeTranscriptPath` uses `repoDir`), not the task worktree, so scanning
   * only `worktreePath` finds nothing for any mill task and the run's cost is
   * silently reported as unavailable.
   */
  repoDir?: string;
  /**
   * Issue being evaluated. Native transcripts for every task share one
   * directory (`<repo>/.wavemill/runs/<session>/native-sessions/`), so without
   * this every task's usage is summed into whichever task is being costed.
   */
  issueId?: string;
}

/** A session adapter knows how to scan an agent's session files. */
export interface SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null;
}

// ────────────────────────────────────────────────────────────────
// Native adapter
// ────────────────────────────────────────────────────────────────

/**
 * Reads native runtime transcript files from worktree-local run directories.
 *
 * Native transcripts are worktree-scoped, so branchName is not currently used
 * for discovery. Assistant message usage is aggregated per model, preferring
 * the event's model and falling back to the session_started model when needed.
 */
/**
 * Whether a native transcript belongs to the task being costed.
 *
 * Transcripts for every task share one directory, so without this each task's
 * cost absorbs every other task's tokens. Naming is not uniform across stages:
 * coding and planning use `<stage>-<ISSUE>.jsonl`, review uses
 * `<session>-review-<branch>.jsonl`, and expansion uses
 * `expansion-expansion-<ISSUE>-<timestamp>.jsonl` inside a run dir of the same
 * name, with the issue in the middle rather than at the end.
 *
 * So this excludes transcripts that demonstrably belong to a *different* task
 * rather than including only those that match a single naming convention —
 * filtering on the issue alone would silently drop the whole review phase from
 * a native run's cost. A task ID anywhere in the filename or `runDirName`
 * attributes the file; only files with no task or branch identity at all are
 * kept unattributed (HOK-3256: the old end-anchored check missed every
 * expansion transcript, charging each task the whole growing pool).
 */
export function matchesIssue(
  fileName: string,
  issueId?: string,
  branchName?: string,
  runDirName?: string,
): boolean {
  if (!issueId && !branchName) return true;
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-');
  const base = fileName.replace(/\.jsonl$/, '');

  if (issueId && base.endsWith(`-${sanitize(issueId)}`)) return true;
  if (branchName && base.endsWith(`-${sanitize(branchName)}`)) return true;

  if (issueId) {
    // `coding-HOK-537_c`, `expansion-expansion-HOK-1309-1788901038378`. Exact
    // token match, so a primary never claims its challenger's `_c` file.
    const embeddedIds = [base, runDirName ?? '']
      .flatMap((name) => name.match(TASK_ID_EMBEDDED_GLOBAL_RE) ?? []);
    if (embeddedIds.includes(sanitize(issueId))) return true;
    if (embeddedIds.length > 0) return false;
  }
  // Names another branch: every review transcript is `<session>-review-<branch>`
  // (`manual-review-review-fix-glm-5-2-live-pricing`), whatever the branch prefix.
  if (branchName && /-(review|task|feature|bug|bugfix)-/.test(base)) return false;

  return true;
}

export class NativeSessionAdapter implements SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    // Check the repo root as well as the worktree: mill tasks run in a
    // worktree but their transcripts are written under the main repo.
    const runsDirs = [
      join(resolve(opts.worktreePath), '.wavemill', 'runs'),
      ...(opts.repoDir ? [join(resolve(opts.repoDir), '.wavemill', 'runs')] : []),
    ].filter((dir, index, all) => all.indexOf(dir) === index && existsSync(dir));

    if (runsDirs.length === 0) {
      return null;
    }

    let sessionFiles: string[] = [];
    try {
      for (const runsDir of runsDirs) {
        for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
          if (!runEntry.isDirectory()) {
            continue;
          }
          const nativeSessionsDir = join(runsDir, runEntry.name, 'native-sessions');
          if (!existsSync(nativeSessionsDir)) {
            continue;
          }
          sessionFiles.push(
            ...readdirSync(nativeSessionsDir)
              .filter((fileName) => fileName.endsWith('.jsonl'))
              .filter((fileName) => matchesIssue(fileName, opts.issueId, opts.branchName, runEntry.name))
              .map((fileName) => join(nativeSessionsDir, fileName)),
          );
        }
      }
    } catch {
      return null;
    }

    if (sessionFiles.length === 0) {
      return null;
    }

    sessionFiles = [...new Set(sessionFiles)];

    const models: Record<string, SessionModelUsage> = {};
    let sessionCount = 0;
    let turnCount = 0;
    const nativeSessions: NativeSessionUsageRecord[] = [];
    const seenSessionIds = new Set<string>();

    for (const filePath of sessionFiles) {
      let sessionId = '';
      let sessionModel = 'unknown';
      let sessionProvider = 'unknown';
      let sessionHadTurns = false;
      let sessionTurnCount = 0;
      const sessionModels = new Map<string, NativeSessionUsageRecord>();
      const sessionModelUsage: Record<string, SessionModelUsage> = {};

      try {
        for (const entry of readJsonlFile<TranscriptEvent>(filePath)) {
          sessionId ||= entry.sessionId || filePath;
          if (entry.type === 'session_started') {
            sessionModel = entry.model || sessionModel;
            sessionProvider = entry.provider || sessionProvider;
            continue;
          }

          if (entry.type !== 'assistant_message') {
            continue;
          }

          const modelId = entry.model || sessionModel || 'unknown';
          const key = `${sessionProvider}\0${modelId}`;
          let nativeRecord = sessionModels.get(key);
          if (!nativeRecord) {
            nativeRecord = {
              sessionId: sessionId || entry.sessionId || filePath,
              filePath,
              provider: sessionProvider,
              modelId,
              turnCount: 0,
              responseIds: [],
              turns: [],
              usageAvailable: false,
              invalidUsage: false,
            };
            sessionModels.set(key, nativeRecord);
          }

          nativeRecord.turnCount++;
          const turnRecord: NativeSessionUsageRecord['turns'][number] = {
            ...(entry.responseId ? { responseId: entry.responseId } : {}),
            usageAvailable: false,
            invalidUsage: false,
          };
          if (entry.responseId) {
            nativeRecord.responseIds.push(entry.responseId);
          }
          if (entry.usage?.cost?.total !== undefined) {
            nativeRecord.providerReportedCostUsd =
              (nativeRecord.providerReportedCostUsd ?? 0) + entry.usage.cost.total;
            turnRecord.providerReportedCostUsd = entry.usage.cost.total;
          }

          const usage = piUsageToSessionModelUsage(entry.usage);
          if (!usage) {
            nativeRecord.invalidUsage = nativeRecord.invalidUsage || false;
            nativeRecord.turns.push(turnRecord);
            sessionTurnCount++;
            sessionHadTurns = true;
            continue;
          }

          const tokenValues = [
            usage.inputTokens,
            usage.cacheCreationTokens,
            usage.cacheReadTokens,
            usage.outputTokens,
            entry.usage?.totalTokens ?? 0,
          ];
          const usageValid = tokenValues.every((value) => Number.isFinite(value) && value >= 0);
          if (!usageValid) {
            nativeRecord.invalidUsage = true;
            turnRecord.invalidUsage = true;
            nativeRecord.turns.push(turnRecord);
            sessionTurnCount++;
            sessionHadTurns = true;
            continue;
          }

          nativeRecord.usageAvailable = true;
          turnRecord.usageAvailable = true;
          turnRecord.inputTokens = usage.inputTokens;
          turnRecord.cacheCreationTokens = usage.cacheCreationTokens;
          turnRecord.cacheReadTokens = usage.cacheReadTokens;
          turnRecord.outputTokens = usage.outputTokens;
          turnRecord.totalTokens =
            entry.usage?.totalTokens ?? usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
          nativeRecord.inputTokens = (nativeRecord.inputTokens ?? 0) + usage.inputTokens;
          nativeRecord.cacheCreationTokens = (nativeRecord.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
          nativeRecord.cacheReadTokens = (nativeRecord.cacheReadTokens ?? 0) + usage.cacheReadTokens;
          nativeRecord.outputTokens = (nativeRecord.outputTokens ?? 0) + usage.outputTokens;
          nativeRecord.totalTokens =
            (nativeRecord.totalTokens ?? 0) +
            (entry.usage?.totalTokens ?? usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens);
          nativeRecord.turns.push(turnRecord);

          if (!sessionModelUsage[modelId]) {
            sessionModelUsage[modelId] = {
              inputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
            };
          }

          sessionModelUsage[modelId].inputTokens += usage.inputTokens;
          sessionModelUsage[modelId].cacheCreationTokens += usage.cacheCreationTokens;
          sessionModelUsage[modelId].cacheReadTokens += usage.cacheReadTokens;
          sessionModelUsage[modelId].outputTokens += usage.outputTokens;

          sessionTurnCount++;
          sessionHadTurns = true;
        }
      } catch {
        continue;
      }

      if (sessionHadTurns) {
        const dedupeKey = sessionId || filePath;
        if (seenSessionIds.has(dedupeKey)) {
          continue;
        }
        seenSessionIds.add(dedupeKey);
        sessionCount++;
        turnCount += sessionTurnCount;
        for (const [modelId, usage] of Object.entries(sessionModelUsage)) {
          if (!models[modelId]) {
            models[modelId] = {
              inputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
            };
          }

          models[modelId].inputTokens += usage.inputTokens;
          models[modelId].cacheCreationTokens += usage.cacheCreationTokens;
          models[modelId].cacheReadTokens += usage.cacheReadTokens;
          models[modelId].outputTokens += usage.outputTokens;
        }
        nativeSessions.push(...sessionModels.values());
      }
    }

    if (turnCount === 0) {
      return null;
    }

    return { models, sessionCount, turnCount, source: 'native', nativeSessions };
  }
}

// ────────────────────────────────────────────────────────────────
// Native provider metadata
// ────────────────────────────────────────────────────────────────

/**
 * Extract provider metadata from the latest native session_started event.
 *
 * Returns the provider and optional endpoint (api) from the first
 * session_started event found in any native session file for this worktree.
 *
 * @returns Provider metadata or null if no native sessions exist
 */
export function getNativeProviderMetadata(
  worktreePath: string,
  repoDir?: string,
): { provider: string; endpoint?: string } | null {
  // Same worktree-vs-repo mismatch NativeSessionAdapter.scan has: transcripts
  // are written under the repo, so a worktree-only lookup returns null for
  // every mill task and the eval record loses its provider metadata.
  const runsDirs = [
    join(resolve(worktreePath), '.wavemill', 'runs'),
    ...(repoDir ? [join(resolve(repoDir), '.wavemill', 'runs')] : []),
  ].filter((dir, index, all) => all.indexOf(dir) === index && existsSync(dir));

  if (runsDirs.length === 0) {
    return null;
  }

  try {
    for (const runsDir of runsDirs) {
    for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) {
        continue;
      }
      const nativeSessionsDir = join(runsDir, runEntry.name, 'native-sessions');
      if (!existsSync(nativeSessionsDir)) {
        continue;
      }

      const sessionFiles = readdirSync(nativeSessionsDir)
        .filter((fileName) => fileName.endsWith('.jsonl'))
        .map((fileName) => join(nativeSessionsDir, fileName));

      for (const filePath of sessionFiles) {
        try {
          for (const entry of readJsonlFile<TranscriptEvent>(filePath)) {
            if (entry.type === 'session_started') {
              return {
                provider: entry.provider,
                ...(entry.api ? { endpoint: entry.api } : {}),
              };
            }
          }
        } catch {
          // Skip malformed session files
          continue;
        }
      }
    }
    }
  } catch {
    return null;
  }

  return null;
}
