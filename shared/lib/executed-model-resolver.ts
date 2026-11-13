/**
 * Resolve execution identity for Claude Code / Codex CLI / native stages
 * from retained session telemetry.
 *
 * Which sessions did a stage's work is read from the task's
 * `.session-ownership.jsonl` (HOK-3328): only turns of the sessions a launch
 * row names for that stage count, so a helper call that ran while the stage
 * was open can never set the stage's executed model. The resolver never reads
 * launch intent as the answer and never fabricates an executed model from the
 * requested model.
 *
 * HOK-3369: adds a native path. For a `native` harness stage, resolution
 * reads the launcher's existing `direct / provider-response` evidence first
 * (unchanged); failing that, scans the owned sessions' native-stream JSONL
 * files and verdicts the per-turn `responseId` / `responseModel` through
 * `provider-identity.ts` — the same rule the live loop uses.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IngestUsageInput } from '@hokusai/costs';
import { extractOwnedSessionUsageRows } from './sdk-task-cost/measure.ts';
import {
  readOwnershipRows,
  rowsForStage,
  type OwnershipKind,
  type OwnershipStage,
  type SessionHarness,
  type SessionOwnershipRow,
} from './session-ownership.ts';
import {
  extractProviderReportedIdentity,
  isRollingProviderAlias,
  ProviderIdentityTracker,
  verifyProviderIdentity,
  type ProviderIdentityExpectation,
  type ProviderIdentitySummary,
} from './native-agent/provider-identity.ts';
import type { StageExecutionEvidence, StageResult } from './stage-result.ts';
import { resolveClaudeProjectsDirsFor } from './session-adapters.ts';

export type ExecutedModelResolverAgent = 'claude' | 'codex';
export type ExecutedModelEvidenceSource =
  | 'claude-session'
  | 'codex-session'
  | 'provider-response'
  | 'native-runtime'
  | 'session-stream';
export type ExecutedModelEvidenceStatus = 'direct' | 'missing' | 'contradicted';

export interface ResolveExecutedModelFromSessionsInput {
  agent: ExecutedModelResolverAgent;
  stage: OwnershipStage;
  /** The task's launch rows; only sessions owned for `stage` are read. */
  ownership: readonly SessionOwnershipRow[];
  /**
   * SDK per-session usage rows (HOK-3407): `extractOwnedSessionUsageRows`
   * for Claude Code and Codex, keyed on `sessionRef`. The resolver reads
   * each turn's `observedModel` + `isSubagent` + `observedAt` to compute
   * dominance; logic is otherwise identical to the pre-HOK-3407 scan.
   */
  usageRowsForSession: (sessionRef: string) => readonly IngestUsageInput[];
  /** Branch name used only in diagnostic messages. */
  branchName?: string;
}

export interface ResolvedExecutedModelEvidence {
  executedModel: string | null;
  evidenceStatus: ExecutedModelEvidenceStatus;
  evidenceSource: ExecutedModelEvidenceSource;
  evidenceDetail: string;
}

interface CandidateTurn {
  model: string;
  timestampMs: number;
  sessionId: string;
  isSubagent: boolean | null;
  index: number;
}

const AGENT_HARNESS: Record<ExecutedModelResolverAgent, SessionOwnershipRow['harness']> = {
  claude: 'claude-code',
  codex: 'codex',
};

function sourceForAgent(agent: ExecutedModelResolverAgent): ExecutedModelEvidenceSource {
  return agent === 'claude' ? 'claude-session' : 'codex-session';
}

function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function formatModelCounts(counts: Map<string, { count: number }>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([model, info]) => `${model}:${info.count}`)
    .join(',');
}

/**
 * Resolve the executed model from the turns of the sessions owned for a
 * stage. When a stage has both Claude main-loop and sidechain turns, sidechain
 * turns are ignored for model dominance.
 *
 * Reads the SDK's per-session usage rows (HOK-3407): the caller hands the
 * resolver a lookup over owned `sessionRef` → `IngestUsageInput[]` (built
 * by `extractOwnedSessionUsageRows`). Each row carries `observedModel`,
 * `isSubagent`, and `observedAt`, so model dominance and the subagent
 * exclusion rule are preserved exactly.
 */
