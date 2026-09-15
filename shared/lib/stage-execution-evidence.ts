/**
 * Resolve execution-model evidence from the external CLI session telemetry.
 *
 * This deliberately fails closed. A model is direct only when telemetry in a
 * stage window is unambiguous, never because it happens to match the model
 * requested by the scheduler.
 */

import {
  ClaudeSessionAdapter,
  CodexSessionAdapter,
} from './session-adapters.ts';
import { canonicalizeModelId } from './model-registry.ts';

export interface StageExecutionEvidenceResolution {
  executedModel: string | null;
  evidenceStatus: 'direct' | 'missing';
  evidenceSource: 'claude-session' | 'codex-session' | 'unknown';
  detail: string;
  observedModels: string[];
}

export interface ResolveStageExecutionEvidenceOptions {
  agentType: 'claude' | 'codex' | 'claude-deepseek';
  worktreePath: string;
  branchName: string;
  windowStart: string | null;
  windowEnd: string | null;
  repoDir: string;
  claudeProjectsDirs?: string[];
  codexSessionsRoot?: string;
}

const WINDOW_SLACK_MS = 120_000;

function sourceFor(agentType: ResolveStageExecutionEvidenceOptions['agentType']): 'claude-session' | 'codex-session' {
  return agentType === 'codex' ? 'codex-session' : 'claude-session';
}

function missing(
  source: StageExecutionEvidenceResolution['evidenceSource'],
  detail: string,
  observedModels: string[] = [],
): StageExecutionEvidenceResolution {
  return { executedModel: null, evidenceStatus: 'missing', evidenceSource: source, detail, observedModels };
}

function inWindow(timestamp: string | null, start: number, end: number): boolean {
  if (!timestamp) return false;
  const instant = Date.parse(timestamp);
  return Number.isFinite(instant) && instant >= start - WINDOW_SLACK_MS && instant <= end + WINDOW_SLACK_MS;
}

/**
 * Read normalized Claude/Codex session turns for a stage window. Multiple
 * models in separate sessions are ambiguous (for example, monitor helpers),
 * whereas a dominant model within one session is direct evidence of a real
 * CLI fallback or /model switch.
 */
export async function resolveStageExecutionEvidence(
  opts: ResolveStageExecutionEvidenceOptions,
): Promise<StageExecutionEvidenceResolution> {
  const evidenceSource = sourceFor(opts.agentType);
  try {
    const start = opts.windowStart ? Date.parse(opts.windowStart) : Number.NEGATIVE_INFINITY;
    const end = opts.windowEnd ? Date.parse(opts.windowEnd) : Date.now();
    if (!Number.isFinite(end) || (opts.windowStart !== null && !Number.isFinite(start))) {
      return missing(evidenceSource, 'invalid_stage_window');
    }
    const result = opts.agentType === 'codex'
      ? new CodexSessionAdapter().scan({
        worktreePath: opts.worktreePath,
        branchName: opts.branchName,
        codexSessionsRoot: opts.codexSessionsRoot,
      })
      : new ClaudeSessionAdapter().scan({
        worktreePath: opts.worktreePath,
        branchName: opts.branchName,
        claudeProjectsDirs: opts.claudeProjectsDirs,
      });
    const sessions = result?.externalSessions ?? [];
    const counts = new Map<string, number>();
    const sessionsByModel = new Map<string, Set<string>>();
    const sessionCounts = new Map<string, Map<string, number>>();
    for (const session of sessions) {
      // A session first observed only after the controller terminalized this
      // stage belongs to the next phase, not to clock-skew slack around this
      // one. This prevents a newly launched reviewer/helper from poisoning a
      // completed coding window while retaining the ±120s turn tolerance for
      // sessions that actually overlap the stage.
      if (
        opts.windowEnd !== null
        && !session.turns.some((turn) => turn.timestamp !== null && Number.isFinite(Date.parse(turn.timestamp)) && Date.parse(turn.timestamp) <= end)
      ) continue;
      for (const turn of session.turns) {
        if (turn.isSubagent === true || !turn.model || turn.model === '<synthetic>' || !inWindow(turn.timestamp, start, end)) continue;
        const model = canonicalizeModelId(turn.model, opts.repoDir);
        if (!model) continue;
        counts.set(model, (counts.get(model) ?? 0) + 1);
        const sessionIds = sessionsByModel.get(model) ?? new Set<string>();
        sessionIds.add(session.sessionId);
        sessionsByModel.set(model, sessionIds);
        const perSession = sessionCounts.get(session.sessionId) ?? new Map<string, number>();
        perSession.set(model, (perSession.get(model) ?? 0) + 1);
        sessionCounts.set(session.sessionId, perSession);
      }
    }
    const observedModels = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model]) => model);
    if (observedModels.length === 0) return missing(evidenceSource, 'no_session_turns_in_window');
    const modelDetail = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([model, count]) => `${model}:${count}`).join(',');
    if (observedModels.length === 1) {
      return { executedModel: observedModels[0], evidenceStatus: 'direct', evidenceSource, detail: `session_models:${modelDetail}`, observedModels };
    }
    if (sessionCounts.size === 1) {
      const [dominant, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const secondCount = [...counts.values()].sort((a, b) => b - a)[1] ?? 0;
      if (dominantCount > secondCount) {
        return { executedModel: dominant, evidenceStatus: 'direct', evidenceSource, detail: `dominant_session_model:${modelDetail}`, observedModels };
      }
    }
    const perSessionDetail = [...sessionCounts.entries()]
      .map(([sessionId, models]) => `${sessionId}:${[...models.entries()].map(([model, count]) => `${model}:${count}`).join(',')}`)
      .join(';');
    return missing(evidenceSource, `ambiguous_models:${perSessionDetail}`, observedModels);
  } catch (error) {
    return missing(evidenceSource, `session_scan_error:${error instanceof Error ? error.message : String(error)}`);
  }
}
