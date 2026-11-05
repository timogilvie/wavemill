import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngestUsageInput } from '@hokusai/costs';
import {
  resolveExecutedModelFromSessions,
  resolveStageExecutedModel,
} from './executed-model-resolver.ts';
import {
  appendOwnershipRow,
  helperKind,
  type SessionOwnershipRow,
} from './session-ownership.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';
import type { StageResult } from './stage-result.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function withTempHome(prefix: string) {
  const tmpHome = mkdtempSync(join(tmpdir(), prefix));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  cleanups.push(() => {
    process.env.HOME = oldHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });
  return tmpHome;
}

function setupClaude() {
  const home = withTempHome('resolver-claude-');
  const worktreePath = join(home, 'worktree');
  const projectsDir = join(home, '.claude', 'projects', encodeProjectDir(worktreePath));
  mkdirSync(projectsDir, { recursive: true });
  return { home, worktreePath, projectsDir };
}

/** Launch rows naming `sessionRefs` (Claude: the transcript file stem) as owned work. */
function owned(
  harness: SessionOwnershipRow['harness'],
  sessionRefs: string[],
  kind: SessionOwnershipRow['kind'] = 'coding',
): SessionOwnershipRow[] {
  const stage = kind === 'planning' || kind === 'coding' || kind === 'review' ? kind : undefined;
  return sessionRefs.map((sessionRef) => ({
    sessionRef,
    harness,
    kind,
    ...(stage ? { stage } : {}),
    model: '',
    launchedAt: '2026-09-15T10:00:00.000Z',
    attemptId: `${kind}@nohead#1`,
  }));
}

function writeJsonl(filePath: string, entries: unknown[]) {
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function claudeTurn(opts: {
  sessionId?: string;
  branch?: string;
  model?: string;
  timestamp: string;
  isSidechain?: boolean;
  uuid?: string;
}) {
  return {
    type: 'assistant',
    sessionId: opts.sessionId ?? 'sess',
    timestamp: opts.timestamp,
    uuid: opts.uuid ?? `turn-${opts.timestamp}`,
    parentUuid: null,
    isSidechain: opts.isSidechain ?? false,
    gitBranch: opts.branch ?? 'task/HOK-3017',
    requestId: `req-${opts.timestamp}`,
    message: {
      id: `msg-${opts.timestamp}`,
      model: opts.model ?? 'claude-haiku-4-5',
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
    },
  };
}

function row(opts: {
  sessionId: string;
  model: string;
  timestamp: string;
  harness?: 'claude-code' | 'codex';
  isSubagent?: boolean;
  seq?: number;
}): IngestUsageInput {
  const harness = opts.harness ?? 'claude-code';
  const turnId = `turn-${opts.sessionId}-${opts.timestamp}`;
  return {
    eventId: turnId,
    taskId: 'test-task',
    sessionId: opts.sessionId,
    turnId,
    sequence: opts.seq ?? 1,
    harness,
    providerContractVersion: harness === 'claude-code' ? 'claude-code/1' : 'codex/1',
    observedModel: opts.model,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null },
    usageKind: 'delta',
    observedAt: opts.timestamp,
    ...(typeof opts.isSubagent === 'boolean' ? { isSubagent: opts.isSubagent } : {}),
  };
}

function rowsLookup(map: Record<string, IngestUsageInput[]>): (sessionRef: string) => readonly IngestUsageInput[] {
  return (sessionRef) => map[sessionRef] ?? [];
}

