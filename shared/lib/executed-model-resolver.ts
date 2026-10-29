/**
 * Resolve execution identity for Claude Code / Codex CLI stages from retained
 * session telemetry.
 *
 * Which sessions did a stage's work is read from the task's
 * `.session-ownership.jsonl` (HOK-3328): only turns of the sessions a launch
 * row names for that stage count, so a helper call that ran while the stage
 * was open can never set the stage's executed model. The resolver never reads
 * launch intent as the answer and never fabricates an executed model from the
 * requested model.
 */

import { getSessionAdapter } from './session-adapters.ts';
import type { ExternalSessionTurn } from './session-adapters.ts';
import { rowsForStage, type OwnershipStage, type SessionOwnershipRow } from './session-ownership.ts';

export type ExecutedModelResolverAgent = 'claude' | 'codex';
export type ExecutedModelEvidenceSource = 'claude-session' | 'codex-session';
export type ExecutedModelEvidenceStatus = 'direct' | 'missing';

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
