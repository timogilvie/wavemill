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
import { join } from 'node:path';
import { getSessionAdapter } from './session-adapters.ts';
import type { ExternalSessionTurn } from './session-adapters.ts';
import {
  readOwnershipRows,
  rowsForStage,
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

export type ExecutedModelResolverAgent = 'claude' | 'codex';
export type ExecutedModelEvidenceSource =
  | 'claude-session'
  | 'codex-session'
  | 'provider-response'
  | 'native-runtime'
  | 'session-stream';
export type ExecutedModelEvidenceStatus = 'direct' | 'missing' | 'contradicted';

export interface ResolveExecutedModelFromSessionsInput {
  worktreePath: string;
  branchName: string;
  agent: ExecutedModelResolverAgent;
  stage: OwnershipStage;
  /** The task's launch rows; only sessions owned for `stage` are read. */
  ownership: readonly SessionOwnershipRow[];
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
 */
export function resolveExecutedModelFromSessions(
  input: ResolveExecutedModelFromSessionsInput,
): ResolvedExecutedModelEvidence {
  const evidenceSource = sourceForAgent(input.agent);
  const owned = new Set(rowsForStage(input.ownership, input.stage)
    .filter((row) => row.harness === AGENT_HARNESS[input.agent])
    .map((row) => row.sessionRef));
  if (owned.size === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `no ${input.agent} session owned for stage=${input.stage}`,
    };
  }

  const adapter = getSessionAdapter(input.agent);
  const result = adapter.scan({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
  });
  const sessions = (result?.externalSessions ?? []).filter((session) => owned.has(session.sessionId));
  if (sessions.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `owned ${input.agent} sessions=${owned.size}; none found in telemetry for branch=${input.branchName}`,
    };
  }

  const candidates: CandidateTurn[] = [];
  let index = 0;
  for (const session of sessions) {
    for (const turn of session.turns) {
      index++;
      const candidate = candidateFromTurn(turn, session.sessionId, index);
      if (candidate) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `sessions=${sessions.length}; modelTurns=0`,
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

function candidateFromTurn(
  turn: ExternalSessionTurn,
  sessionId: string,
  index: number,
): CandidateTurn | null {
  if (!turn.model) return null;
  const timestampMs = (turn.timestamp ? parseTimestampMs(turn.timestamp) : null) ?? Number.NEGATIVE_INFINITY;
  return {
    model: turn.model,
    timestampMs,
    sessionId,
    isSubagent: turn.isSubagent,
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
  /** Repo root used to resolve native session streams. */
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
    const resolved = resolveExecutedModelFromSessions({
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      agent,
      stage: input.stage,
      ownership,
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
      return {
        executedModel: existing.executedModel,
        evidenceStatus: 'direct',
        evidenceSource: existingEvidence.source,
        evidenceDetail: existingEvidence.detail ?? 'launcher provider-identity record',
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
  const ownedRefs = new Set(ownedRows.map((row) => row.sessionRef));
  const latestLaunchMs = Math.max(
    ...ownedRows.map((row) => {
      const ms = Date.parse(row.launchedAt);
      return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    }),
  );
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

  // Pick one wire id to verdict against. The launcher is the single-model
  // producer, so the first segment's `session_started.model` is authoritative.
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
  const isAlias = isRollingProviderAlias(sessionStartedModel);
  const certifiedTarget = isAlias ? existing?.executionEvidence?.certifiedTarget : sessionStartedModel;
  if (isAlias && !certifiedTarget) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource: 'session-stream',
      evidenceDetail: `native alias ${sessionStartedModel} resolved target unknown (no certified target)`,
    };
  }
  const expectation: ProviderIdentityExpectation = {
    requestedWireId: sessionStartedModel,
    expectedModel: certifiedTarget as string,
    isAlias,
  };

  const tracker = new ProviderIdentityTracker();
  let turnIndex = 0;
  for (const segment of relevantEvents) {
    for (const event of segment.events) {
      const wire = event.model ?? segment.sessionStartedModel ?? sessionStartedModel;
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
        ...(certifiedTarget ? { certifiedTarget } : {}),
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
      ...(certifiedTarget ? { certifiedTarget } : {}),
      identityVerdict: summary.identityVerdict,
      ...(firstSegment.sessionStartedProvider ? { transportProvider: firstSegment.sessionStartedProvider } : {}),
      ...(summary.lastResponseId ? { responseId: summary.lastResponseId } : {}),
    },
  };
}
