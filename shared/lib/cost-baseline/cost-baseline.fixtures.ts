/**
 * Builders for cost-baseline unit tests (HOK-3336). Defaults describe an empty
 * merged task; tests override only what they assert on.
 */
import type { BaselineSession, BaselineTask, LabelEvent, LaneProgress } from './types.ts';

export function session(overrides: Partial<BaselineSession> = {}): BaselineSession {
  return {
    sessionId: 'session-1',
    harness: 'claude-code',
    kind: 'coding',
    confidence: 'launch_record',
    launchEvidence: null,
    costUsd: 0,
    costSource: 'local_estimate',
    firstTurnAt: null,
    lastTurnAt: null,
    turnCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function task(overrides: Partial<BaselineTask> = {}): BaselineTask {
  return {
    issueId: 'HOK-1',
    isChallenger: false,
    evalTimestamp: '2026-10-20T00:00:00.000Z',
    prNumber: 100,
    workflowCost: null,
    workflowCostStatus: 'success',
    phaseDurations: {},
    timeToMergeSeconds: null,
    ciChecks: [],
    ciPassed: true,
    sessions: [],
    lane: null,
    labelEvents: [],
    review: null,
    prState: null,
    ...overrides,
  };
}

export function lane(overrides: Partial<LaneProgress> = {}): LaneProgress {
  return {
    prNumber: 100,
    enteredLaneAt: null,
    lastProgressAt: null,
    lastEvent: null,
    laneHoldSeconds: null,
    mergeAttemptCount: null,
    rebaseCount: null,
    ciRestartCount: null,
    ...overrides,
  };
}

export function label(at: string, labelName: string, action: LabelEvent['action'], prNumber = 100): LabelEvent {
  return { at, prNumber, label: labelName, action };
}
