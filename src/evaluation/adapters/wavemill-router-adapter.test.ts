import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runPatchSelectionEval, runWavemillRouterEval } from './wavemill-router-adapter.ts';

const fixtureRoot = resolve('tests/fixtures/wavemill-router-eval');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wavemill-router-eval-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeFixtureEvals(targetDir: string, extraLines: string[] = []): string {
  mkdirSync(targetDir, { recursive: true });
  const base = readFileSync(join(fixtureRoot, 'evals', 'evals.jsonl'), 'utf-8').trimEnd();
  const content = [base, ...extraLines].filter(Boolean).join('\n') + '\n';
  writeFileSync(join(targetDir, 'evals.jsonl'), content, 'utf-8');
  return targetDir;
}

test('replay_exact_match joins route artifacts and eval records', async () => {
  const tmp = makeTempDir();
  try {
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'));
    const result = await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'replay_exact_match',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      persist: false,
    });

    assert.equal(result.score.workflow_success_rate_under_budget, 0.5);
    assert.equal(result.score.wavemill_router_diagnostics.total_records, 4);
    assert.equal(result.score.wavemill_router_diagnostics.scoreable_records, 2);
    assert.equal(result.score.wavemill_router_diagnostics.invalid_route_records, 1);
  } finally {
    cleanup(tmp);
  }
});

test('missing eval or artifact lowers scoreable coverage', async () => {
  const tmp = makeTempDir();
  try {
    const extraEval = JSON.stringify({
      id: 'eval-only-1',
      schemaVersion: '1.15.0',
      originalPrompt: 'eval only',
      modelId: 'gpt-5.4',
      modelVersion: 'gpt-5.4',
      score: 1,
      scoreBand: 'Full Success',
      timeSeconds: 10,
      timestamp: '2026-05-01T00:00:00.000Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'eval only',
      issueId: 'HOK-9999',
      workflowCost: 1,
      constraints: { maxCostUsd: 2 },
      outcomes: {
        success: true,
        review: { humanReviewRequired: false, rounds: 0, approvals: 0, changeRequests: 0 },
        rework: { agentIterations: 1 },
        delivery: { prCreated: true, merged: false },
      },
    });
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'), [extraEval]);
    const result = await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'replay_exact_match',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      persist: false,
    });

    assert.equal(result.score.wavemill_router_diagnostics.total_records, 5);
    assert.equal(result.score.wavemill_router_diagnostics.scoreable_coverage, 0.4);
  } finally {
    cleanup(tmp);
  }
});

test('router benchmark excludes held eval evidence before scoring rows are built', async () => {
  const tmp = makeTempDir();
  try {
    const heldEval = JSON.stringify({
      id: 'held-eval-only',
      schemaVersion: '1.43.0',
      originalPrompt: 'held eval only',
      modelId: 'ox-alpha',
      modelVersion: 'ox-alpha',
      score: 1,
      scoreBand: 'Full Success',
      timeSeconds: 10,
      timestamp: '2026-05-01T00:00:00.000Z',
      interventionRequired: false,
      interventionCount: 0,
      interventionDetails: [],
      rationale: 'held eval only',
      issueId: 'HOK-HELD',
      workflowCost: 1,
      constraints: { maxCostUsd: 2 },
      modelIdentityAttribution: {
        observedAt: '2026-08-01T00:00:00.000Z',
        roles: {},
        provisionalRoles: ['coder'],
        candidateOnlyProvisional: [],
      },
    });
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'), [heldEval]);
    const result = await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'replay_exact_match',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      persist: false,
    });

    assert.equal(result.score.wavemill_router_diagnostics.total_records, 4);
    assert.equal(result.excludedEvidence.count, 1);
    assert.deepEqual(result.excludedEvidence.reasonCounts, { provisional_model_identity: 1 });
    assert.equal(result.records.some((record) => record.evalRecordId === 'held-eval-only'), false);
  } finally {
    cleanup(tmp);
  }
});

test('malformed JSON is loaded leniently and classified as invalid', async () => {
  const tmp = makeTempDir();
  try {
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'));
    const result = await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'replay_exact_match',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      persist: false,
    });

    const invalid = result.records.find((record) => record.routePath?.endsWith('routing-complete.json'));
    assert.ok(invalid);
    assert.equal(result.score.wavemill_router_diagnostics.invalid_route_rate, 0.25);
  } finally {
    cleanup(tmp);
  }
});