export function resolveExecutedModelFromSessions(
  input: ResolveExecutedModelFromSessionsInput,
): ResolvedExecutedModelEvidence {
  const evidenceSource = sourceForAgent(input.agent);
  const ownedRefs = [...new Set(rowsForStage(input.ownership, input.stage)
    .filter((row) => row.harness === AGENT_HARNESS[input.agent])
    .map((row) => row.sessionRef))];
  if (ownedRefs.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `no ${input.agent} session owned for stage=${input.stage}`,
    };
  }

  const sessionsWithRows = ownedRefs
    .map((sessionRef) => ({ sessionRef, rows: input.usageRowsForSession(sessionRef) }))
    .filter((entry) => entry.rows.length > 0);
  if (sessionsWithRows.length === 0) {
    const branchSuffix = input.branchName ? ` for branch=${input.branchName}` : '';
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `owned ${input.agent} sessions=${ownedRefs.length}; none found in telemetry${branchSuffix}`,
    };
  }

  const candidates: CandidateTurn[] = [];
  let index = 0;
  for (const { sessionRef, rows } of sessionsWithRows) {
    for (const row of rows) {
      index++;
      const candidate = candidateFromRow(row, sessionRef, index);
      if (candidate) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `sessions=${sessionsWithRows.length}; modelTurns=0`,
    };
  }

  const nonSubagentTurns = candidates.filter((turn) => turn.isSubagent !== true);
  const attributionTurns = nonSubagentTurns.length > 0 ? nonSubagentTurns : candidates;
  const counts = new Map<string, { count: number; lastTimestampMs: number; lastIndex: number }>();
  for (const turn of attributionTurns) {
    const entry = counts.get(turn.model) ?? { count: 0, lastTimestampMs: Number.NEGATIVE_INFINITY, lastIndex: -1 };
    entry.count++;
    if (turn.timestampMs > entry.lastTimestampMs || (turn.timestampMs === entry.lastTimestampMs && turn.index > entry.lastIndex)) {
      entry.lastTimestampMs = turn.timestampMs;
      entry.lastIndex = turn.index;
    }
    counts.set(turn.model, entry);
  }

  const [dominantModel] = [...counts.entries()]
    .sort((a, b) => (
      b[1].count - a[1].count
      || b[1].lastTimestampMs - a[1].lastTimestampMs
      || b[1].lastIndex - a[1].lastIndex
      || a[0].localeCompare(b[0])
    ))[0];

  const detailParts = [
    `models=${formatModelCounts(counts)}`,
    `sessions=${new Set(attributionTurns.map((turn) => turn.sessionId)).size}`,
    `turns=${attributionTurns.length}`,
  ];
  const excludedSubagentTurns = candidates.length - attributionTurns.length;
  if (excludedSubagentTurns > 0) {
    detailParts.push(`excludedSubagentTurns=${excludedSubagentTurns}`);
  }

  return {
    executedModel: dominantModel,
    evidenceStatus: 'direct',
    evidenceSource,
    evidenceDetail: detailParts.join('; '),
  };
}

function candidateFromRow(
  row: IngestUsageInput,
  sessionId: string,
  index: number,
): CandidateTurn | null {
  if (!row.observedModel) return null;
  const timestampMs = (row.observedAt ? parseTimestampMs(row.observedAt) : null) ?? Number.NEGATIVE_INFINITY;
  return {
    model: row.observedModel,
    timestampMs,
    sessionId,
    isSubagent: typeof row.isSubagent === 'boolean' ? row.isSubagent : null,
    index,
  };
}

// ────────────────────────────────────────────────────────────────
// HOK-3369: one resolver for every harness
// ────────────────────────────────────────────────────────────────

/**
 * Input to {@link resolveStageExecutedModel}: the one entry point for
 * resolving a stage's executed model regardless of harness.
 */
export interface ResolveStageExecutedModelInput {
  /** State directory holding `.session-ownership.jsonl` and `.<stage>-result.json`. */
  featureDir: string;
  /** The stage to resolve for. */
  stage: OwnershipStage;
  /** Worktree path for Claude Code / Codex session adapters. */
  worktreePath: string;
  /** Git branch for Claude Code / Codex session adapters. */
  branchName: string;
  /** Repo root holding native streams and repo-scoped provider transcript homes. */
  repoDir?: string;
  /** The existing stage result, when the caller already has it. */
  existing?: StageResult | null;
  /** Agent hint (legacy fallback when the ownership file is absent). */
  agentHint?: string;
}

