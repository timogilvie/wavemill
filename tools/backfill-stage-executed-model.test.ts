import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillStageExecutedModel } from './backfill-stage-executed-model.ts';
import { encodeProjectDir } from '../shared/lib/workflow-cost.ts';

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
  writeJson(join(artifactDir, 'coding-result.json'), stageResult());
  return { artifactDir, worktreePath };
}

describe('backfillStageExecutedModel', () => {
  it('dry-runs artifact-dir updates without writing', () => {
    const { artifactDir } = setupArtifactWithClaudeSession();
    const file = join(artifactDir, 'coding-result.json');
    const before = readFileSync(file, 'utf8');

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir] });

    assert.equal(results.find((result) => result.stage === 'coding')?.action, 're-derived');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('applies session-derived executed model and recomputes eligibility', () => {
    const { artifactDir } = setupArtifactWithClaudeSession();
    const file = join(artifactDir, 'coding-result.json');

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
    const file = join(artifactDir, 'coding-result.json');
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

  it('skips native and incomplete stages', () => {
    const artifactDir = tempDir('backfill-executed-model-skip-');
    writeJson(join(artifactDir, 'terminal-record.json'), {
      worktree: '/worktree',
      branch: 'task/HOK-3017',
    });
    writeJson(join(artifactDir, 'planning-result.json'), stageResult({ stage: 'planning', status: 'running' }));
    writeJson(join(artifactDir, 'coding-result.json'), stageResult({ agent: 'native', model: 'pi-model', intendedModel: 'pi-model' }));

    const results = backfillStageExecutedModel({ artifactDirs: [artifactDir], apply: true });

    assert.equal(results.find((result) => result.stage === 'planning')?.reason, 'stage_not_completed');
    assert.equal(results.find((result) => result.stage === 'coding')?.reason, 'unsupported_agent');
  });
});