test('challenge_prospective reroutes with injected modelsAvailable', async () => {
  const tmp = makeTempDir();
  try {
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'));
    const result = await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'challenge_prospective',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      modelsAvailable: ['claude-haiku-4-5-20251001'],
      persist: false,
    });

    const rerouted = result.records.find((record) => record.issueId === 'HOK-2001');
    assert.equal(
      rerouted?.routeDecision?.coder,
      'claude-haiku-4-5-20251001',
    );
    assert.equal(
      result.score.wavemill_router_scoring.measurement_policy,
      'challenge_prospective',
    );
  } finally {
    cleanup(tmp);
  }
});

test('patch-selection eval scores provided selections instead of ground truth', async () => {
  const tmp = makeTempDir();
  try {
    const manifestPath = join(tmp, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: '1.0',
      instances: [
        {
          id: 'patch-select-1',
          taskTitle: 'Pick the complete fix',
          taskDescription: 'Choose the candidate that preserves null safety.',
          candidates: [
            {
              id: 'good',
              patch: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-return item.value\n+return item?.value',
              patchSizeBytes: 85,
              label: 'known-good',
            },
            {
              id: 'bad',
              patch: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-return item.value\n+return item.value',
              patchSizeBytes: 84,
              label: 'known-bad',
            },
          ],
          knownGoodCandidateId: 'good',
          knownBadCandidateIds: ['bad'],
          source: {
            curationRationale: 'merged_winner',
            sanitized: true,
          },
          heldOut: false,
          curatedAt: 1726353600,
        },
      ],
      split: {
        heldOutIds: [],
        strategy: 'test',
      },
      createdAt: 1726353600,
      updatedAt: 1726353600,
    }, null, 2), 'utf-8');

    const missing = await runPatchSelectionEval({
      repoDir: process.cwd(),
      manifestPath,
      split: 'all',
    });
    assert.equal(missing.score.patch_selection_accuracy, 0);
    assert.equal(missing.score.wavemill_router_diagnostics.missing_selection_count, 1);

    const wrong = await runPatchSelectionEval({
      repoDir: process.cwd(),
      manifestPath,
      split: 'all',
      selections: { 'patch-select-1': 'bad' },
    });
    assert.equal(wrong.score.patch_selection_accuracy, 0);
    assert.equal(wrong.score.wavemill_router_diagnostics.known_bad_selected_count, 1);

    const correct = await runPatchSelectionEval({
      repoDir: process.cwd(),
      manifestPath,
      split: 'all',
      selections: { 'patch-select-1': 'good' },
    });
    assert.equal(correct.score.patch_selection_accuracy, 1);
  } finally {
    cleanup(tmp);
  }
});

test('fixture end-to-end run appends an eval record with workflow_success_rate_under_budget', async () => {
  const tmp = makeTempDir();
  try {
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'));
    await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'replay_exact_match',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      persist: true,
    });

    const persisted = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const hem = persisted[persisted.length - 1];

    assert.equal(hem.workflow_success_rate_under_budget, 0.5);
    assert.equal(hem.timeSeconds, null);
    assert.ok(hem.wavemill_router_diagnostics);
  } finally {
    cleanup(tmp);
  }
});

test('single-model prospective run persists launch-priority attribution', async () => {
  const tmp = makeTempDir();
  try {
    const evalsDir = writeFixtureEvals(join(tmp, 'evals'));
    await runWavemillRouterEval({
      repoDir: process.cwd(),
      policy: 'challenge_prospective',
      evalsDir,
      artifactsDir: join(fixtureRoot, 'artifacts'),
      modelsAvailable: ['glm-5.2'],
      persist: true,
    });

    const persisted = readFileSync(join(evalsDir, 'evals.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const hem = persisted[persisted.length - 1];

    assert.equal(hem.modelId, 'hokusai.scorers.wavemill.success_rate_under_budget:v1');
    assert.equal(hem.attempted_model, 'glm-5.2');
    assert.equal(hem.model_alias, 'glm-5.2');
    assert.equal(hem.routing.planner.resolvedModelId, 'glm-5.2');
    assert.equal(hem.routing.coder.resolvedModelId, 'glm-5.2');
    assert.equal(hem.routing.reviewer.resolvedModelId, 'glm-5.2');
  } finally {
    cleanup(tmp);
  }
});