export interface ResolvedStageExecutedModel {
  executedModel: string | null;
  evidenceStatus: ExecutedModelEvidenceStatus;
  evidenceSource: string;
  evidenceDetail: string;
  /**
   * The resolver returned the launcher's already-recorded evidence rather
   * than independently resolving a new execution. Consumers must preserve
   * that block byte-for-byte, including its `recordedAt` timestamp.
   */
  preservedExisting?: boolean;
  /**
   * Optional provider-response fields (HOK-3143) carried forward when the
   * native resolver succeeded. The CLI write path never sets these from
   * flags — the resolver returns them directly for callers to merge into
   * the stage result (via `executionTruthFields` + a few extra fields).
   */
  providerEvidence?: Partial<Pick<
    StageExecutionEvidence,
    | 'providerReportedModel'
    | 'requestedWireId'
    | 'certifiedTarget'
    | 'identityVerdict'
    | 'transportProvider'
    | 'responseId'
    | 'piRuntimeVersions'
  >>;
}

/**
 * Pick the harness for the stage: launch rows win, agent-label is a legacy
 * fallback only when no row names the stage.
 */
function selectHarness(
  ownership: readonly SessionOwnershipRow[],
  stage: OwnershipStage,
  agentHint: string | undefined,
): SessionHarness | null {
  const stageRows = rowsForStage(ownership, stage);
  if (stageRows.length > 0) {
    // Any row for this stage decides the harness. Multiple harnesses on one
    // stage would be a bug upstream; the latest launch wins.
    const latest = [...stageRows].sort(
      (a, b) => Date.parse(b.launchedAt) - Date.parse(a.launchedAt),
    )[0];
    return latest?.harness ?? null;
  }
  if (agentHint === 'claude') return 'claude-code';
  if (agentHint === 'codex') return 'codex';
  if (agentHint === 'native' || agentHint === 'native-openrouter') return 'native';
  return null;
}

function readOwnershipRowsSafe(stateDir: string): SessionOwnershipRow[] {
  try {
    return readOwnershipRows(stateDir);
  } catch {
    return [];
  }
}

/**
 * The one entry point: resolve a stage's executed model, regardless of
 * harness, from the ownership record and session telemetry.
 *
 * Returns `direct` evidence when verified, `contradicted` when the native
 * stream saw a provider identity mismatch, and `missing` otherwise.
 */
export function resolveStageExecutedModel(
  input: ResolveStageExecutedModelInput,
): ResolvedStageExecutedModel {
  const ownership = readOwnershipRowsSafe(input.featureDir);
  const harness = selectHarness(ownership, input.stage, input.agentHint);

  if (harness === 'native') {
    return resolveNativeExecutedModel({ ...input, ownership });
  }

  if (harness === 'claude-code' || harness === 'codex') {
    const agent: ExecutedModelResolverAgent = harness === 'claude-code' ? 'claude' : 'codex';
    const lookup = buildExternalUsageRowsLookup({
      ownership,
      stage: input.stage,
      harness,
      worktreePath: input.worktreePath,
      repoDir: input.repoDir,
    });
    const resolved = resolveExecutedModelFromSessions({
      agent,
      stage: input.stage,
      ownership,
      usageRowsForSession: lookup,
      branchName: input.branchName,
    });
    return {
      executedModel: resolved.executedModel,
      evidenceStatus: resolved.evidenceStatus,
      evidenceSource: resolved.evidenceSource,
      evidenceDetail: resolved.evidenceDetail,
    };
  }

  return {
    executedModel: null,
    evidenceStatus: 'missing',
    evidenceSource: 'unknown',
    evidenceDetail: `no ownership row and no recognised agent hint for stage=${input.stage}`,
  };
}

/**
 * Build a `sessionRef → IngestUsageInput[]` lookup for the owned external
 * sessions of one stage (HOK-3407). Executes the SDK's own file read +
 * extract pass, so the resolver sees deduped (`eventKey`) rows with disjoint
 * Codex buckets (`normalizeCodexBuckets`) — the same path the meter uses.
 *
 * Unlike the cost meter, the resolver correlates purely by `sessionId`, so
 * the SDK attribution window is opened wide (`1970…9999`) to include every
 * turn of every owned session. Archived backfills re-append ownership rows
 * with a fresh `launchedAt` that post-dates the archived transcript; using
 * the launch time as the window start would drop those pre-existing turns
 * and the resolver would emit `missing_execution_evidence` even though the
 * session's model is still on disk.
 */