describe('resolveExecutedModelFromSessions', () => {
  it('resolves a single Claude model from the stage\'s owned session', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: owned('claude-code', ['claude']),
      usageRowsForSession: rowsLookup({
        claude: [row({ sessionId: 'claude', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z' })],
      }),
    });

    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'claude-session');
  });

  it('ignores a helper session that ran while the stage was open', () => {
    // protects: a helper turn in the stage window setting the stage's executed model (HOK-3328)
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: [...owned('claude-code', ['coder']), ...owned('claude-code', ['helper'], helperKind('json-code-review'))],
      usageRowsForSession: rowsLookup({
        coder: [row({ sessionId: 'coder', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z' })],
        helper: [
          row({ sessionId: 'helper', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:02:00.000Z' }),
          row({ sessionId: 'helper', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:03:00.000Z' }),
        ],
      }),
    });

    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.match(result.evidenceDetail, /sessions=1/);
  });

  it('reports missing evidence when no session is owned for the stage', () => {
    // protects: falling back to whatever ran in the worktree when the launch recorded nothing
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'review',
      ownership: owned('claude-code', ['claude']),
      usageRowsForSession: rowsLookup({
        claude: [row({ sessionId: 'claude', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z' })],
      }),
    });

    assert.equal(result.executedModel, null);
    assert.equal(result.evidenceStatus, 'missing');
    assert.match(result.evidenceDetail, /no claude session owned for stage=review/);
  });

  it('ignores Claude sidechain turns when main-loop turns exist', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: owned('claude-code', ['claude']),
      usageRowsForSession: rowsLookup({
        claude: [
          row({ sessionId: 'claude', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z', isSubagent: true }),
          row({ sessionId: 'claude', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:02:00.000Z', isSubagent: false }),
        ],
      }),
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /excludedSubagentTurns=1/);
  });

  it('chooses the dominant Claude model and reports every observed model', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: owned('claude-code', ['claude']),
      usageRowsForSession: rowsLookup({
        claude: [
          row({ sessionId: 'claude', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z' }),
          row({ sessionId: 'claude', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:02:00.000Z' }),
          row({ sessionId: 'claude', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:03:00.000Z' }),
        ],
      }),
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /claude-sonnet-5:2/);
    assert.match(result.evidenceDetail, /claude-haiku-4-5:1/);
  });

  it('reports missing evidence without echoing an intended model', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: owned('claude-code', ['claude']),
      usageRowsForSession: rowsLookup({}),
    });

    assert.equal(result.executedModel, null);
    assert.equal(result.evidenceStatus, 'missing');
    assert.doesNotMatch(result.evidenceDetail, /gpt-5\.5|claude-haiku-4-5/);
  });

  it('resolves a Codex rollout model from the stage\'s owned session', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'codex',
      stage: 'coding',
      ownership: owned('codex', ['codex-session']),
      usageRowsForSession: rowsLookup({
        'codex-session': [row({ sessionId: 'codex-session', model: 'gpt-5.5', timestamp: '2026-09-15T10:01:00.000Z', harness: 'codex' })],
      }),
    });

    assert.equal(result.executedModel, 'gpt-5.5');
    assert.equal(result.evidenceSource, 'codex-session');
  });

  it('merges overlapping sessions before computing dominance', () => {
    const result = resolveExecutedModelFromSessions({
      agent: 'claude',
      stage: 'coding',
      ownership: owned('claude-code', ['one', 'two']),
      usageRowsForSession: rowsLookup({
        one: [row({ sessionId: 'one', model: 'claude-haiku-4-5', timestamp: '2026-09-15T10:01:00.000Z' })],
        two: [
          row({ sessionId: 'two', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:02:00.000Z' }),
          row({ sessionId: 'two', model: 'claude-sonnet-5', timestamp: '2026-09-15T10:03:00.000Z' }),
        ],
      }),
    });

    assert.equal(result.executedModel, 'claude-sonnet-5');
    assert.match(result.evidenceDetail, /sessions=2/);
  });
});

// ────────────────────────────────────────────────────────────────
// HOK-3369: resolveStageExecutedModel (one resolver per harness)
// ────────────────────────────────────────────────────────────────

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function nativeStartedEvent(opts: { sessionId: string; model: string; provider?: string; timestamp: number }) {
  return {
    seq: 0,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    type: 'session_started',
    model: opts.model,
    provider: opts.provider ?? 'openrouter',
    api: 'openai-completions',
  };
}

function nativeAssistantMessage(opts: {
  sessionId: string;
  model: string;
  responseId?: string;
  responseModel?: string;
  seq: number;
  timestamp: number;
}) {
  return {
    seq: opts.seq,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    type: 'assistant_message',
    model: opts.model,
    stopReason: 'end_turn',
    rawContent: [],
    replayContent: [],
    redacted: true,
    ...(opts.responseId ? { responseId: opts.responseId } : {}),
    ...(opts.responseModel ? { responseModel: opts.responseModel } : {}),
  };
}

/**
 * Build a feature + repo pair with a `.session-ownership.jsonl` row and a
 * native-session JSONL under the repo's `.wavemill/runs/<session>/native-sessions/`.
 */
function setupNativeStageFixture(opts: {
  stage: 'planning' | 'coding' | 'review';
  sessionRef: string;
  wireModel: string;
  launchedAt: string;
  streamEvents: unknown[];
  session?: string;
}): { featureDir: string; repoDir: string; worktreePath: string; branchName: string } {
  const home = tempDir('resolver-native-');
  const repoDir = home;
  const worktreePath = join(repoDir, 'worktrees', 'wt-under-test');
  mkdirSync(worktreePath, { recursive: true });
  const featureDir = join(worktreePath, 'features', 'my-task');
  mkdirSync(featureDir, { recursive: true });
  // Ownership row — recordLaunch would normally do this; append directly to
  // keep the fixture independent of transport details.
  appendOwnershipRow(featureDir, {
    sessionRef: opts.sessionRef,
    harness: 'native',
    kind: 'native-arm',
    stage: opts.stage,
    model: opts.wireModel,
    launchedAt: opts.launchedAt,
    attemptId: 'native-arm@nohead#1',
  });
  const session = opts.session ?? 'wavemill';
  const runsDir = join(repoDir, '.wavemill', 'runs', session, 'native-sessions');
  mkdirSync(runsDir, { recursive: true });
  const streamFile = join(runsDir, `${opts.stage}-HOK-3369.jsonl`);
  writeJsonl(streamFile, opts.streamEvents);
  return { featureDir, repoDir, worktreePath, branchName: 'task/HOK-3369' };
}

describe('resolveStageExecutedModel (HOK-3369)', () => {
  // protects: the HOK-3322_c replay — 19 echoed-responseId turns on
  // moonshotai/kimi-k2-thinking produce direct/provider-response evidence.
  it('verifies a native echo stream and returns direct / provider-response', () => {
    const sessionId = 'wavemill-planning-HOK-3322_c';
    const wireModel = 'moonshotai/kimi-k2-thinking';
    const launchedAt = '2026-10-30T15:48:06.478Z';
    const launchMs = Date.parse(launchedAt);
    const events: unknown[] = [
      nativeStartedEvent({ sessionId, model: wireModel, timestamp: launchMs + 1 }),
    ];
    for (let i = 0; i < 19; i++) {
      events.push(
        nativeAssistantMessage({
          sessionId,
          model: wireModel,
          responseId: `gen-${i}-abc`,
          seq: i + 2,
          timestamp: launchMs + 1000 * (i + 1),
        }),
      );
    }
    const fx = setupNativeStageFixture({
      stage: 'planning',
      sessionRef: sessionId,
      wireModel,
      launchedAt,
      streamEvents: events,
    });

    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'planning',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: null,
      agentHint: 'native-openrouter',
    });

    assert.equal(result.executedModel, wireModel);
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'provider-response');
    assert.match(result.evidenceDetail, /verified match after 19 turn\(s\)/);
    assert.equal(result.providerEvidence?.identityVerdict, 'match');
    assert.equal(result.providerEvidence?.requestedWireId, wireModel);
    assert.equal(result.providerEvidence?.responseId, 'gen-18-abc');
  });

  // protects: the launcher's `direct` evidence is returned without reading
  // the session stream (fast path, D5 step 1).
  it('returns an existing launcher provider-response record without reading the stream', () => {
    const sessionId = 'wavemill-planning-fast-path';
    const wireModel = 'moonshotai/kimi-k2-thinking';
    const launchedAt = '2026-10-30T15:48:06.478Z';
    const fx = setupNativeStageFixture({
      stage: 'planning',
      sessionRef: sessionId,
      wireModel,
      launchedAt,
      streamEvents: [
        // Deliberately empty stream — if the fast path is wrong, the resolver
        // would miss evidence.
        nativeStartedEvent({ sessionId, model: wireModel, timestamp: Date.parse(launchedAt) + 1 }),
      ],
    });
    const existing: Partial<StageResult> = {
      stage: 'planning',
      status: 'awaiting_user',
      agent: 'native',
      model: wireModel,
      executedModel: wireModel,
      executionEvidence: {
        status: 'direct',
        source: 'provider-response',
        detail: 'launcher record',
        recordedAt: '2026-10-30T16:07:16Z',
        identityVerdict: 'match',
        requestedWireId: wireModel,
        certifiedTarget: wireModel,
        responseId: 'gen-abc',
        transportProvider: 'openrouter',
      },
    };
    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'planning',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: existing as StageResult,
    });
    assert.equal(result.executedModel, wireModel);
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'provider-response');
    assert.equal(result.evidenceDetail, 'launcher record');
    // HOK-3369: the fast path exports provider-identity fields from the
    // existing block so a subsequent CLI write that supplies --executed-model
    // (via the resolver answer) can reinstate them.
    assert.equal(result.providerEvidence?.identityVerdict, 'match');
    assert.equal(result.providerEvidence?.responseId, 'gen-abc');
    assert.equal(result.providerEvidence?.transportProvider, 'openrouter');
  });

  // protects: a mid-stream responseModel differing from the non-alias wire
  // id → contradicted (HOK-3143 guard).
  it('returns contradicted when responseModel differs from a non-alias wire id', () => {
    const sessionId = 'wavemill-coding-mismatch';
    const wireModel = 'claude-opus-5-5';
    const launchedAt = '2026-10-30T15:48:06.478Z';
    const launchMs = Date.parse(launchedAt);
    const events: unknown[] = [
      nativeStartedEvent({ sessionId, model: wireModel, timestamp: launchMs + 1 }),
      nativeAssistantMessage({
        sessionId,
        model: wireModel,
        responseId: 'gen-1',
        responseModel: 'surprise-substitute-model',
        seq: 2,
        timestamp: launchMs + 1000,
      }),
    ];
    const fx = setupNativeStageFixture({
      stage: 'coding',
      sessionRef: sessionId,
      wireModel,
      launchedAt,
      streamEvents: events,
    });

    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'coding',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: null,
      agentHint: 'native',
    });
    assert.equal(result.evidenceStatus, 'contradicted');
    assert.equal(result.executedModel, 'surprise-substitute-model');
    assert.equal(result.providerEvidence?.identityVerdict, 'mismatch');
  });

  it('returns missing when no owned native session exists for the stage', () => {
    const home = tempDir('resolver-native-missing-');
    const worktreePath = join(home, 'worktrees', 'wt');
    const featureDir = join(worktreePath, 'features', 'task');
    mkdirSync(featureDir, { recursive: true });
    const result = resolveStageExecutedModel({
      featureDir,
      stage: 'planning',
      worktreePath,
      branchName: 'task/HOK-3369',
      repoDir: home,
      existing: null,
      agentHint: 'native',
    });
    assert.equal(result.executedModel, null);
    assert.equal(result.evidenceStatus, 'missing');
  });

  it('returns missing when the stream has no responseId on any turn', () => {
    const sessionId = 'wavemill-planning-no-responseid';
    const wireModel = 'moonshotai/kimi-k2-thinking';
    const launchedAt = '2026-10-30T15:48:06.478Z';
    const launchMs = Date.parse(launchedAt);
    const fx = setupNativeStageFixture({
      stage: 'planning',
      sessionRef: sessionId,
      wireModel,
      launchedAt,
      streamEvents: [
        nativeStartedEvent({ sessionId, model: wireModel, timestamp: launchMs + 1 }),
        nativeAssistantMessage({
          sessionId, model: wireModel, seq: 2, timestamp: launchMs + 1000,
        }),
      ],
    });
    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'planning',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: null,
      agentHint: 'native',
    });
    // No responseId / no responseModel → kind='absent' → unverifiable → missing.
    assert.equal(result.executedModel, null);
    assert.equal(result.evidenceStatus, 'missing');
    assert.match(result.evidenceDetail, /unverifiable|no verifiable/);
  });

  it('reads the Claude harness when the ownership row says claude-code (not the agent label)', () => {
    // protects: HOK-3322_c review result had agent:codex but the row said
    // claude-code; keying off the row fixes it.
    const home = tempDir('resolver-harness-override-');
    const worktreePath = join(home, 'worktree');
    const projectsDir = join(home, '.claude', 'projects', encodeProjectDir(worktreePath));
    mkdirSync(projectsDir, { recursive: true });
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    cleanups.push(() => { process.env.HOME = oldHome; });
    writeJsonl(join(projectsDir, 'sess.jsonl'), [
      claudeTurn({ timestamp: '2026-09-15T10:01:00.000Z', model: 'claude-haiku-4-5' }),
    ]);
    const featureDir = join(worktreePath, 'features', 'task');
    mkdirSync(featureDir, { recursive: true });
    appendOwnershipRow(featureDir, {
      sessionRef: 'sess',
      harness: 'claude-code',
      kind: 'review',
      stage: 'review',
      model: 'claude-haiku-4-5',
      launchedAt: '2026-09-15T10:00:00.000Z',
      attemptId: 'review@nohead#1',
    });

    const result = resolveStageExecutedModel({
      featureDir,
      stage: 'review',
      worktreePath,
      branchName: 'task/HOK-3017',
      repoDir: home,
      existing: null,
      // Deliberately conflicting agent hint; the row should win.
      agentHint: 'codex',
    });
    assert.equal(result.executedModel, 'claude-haiku-4-5');
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.evidenceSource, 'claude-session');
  });

  it('ignores assistant events before the latest launchedAt in a shared stream file', () => {
    const sessionId = 'wavemill-planning-shared';
    const wireModel = 'moonshotai/kimi-k2-thinking';
    const launchedAt = '2026-10-30T15:48:06.478Z';
    const launchMs = Date.parse(launchedAt);
    const events: unknown[] = [
      // Prior run on the same session file — before the latest launchedAt.
      nativeStartedEvent({ sessionId, model: wireModel, timestamp: launchMs - 10_000 }),
      nativeAssistantMessage({
        sessionId, model: wireModel, responseId: 'gen-prior',
        seq: 2, timestamp: launchMs - 5000,
      }),
      // Current run.
      nativeStartedEvent({ sessionId, model: wireModel, timestamp: launchMs + 100 }),
      nativeAssistantMessage({
        sessionId, model: wireModel, responseId: 'gen-current',
        seq: 4, timestamp: launchMs + 500,
      }),
    ];
    const fx = setupNativeStageFixture({
      stage: 'planning',
      sessionRef: sessionId,
      wireModel,
      launchedAt,
      streamEvents: events,
    });
    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'planning',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: null,
      agentHint: 'native',
    });
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.providerEvidence?.responseId, 'gen-current');
  });

  it('ignores a prior attempt session that emits after a newer native retry launches', () => {
    const previousSession = 'wavemill-planning-prior-attempt';
    const currentSession = 'wavemill-planning-current-attempt';
    const previousModel = 'previous-provider/model';
    const currentModel = 'moonshotai/kimi-k2-thinking';
    const previousLaunchAt = '2026-10-30T15:48:06.478Z';
    const currentLaunchAt = '2026-10-30T16:00:00.000Z';
    const currentLaunchMs = Date.parse(currentLaunchAt);
    const fx = setupNativeStageFixture({
      stage: 'planning',
      sessionRef: previousSession,
      wireModel: previousModel,
      launchedAt: previousLaunchAt,
      streamEvents: [],
    });
    appendOwnershipRow(fx.featureDir, {
      sessionRef: currentSession,
      harness: 'native',
      kind: 'native-arm',
      stage: 'planning',
      model: currentModel,
      launchedAt: currentLaunchAt,
      attemptId: 'native-arm@nohead#2',
    });
    writeJsonl(join(fx.repoDir, '.wavemill', 'runs', 'wavemill', 'native-sessions', 'planning-HOK-3369.jsonl'), [
      // This event is late but belongs to the prior attempt. Filtering only
      // on timestamp would include it and compare the current model against
      // the prior wire identity.
      nativeStartedEvent({ sessionId: previousSession, model: previousModel, timestamp: currentLaunchMs + 10 }),
      nativeAssistantMessage({
        sessionId: previousSession, model: previousModel, responseId: 'gen-prior-late', seq: 2, timestamp: currentLaunchMs + 20,
      }),
      nativeStartedEvent({ sessionId: currentSession, model: currentModel, timestamp: currentLaunchMs + 30 }),
      nativeAssistantMessage({
        sessionId: currentSession, model: currentModel, responseId: 'gen-current', seq: 4, timestamp: currentLaunchMs + 40,
      }),
    ]);

    const result = resolveStageExecutedModel({
      featureDir: fx.featureDir,
      stage: 'planning',
      worktreePath: fx.worktreePath,
      branchName: fx.branchName,
      repoDir: fx.repoDir,
      existing: null,
      agentHint: 'native',
    });
    assert.equal(result.evidenceStatus, 'direct');
    assert.equal(result.executedModel, currentModel);
    assert.equal(result.providerEvidence?.responseId, 'gen-current');
  });
});
