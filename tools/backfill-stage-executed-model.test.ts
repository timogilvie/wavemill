import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillStageExecutedModel } from './backfill-stage-executed-model.ts';
import { encodeProjectDir } from '../shared/lib/wavemill-session-paths.ts';
import { appendOwnershipRow } from '../shared/lib/session-ownership.ts';

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withHome(): string {
  const home = tempDir('backfill-executed-model-home-');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  cleanupFns.push(() => {
    process.env.HOME = oldHome;
  });
  return home;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function stageResult(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'coding',
    status: 'completed',
    startedAt: '2026-09-15T10:00:00.000Z',
    finishedAt: '2026-09-15T10:05:00.000Z',
    agent: 'claude',
    model: 'claude-haiku-4-5',
    intendedModel: 'claude-haiku-4-5',
    executedModel: null,
    executionEvidence: { status: 'missing', source: 'unknown' },
    modelAttributionEligible: false,
    modelAttributionIneligibleReason: 'missing_execution_evidence',
    notes: '',
    ...overrides,
  };
}

function claudeTurn(worktreePath: string) {
  return {
    type: 'assistant',
    timestamp: '2026-09-15T10:01:00.000Z',
    uuid: 'turn-1',
    parentUuid: null,
    isSidechain: false,
    gitBranch: 'task/HOK-3017',
    message: {
      model: 'claude-haiku-4-5',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 3,
      },
    },
    cwd: worktreePath,
  };
}

function setupArtifactWithClaudeSession() {
  const home = withHome();
  const artifactDir = tempDir('backfill-executed-model-artifact-');
  const worktreePath = join(home, 'deleted-worktree');
  const projectsDir = join(home, '.claude', 'projects', encodeProjectDir(worktreePath));
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(projectsDir, 'session.jsonl'), `${JSON.stringify(claudeTurn(worktreePath))}\n`, 'utf8');
  writeJson(join(artifactDir, 'terminal-record.json'), {
    worktree: worktreePath,
    branch: 'task/HOK-3017',
  });
  writeJson(join(artifactDir, '.coding-result.json'), stageResult());
  // The archived ownership record sits beside the stage result (HOK-3328).
  appendOwnershipRow(artifactDir, { sessionRef: 'session', harness: 'claude-code', kind: 'coding', model: 'claude-haiku-4-5' });
  return { artifactDir, worktreePath };
}