function buildExternalUsageRowsLookup(input: {
  ownership: readonly SessionOwnershipRow[];
  stage: OwnershipStage;
  harness: 'claude-code' | 'codex';
  worktreePath: string;
  repoDir?: string;
}): (sessionRef: string) => readonly IngestUsageInput[] {
  const stageRows = rowsForStage(input.ownership, input.stage).filter(
    (row) => row.harness === input.harness,
  );
  if (stageRows.length === 0) {
    return () => [];
  }

  const claudeRoots = input.harness === 'claude-code'
    ? resolveClaudeProjectsDirsFor(stageRows.map(row => row.cwd || input.worktreePath), input.repoDir) : [];
  const codexRoots = input.harness === 'codex' ? [codexSessionsRoot()] : [];

  let result: Map<string, readonly IngestUsageInput[]> | null = null;
  const build = (): Map<string, readonly IngestUsageInput[]> => {
    try {
      const extracted = extractOwnedSessionUsageRows({
        // The SDK boundary accepts any non-empty id; the resolver never reads
        // it back. Correlation is driven by `sessionIds` alone.
        taskId: 'unknown-task',
        rows: stageRows,
        claudeRoots,
        codexRoots,
        nativeSessions: [],
        priceOverrides: [],
        window: { startedAt: '1970-01-01T00:00:00.000Z', endedAt: '9999-12-31T23:59:59.999Z' },
      });
      return input.harness === 'claude-code' ? extracted.claude : extracted.codex;
    } catch {
      return new Map<string, readonly IngestUsageInput[]>();
    }
  };

  return (sessionRef: string) => {
    if (!result) result = build();
    return result.get(sessionRef) ?? [];
  };
}

function codexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

// ────────────────────────────────────────────────────────────────
// Native path (HOK-3369 D5)
// ────────────────────────────────────────────────────────────────

interface NativeSessionStartedEvent {
  type: 'session_started';
  sessionId: string;
  model?: string;
  provider?: string;
  timestamp?: number;
}

interface NativeAssistantMessageEvent {
  type: 'assistant_message';
  sessionId: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  timestamp?: number;
}

type NativeEvent = NativeSessionStartedEvent | NativeAssistantMessageEvent | { type: string; sessionId?: string; timestamp?: number };

function parseJsonLine(line: string): NativeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as NativeEvent;
  } catch {
    return null;
  }
}

function isSessionStartedEvent(event: NativeEvent): event is NativeSessionStartedEvent {
  return event.type === 'session_started';
}

function isAssistantMessageEvent(event: NativeEvent): event is NativeAssistantMessageEvent {
  return event.type === 'assistant_message';
}

/** Candidate native-stream file locations, deduplicated. */
function nativeStreamCandidates(input: {
  featureDir: string;
  repoDir?: string;
  worktreePath?: string;
  stage: OwnershipStage;
}): string[] {
  const dirs = new Set<string>();
  const addRunsDir = (root?: string) => {
    if (!root) return;
    try {
      const runsRoot = join(root, '.wavemill', 'runs');
      if (!existsSync(runsRoot)) return;
      for (const session of readdirSync(runsRoot)) {
        const sessionDir = join(runsRoot, session, 'native-sessions');
        if (existsSync(sessionDir)) dirs.add(sessionDir);
      }
    } catch {
      // Unreadable runs dir: skip, best-effort.
    }
  };
  addRunsDir(input.worktreePath);
  addRunsDir(input.repoDir);
  // HOK-3369 D5 step 2: archive layout keeps native-sessions beside the state.
  const archiveDir = join(input.featureDir, 'native-sessions');
  if (existsSync(archiveDir)) dirs.add(archiveDir);
  return [...dirs];
}

