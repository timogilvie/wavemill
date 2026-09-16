/**
 * Resolve execution identity for Claude Code / Codex CLI stages from retained
 * session telemetry.
 *
 * The resolver consumes the normalized HOK-2958 session detail exposed by
 * `session-adapters.ts`; it never reads launch intent and never fabricates an
 * executed model from the requested model.
 */

import { getSessionAdapter } from './session-adapters.ts';
import type { ExternalSessionTurn } from './session-adapters.ts';

export type ExecutedModelResolverAgent = 'claude' | 'codex';
export type ExecutedModelEvidenceSource = 'claude-session' | 'codex-session';
export type ExecutedModelEvidenceStatus = 'direct' | 'missing';

export interface ResolveExecutedModelFromSessionsInput {
  worktreePath: string;
  branchName: string;
  agent: ExecutedModelResolverAgent;
  startedAt: string;
  finishedAt: string;
  /** Backward-only clock-skew allowance in milliseconds. Defaults to 60s. */
  skewMs?: number;
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

const DEFAULT_SKEW_MS = 60_000;

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
 * Resolve the executed model from session turns that overlap a stage window.
 *
 * Turns are included when their timestamp falls in
 * `[startedAt - skewMs, finishedAt]`; no forward slack is applied so the next
 * stage cannot bleed into the current stage's attribution. When a stage has
 * both Claude main-loop and sidechain turns, sidechain turns are ignored for
 * model dominance.
 */
export function resolveExecutedModelFromSessions(
  input: ResolveExecutedModelFromSessionsInput,
): ResolvedExecutedModelEvidence {
  const evidenceSource = sourceForAgent(input.agent);
  const startedMs = parseTimestampMs(input.startedAt);
  const finishedMs = parseTimestampMs(input.finishedAt);
  if (startedMs === null || finishedMs === null || finishedMs < startedMs) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `invalid-window startedAt=${input.startedAt} finishedAt=${input.finishedAt}`,
    };
  }

  const adapter = getSessionAdapter(input.agent);
  const result = adapter.scan({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
  });
  if (!result?.externalSessions?.length) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `no matching ${input.agent} session telemetry for branch=${input.branchName}`,
    };
  }

  const windowStartMs = startedMs - (input.skewMs ?? DEFAULT_SKEW_MS);
  const windowEndMs = finishedMs;
  const candidates: CandidateTurn[] = [];
  let timestampedTurns = 0;
  let inWindowTurns = 0;
  let index = 0;

  for (const session of result.externalSessions) {
    for (const turn of session.turns) {
      index++;
      const candidate = candidateFromTurn(turn, session.sessionId, index);
      if (!candidate) continue;
      timestampedTurns++;
      if (candidate.timestampMs < windowStartMs || candidate.timestampMs > windowEndMs) {
        continue;
      }
      inWindowTurns++;
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return {
      executedModel: null,
      evidenceStatus: 'missing',
      evidenceSource,
      evidenceDetail: `sessions=${result.externalSessions.length}; timestampedTurns=${timestampedTurns}; inWindowTurns=${inWindowTurns}`,
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
  if (!turn.model || !turn.timestamp) return null;
  const timestampMs = parseTimestampMs(turn.timestamp);
  if (timestampMs === null) return null;
  return {
    model: turn.model,
    timestampMs,
    sessionId,
    isSubagent: turn.isSubagent,
    index,
  };
}