describe('backfillStageExecutedModel', () => {
  it('dry-runs artifact-dir updates without writing', () => {
    const { artifactDir } = setupArtifactWithClaudeSession();
    const file = join(artifactDir, '.coding-result.json');
    const before = readFileSync(file, 'utf8');

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir] });

    assert.equal(results.find((result) => result.stage === 'coding')?.action, 're-derived');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('applies session-derived executed model and recomputes eligibility', () => {
    const { artifactDir } = setupArtifactWithClaudeSession();
    const file = join(artifactDir, '.coding-result.json');

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });
    const coding = readJson(file);

    assert.equal(results.find((result) => result.stage === 'coding')?.applied, true);
    assert.equal(coding.executedModel, 'claude-haiku-4-5');
    assert.deepEqual(coding.executionEvidence && (coding.executionEvidence as Record<string, unknown>).status, 'direct');
    assert.equal((coding.executionEvidence as Record<string, unknown>).source, 'claude-session');
    assert.match(String((coding.executionEvidence as Record<string, unknown>).detail), /backfill:session-jsonl/);
    assert.equal(coding.modelAttributionEligible, true);
    assert.equal(coding.modelAttributionIneligibleReason, undefined);
  });

  it('leaves a no-evidence stage byte-identical', () => {
    withHome();
    const artifactDir = tempDir('backfill-executed-model-no-evidence-');
    const file = join(artifactDir, '.coding-result.json');
    writeJson(join(artifactDir, 'terminal-record.json'), {
      worktree: '/deleted/worktree',
      branch: 'task/HOK-3017',
    });
    writeJson(file, stageResult());
    const before = readFileSync(file, 'utf8');

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });

    assert.equal(results.find((result) => result.stage === 'coding')?.action, 'no-session-evidence');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('leaves existing direct evidence byte-identical without resolving it again', () => {
    const artifactDir = tempDir('backfill-executed-model-direct-');
    const file = join(artifactDir, '.coding-result.json');
    writeJson(file, stageResult({
      executedModel: 'claude-haiku-4-5',
      executionEvidence: {
        status: 'direct',
        source: 'claude-session',
        detail: 'original-launch-evidence',
        recordedAt: '2026-09-15T10:05:01.000Z',
      },
      modelAttributionEligible: true,
    }));
    const before = readFileSync(file, 'utf8');

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });

    assert.equal(results.find((result) => result.stage === 'coding')?.action, 'unchanged');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('discovers archived and live directories in ESM execution', () => {
    const repoDir = tempDir('backfill-executed-model-discovery-');
    const archived = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-3369');
    const live = join(repoDir, 'worktrees', 'active', 'features', 'HOK-3369');
    mkdirSync(archived, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeJson(join(archived, 'terminal-record.json'), { worktree: '/gone', branch: 'task/HOK-3369' });
    writeJson(join(archived, '.coding-result.json'), stageResult());
    writeJson(join(live, '.coding-result.json'), stageResult());

    const archivedResults = backfillStageExecutedModel({ allArchivedUnder: repoDir });
    const liveResults = backfillStageExecutedModel({ liveUnder: repoDir, worktree: '/gone', branch: 'task/HOK-3369' });

    assert.equal(archivedResults.find((result) => result.file === join(archived, '.coding-result.json'))?.action, 'no-session-evidence');
    // The synthetic live worktree is not a git checkout, so its missing
    // branch is expected; finding this result proves the ESM scanner ran.
    assert.equal(liveResults.find((result) => result.file === join(live, '.coding-result.json'))?.action, 'missing-input');
  });

  it('skips incomplete stages; a native stage with no stream reports no-session-evidence', () => {
    // HOK-3369: native results are no longer skipped as "unsupported_agent";
    // when the resolver has no stream to read, they report missing evidence.
    const artifactDir = tempDir('backfill-executed-model-skip-');
    writeJson(join(artifactDir, 'terminal-record.json'), {
      worktree: '/worktree',
      branch: 'task/HOK-3017',
    });
    writeJson(join(artifactDir, '.planning-result.json'), stageResult({ stage: 'planning', status: 'running' }));
    writeJson(join(artifactDir, '.coding-result.json'), stageResult({ agent: 'native', model: 'pi-model', intendedModel: 'pi-model' }));

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });

    assert.equal(results.find((result) => result.stage === 'planning')?.reason, 'stage_not_completed');
    assert.equal(results.find((result) => result.stage === 'coding')?.action, 'no-session-evidence');
  });

  // protects: HOK-3322_c — a native planning result with retained session
  // stream now recovers direct / provider-response evidence.
  it('recovers direct provider-response evidence for a native stage with a retained stream', () => {
    const home = tempDir('backfill-executed-model-native-');
    const repoDir = home;
    const worktreePath = join(repoDir, 'worktrees', 'wt');
    const sessionId = 'wavemill-planning-HOK-3322_c';
    const wireModel = 'moonshotai/kimi-k2-thinking';
    const launchedAtIso = '2026-10-30T15:48:06.478Z';
    const launchMs = Date.parse(launchedAtIso);

    const artifactDir = join(repoDir, '.wavemill', 'evals', 'artifacts', 'HOK-3322_c');
    mkdirSync(artifactDir, { recursive: true });
    writeJson(join(artifactDir, 'terminal-record.json'), {
      worktree: worktreePath,
      branch: 'task/HOK-3322_c',
    });
    writeJson(join(artifactDir, '.planning-result.json'), stageResult({
      stage: 'planning',
      status: 'completed',
      agent: 'native-openrouter',
      model: wireModel,
      intendedModel: 'kimi-k2-thinking',
      startedAt: '2026-10-30T15:47:49.765Z',
      finishedAt: '2026-10-30T16:07:16.871Z',
    }));
    // Append the archived ownership row and a native stream in the repo's
    // runs dir — the resolver reads it through the repo-dir seam.
    appendOwnershipRow(artifactDir, {
      sessionRef: sessionId,
      harness: 'native',
      kind: 'native-arm',
      stage: 'planning',
      model: wireModel,
      launchedAt: launchedAtIso,
      attemptId: 'native-arm@nohead#1',
    });
    const runsDir = join(repoDir, '.wavemill', 'runs', 'wavemill', 'native-sessions');
    mkdirSync(runsDir, { recursive: true });
    const streamFile = join(runsDir, 'planning-HOK-3322_c.jsonl');
    const streamEvents: unknown[] = [{
      seq: 0, sessionId, timestamp: launchMs + 1,
      type: 'session_started', model: wireModel, provider: 'openrouter', api: 'openai-completions',
    }];
    for (let i = 0; i < 19; i++) {
      streamEvents.push({
        seq: i + 2, sessionId, timestamp: launchMs + 1000 * (i + 1),
        type: 'assistant_message', model: wireModel, stopReason: 'end_turn',
        rawContent: [], replayContent: [], redacted: true, responseId: `gen-${i}-xyz`,
      });
    }
    writeFileSync(streamFile, streamEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const results = backfillStageExecutedModel({
      artifactDirs: [artifactDir],
      repoDir,
      apply: true,
    });
    const planning = results.find((r) => r.stage === 'planning');
    assert.equal(planning?.action, 're-derived');
    assert.equal(planning?.executedModel, wireModel);

    const written = readJson(join(artifactDir, '.planning-result.json'));
    assert.equal(written.executedModel, wireModel);
    const evidence = written.executionEvidence as Record<string, unknown>;
    assert.equal(evidence.status, 'direct');
    assert.equal(evidence.source, 'provider-response');
    assert.equal(evidence.identityVerdict, 'match');
    assert.equal(written.modelAttributionEligible, true);
    assert.equal(written.modelAttributionIneligibleReason, undefined);
  });

  // protects: HOK-3369 — the bare `<stage>-result.json` basename (older
  // archives such as HOK-3322_c) is recognised alongside the dotted name.
  it('finds the dot-less planning-result.json archive basename', () => {
    const home = tempDir('backfill-executed-model-barebase-');
    const worktreePath = join(home, 'deleted-worktree');
    const projectsDir = join(home, '.claude', 'projects', encodeProjectDir(worktreePath));
    mkdirSync(projectsDir, { recursive: true });
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    cleanupFns.push(() => { process.env.HOME = oldHome; });
    writeFileSync(join(projectsDir, 'session.jsonl'), `${JSON.stringify(claudeTurn(worktreePath))}\n`, 'utf8');
    const artifactDir = tempDir('backfill-executed-model-barebase-dir-');
    writeJson(join(artifactDir, 'terminal-record.json'), {
      worktree: worktreePath,
      branch: 'task/HOK-3017',
    });
    // Dot-less basename (archive variant).
    writeJson(join(artifactDir, 'coding-result.json'), stageResult());
    appendOwnershipRow(artifactDir, {
      sessionRef: 'session',
      harness: 'claude-code',
      kind: 'coding',
      model: 'claude-haiku-4-5',
    });

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });
    assert.equal(results.find((r) => r.stage === 'coding')?.action, 're-derived');
    const written = readJson(join(artifactDir, 'coding-result.json'));
    assert.equal(written.executedModel, 'claude-haiku-4-5');
  });
});