function readSessionEvents(filePath: string): NativeEvent[] {
  try {
    const bytes = readFileSync(filePath, 'utf8');
    const events: NativeEvent[] = [];
    for (const line of bytes.split(/\r?\n/)) {
      const parsed = parseJsonLine(line);
      if (parsed) events.push(parsed);
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * HOK-3369 D5: resolve a native stage's executed model.
 *
 * Order of precedence:
 * 1. The launcher's own `direct` / `provider-response` evidence (unchanged),
 *    unless it is superseded by a newer launch row (`latestLaunchAt`).
 * 2. The owned session stream(s), verdicted turn-by-turn through
 *    `provider-identity.ts` — the same rule the live loop uses.
 * 3. `missing` with an honest detail.
 *
 * Never falls back to the requested wire id (HOK-3143 guard).
 */
function resolveNativeExecutedModel(input: ResolveStageExecutedModelInput & {
  ownership: readonly SessionOwnershipRow[];
}): ResolvedStageExecutedModel {
  // (1) Honour an existing launcher record that has not been superseded.
  const existing = input.existing;
  const existingEvidence = existing?.executionEvidence;
  if (
    existingEvidence
    && existingEvidence.status === 'direct'
    && existingEvidence.source === 'provider-response'
    && existing?.executedModel
  ) {
    const stageRows = rowsForStage(input.ownership, input.stage).filter(
      (row) => row.harness === 'native',
    );
    const latestLaunchMs = stageRows
      .map((row) => Date.parse(row.launchedAt))
      .filter(Number.isFinite)
      .reduce((max, ms) => Math.max(max, ms), Number.NEGATIVE_INFINITY);
    const recordedMs = existingEvidence.recordedAt ? Date.parse(existingEvidence.recordedAt) : NaN;
    const superseded = Number.isFinite(latestLaunchMs)
      && Number.isFinite(recordedMs)
      && latestLaunchMs > recordedMs;
    if (!superseded) {
      // HOK-3369: carry every provider-identity field from the existing
      // block so the CLI write can rebuild evidence with the same shape
      // (identityVerdict, requestedWireId, certifiedTarget, responseId,
      // transportProvider, piRuntimeVersions). The merge rule may still
      // keep the whole block, but when an explicit --executed-model is
      // supplied (resolver answer), these fields are reinstated.
      const providerEvidence: ResolvedStageExecutedModel['providerEvidence'] = {};
      for (const key of [
        'providerReportedModel',
        'requestedWireId',
        'certifiedTarget',
        'identityVerdict',
        'transportProvider',
        'responseId',
        'piRuntimeVersions',
      ] as const) {
        const value = (existingEvidence as Record<string, unknown>)[key];
        if (value !== undefined) {
          (providerEvidence as Record<string, unknown>)[key] = value;
        }
      }
      return {
        executedModel: existing.executedModel,
        evidenceStatus: 'direct',
        evidenceSource: existingEvidence.source,
        evidenceDetail: existingEvidence.detail ?? 'launcher provider-identity record',
        preservedExisting: true,
        ...(Object.keys(providerEvidence).length > 0 ? { providerEvidence } : {}),
      };
    }
  }

  // (2) Read the owned session stream(s) for this native stage.
  const ownedRows = rowsForStage(input.ownership, input.stage).filter(
    (row) => row.harness === 'native',
  );
  if (ownedRows.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `no native session owned for stage=${input.stage}`,
    };
  }
  // A retry receives a fresh ownership attempt. A prior attempt can still
  // flush stream events after that retry begins, so timestamp filtering alone
  // is not sufficient: only the latest attempt's session refs may contribute
  // to the current stage record.
  const launchMs = (row: typeof ownedRows[number]) => {
    const ms = Date.parse(row.launchedAt);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const latestLaunch = ownedRows.reduce((latest, row) => (
    launchMs(row) > launchMs(latest) ? row : latest
  ));
  const latestAttemptRows = ownedRows.filter((row) => row.attemptId === latestLaunch.attemptId);
  const ownedRefs = new Set(latestAttemptRows.map((row) => row.sessionRef));
  const latestLaunchMs = Math.max(...latestAttemptRows.map(launchMs));
  const candidateDirs = nativeStreamCandidates({
    featureDir: input.featureDir,
    repoDir: input.repoDir,
    worktreePath: input.worktreePath,
    stage: input.stage,
  });

  const streamFiles: string[] = [];
  for (const dir of candidateDirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        if (!name.startsWith(`${input.stage}-`)) continue;
        const file = join(dir, name);
        try {
          const stat = statSync(file);
          if (stat.isFile()) streamFiles.push(file);
        } catch {
          // Skipped: readdir entry no longer resolvable.
        }
      }
    } catch {
      // Dir disappeared mid-scan.
    }
  }
  if (streamFiles.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `no native session stream for stage=${input.stage}`,
    };
  }

  const relevantEvents: Array<{ sessionStartedModel?: string; sessionStartedProvider?: string; events: NativeAssistantMessageEvent[] }> = [];
  for (const file of streamFiles) {
    const events = readSessionEvents(file);
    let currentSegmentStart: NativeSessionStartedEvent | null = null;
    let acceptSegment = false;
    let segmentAssistants: NativeAssistantMessageEvent[] = [];
    const commit = () => {
      if (currentSegmentStart && acceptSegment && segmentAssistants.length > 0) {
        relevantEvents.push({
          sessionStartedModel: currentSegmentStart.model,
          sessionStartedProvider: currentSegmentStart.provider,
          events: segmentAssistants,
        });
      }
      segmentAssistants = [];
    };
    for (const event of events) {
      if (isSessionStartedEvent(event)) {
        commit();
        currentSegmentStart = event;
        acceptSegment = ownedRefs.has(event.sessionId);
        if (acceptSegment && Number.isFinite(latestLaunchMs)
          && typeof event.timestamp === 'number'
          && event.timestamp < latestLaunchMs) {
          // Prior run on the same session file: ignore events until the next
          // session_started (D5 step 2 "latest launchedAt" scoping).
          acceptSegment = false;
        }
        continue;
      }
      if (!acceptSegment) continue;
      if (isAssistantMessageEvent(event)) {
        if (!ownedRefs.has(event.sessionId)) continue;
        if (Number.isFinite(latestLaunchMs)
          && typeof event.timestamp === 'number'
          && event.timestamp < latestLaunchMs) {
          continue;
        }
        segmentAssistants.push(event);
      }
    }
    commit();
  }

  if (relevantEvents.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `no owned native turns after latest launch for stage=${input.stage}`,
    };
  }

  // Each retained segment carries its own wire identity. This matters when a
  // native attempt has more than one owned session: never verdict one
  // segment's provider response against another segment's requested model.
  const firstSegment = relevantEvents[0]!;
  const sessionStartedModel = firstSegment.sessionStartedModel;
  if (!sessionStartedModel) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: 'native session_started did not record a model id',
    };
  }
  const firstIsAlias = isRollingProviderAlias(sessionStartedModel);
  const firstCertifiedTarget = firstIsAlias
    ? existing?.executionEvidence?.certifiedTarget
    : sessionStartedModel;
  if (firstIsAlias && !firstCertifiedTarget) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `native alias ${sessionStartedModel} resolved target unknown (no certified target)`,
    };
  }

  const tracker = new ProviderIdentityTracker();
  let turnIndex = 0;
  for (const segment of relevantEvents) {
    const segmentModel = segment.sessionStartedModel;
    if (!segmentModel) {
      return {
        executedModel: null,
        evidenceStatus: 'missing',
        evidenceSource: 'session-stream',
        evidenceDetail: 'native session_started did not record a model id',
      };
    }
    const isAlias = isRollingProviderAlias(segmentModel);
    const certifiedTarget = isAlias ? existing?.executionEvidence?.certifiedTarget : segmentModel;
    if (isAlias && !certifiedTarget) {
      return {
        executedModel: null,
        evidenceStatus: 'missing',
        evidenceSource: 'session-stream',
        evidenceDetail: `native alias ${segmentModel} resolved target unknown (no certified target)`,
      };
    }
    const expectation: ProviderIdentityExpectation = {
      requestedWireId: segmentModel,
      expectedModel: certifiedTarget,
      isAlias,
    };
    for (const event of segment.events) {
      const wire = event.model ?? segmentModel;
      const reported = extractProviderReportedIdentity(
        { responseModel: event.responseModel, responseId: event.responseId },
        wire,
      );
      const decision = verifyProviderIdentity(expectation, reported);
      tracker.record({ turnIndex, decision, reported });
      turnIndex += 1;
    }
  }

  const summary: ProviderIdentitySummary = tracker.summary();
  if (summary.identityVerdict === 'mismatch') {
    return {
      executedModel: summary.executedModel,
      evidenceStatus: 'contradicted',
      evidenceSource: 'session-stream',
      evidenceDetail: `session-stream: ${summary.mismatchDetail ?? 'provider identity mismatch'}`,
      providerEvidence: {
        ...(summary.providerReportedModel ? { providerReportedModel: summary.providerReportedModel } : {}),
        requestedWireId: sessionStartedModel,
        ...(firstCertifiedTarget ? { certifiedTarget: firstCertifiedTarget } : {}),
        identityVerdict: 'mismatch',
        ...(firstSegment.sessionStartedProvider ? { transportProvider: firstSegment.sessionStartedProvider } : {}),
        ...(summary.lastResponseId ? { responseId: summary.lastResponseId } : {}),
      },
    };
  }
  if (summary.identityVerdict !== 'match' && summary.identityVerdict !== 'alias-resolved') {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `session-stream: no verifiable provider identity (${summary.identityVerdict}, turns=${turnIndex})`,
    };
  }

  const executedModel = summary.executedModel ?? sessionStartedModel;
  return {
    executedModel,
    evidenceStatus: 'direct',
    evidenceSource: 'provider-response',
    evidenceDetail: `session-stream: verified ${summary.identityVerdict} after ${summary.turnsVerified} turn(s)`,
    providerEvidence: {
      ...(summary.providerReportedModel ? { providerReportedModel: summary.providerReportedModel } : {}),
      requestedWireId: sessionStartedModel,
      ...(firstCertifiedTarget ? { certifiedTarget: firstCertifiedTarget } : {}),
      identityVerdict: summary.identityVerdict,
      ...(firstSegment.sessionStartedProvider ? { transportProvider: firstSegment.sessionStartedProvider } : {}),
      ...(summary.lastResponseId ? { responseId: summary.lastResponseId } : {}),
    },
  };
}

// ────────────────────────────────────────────────────────────────
// HOK-3415: repair-stage resolver (ci-fix / conflict-resolution / ready-remediation)
// ────────────────────────────────────────────────────────────────

/**
 * Ownership kinds that carry work for a repair stage. These are not
 * `OwnershipStage`s (planning / coding / review) and have no
 * `.<kind>-result.json` to cross-check against (except `ready-remediation`
 * which has `.ready-result.json`), so repair-stage evidence is `requested_only`
 * (launch row's `model`) — mapped from the resolver's `missing` status.
 */
export const REPAIR_STAGE_KINDS = ['ci-fix', 'conflict-resolution', 'ready-remediation'] as const;
export type RepairStageKind = (typeof REPAIR_STAGE_KINDS)[number];

export function isRepairStageKind(value: unknown): value is RepairStageKind {
  return typeof value === 'string'
    && (REPAIR_STAGE_KINDS as readonly string[]).includes(value);
}

export interface ResolveRepairStageExecutedModelInput {
  /** State directory holding `.session-ownership.jsonl`. */
  featureDir: string;
  /** Repair kind to resolve. */
  kind: RepairStageKind;
  /** Ownership rows the caller already read; absent means read from disk. */
  ownership?: readonly SessionOwnershipRow[];
}

export interface ResolvedRepairStageExecutedModel {
  executedModel: string | null;
  evidenceStatus: ExecutedModelEvidenceStatus;
  evidenceSource: 'launch-record' | 'unknown';
  evidenceDetail: string;
  /** Harness the repair stage ran under, read from the launch row. */
  harness: SessionHarness | null;
}

/**
 * Resolve a repair stage's executed model from the launch rows. Repair stages
 * don't publish provider identity evidence (no coding / review stage result),
 * so the launch row's model and harness are the evidence. The latest launch
 * row wins — a retried `ci-fix` keeps the retry's model.
 */
export function resolveRepairStageExecutedModel(
  input: ResolveRepairStageExecutedModelInput,
): ResolvedRepairStageExecutedModel {
  const ownership = input.ownership ?? readOwnershipRowsSafe(input.featureDir);
  const rows = ownership.filter((row): row is SessionOwnershipRow => row.kind === input.kind);
  if (rows.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'unknown',
      evidenceDetail: `no ownership row for kind=${input.kind}`,
      harness: null,
    };
  }
  const latest = rows.reduce((max, row) => (
    Date.parse(row.launchedAt) > Date.parse(max.launchedAt) ? row : max
  ));
  if (!latest.model) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'launch-record',
      evidenceDetail: `kind=${input.kind}: launch row has no model (attempt=${latest.attemptId})`,
      harness: latest.harness,
    };
  }
  return {
    executedModel: latest.model,
    // Launch-record evidence is intent, not execution — map to `requested_only`
    // at the projection boundary. `missing` here keeps the rule in one place.
    evidenceStatus: 'missing',
    evidenceSource: 'launch-record',
    evidenceDetail: `kind=${input.kind}: launch ${latest.attemptId} at ${latest.launchedAt}`,
    harness: latest.harness,
  };
}

/** Ownership kinds that the repair-stage resolver understands, as a type guard. */
export function isRepairOwnershipKind(kind: OwnershipKind): kind is RepairStageKind {
  return isRepairStageKind(kind);
}
