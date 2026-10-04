import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CANDIDATE_FEATURES_SCHEMA_VERSION,
  extractCandidateFeatures,
  validateCandidateFeatures,
  type CandidateFeaturesV1,
} from './candidate-features.ts';
import { buildWavemillCandidateContract } from './post-completion-hook.ts';

const EXPECTED_CANDIDATE_FEATURE_KEYS = [
  'schema_version',
  'files_touched',
  'lines_added',
  'lines_deleted',
  'loc_touched',
  'dependency_depth',
  'module_hotspot_score',
  'diff_uncertain',
  'type_errors',
  'lint_errors',
  'build_ok',
  'complexity_delta',
  'tests_changed',
  'test_pass_rate',
  'test_runtime_seconds',
  'task_type',
  'language',
  'domain',
  'complexity',
  'repo_size_bucket',
  'files_touched_bucket',
  'description_length_bucket',
  'is_greenfield',
  'is_migration',
  'requires_tests',
  'cross_service',
  'ui_heavy',
  'risk_level',
  'touched_out_of_scope_files',
  'human_intervention_count',
  'review_rounds',
  'change_requests',
  'self_review_iterations',
  'agent_iterations',
].sort();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initFixture(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cf-${prefix}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '.']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

function makeCandidateRepo(): string {
  const dir = initFixture('repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  commitAll(dir, 'initial');
  git(dir, ['checkout', '-q', '-b', 'candidate']);
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 2;\nexport const extra = true;\n');
  writeFileSync(join(dir, 'src', 'app.test.ts'), 'import { value } from "./app";\nvoid value;\n');
  commitAll(dir, 'candidate');
  return dir;
}

function intentKeys(): Array<keyof CandidateFeaturesV1> {
  return [
    'task_type',
    'language',
    'domain',
    'complexity',
    'repo_size_bucket',
    'files_touched_bucket',
    'description_length_bucket',
    'is_greenfield',
    'is_migration',
    'requires_tests',
    'cross_service',
    'ui_heavy',
    'risk_level',
  ];
}

test('standalone extractor emits a valid candidate_features/v1 object', () => {
  const dir = makeCandidateRepo();
  try {
    const features = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 123,
      baseRef: 'main',
      offline: true,
    });

    assert.equal(features.schema_version, CANDIDATE_FEATURES_SCHEMA_VERSION);
    assert.equal(validateCandidateFeatures(features).length, 0);
    assert.deepEqual(Object.keys(features).sort(), EXPECTED_CANDIDATE_FEATURE_KEYS);
    assert.equal(features.files_touched, 2);
    assert.equal(features.lines_added, 4);
    assert.equal(features.lines_deleted, 1);
    assert.equal(features.loc_touched, 5);
    assert.equal(features.tests_changed, true);
    assert.equal(features.type_errors, null);
    assert.equal(features.lint_errors, null);
    assert.equal(features.build_ok, null);
    assert.equal(typeof features.complexity_delta, 'number');
    assert.equal(features.touched_out_of_scope_files, null);

    for (const key of intentKeys()) {
      assert.equal(features[key], null, `${key} should degrade to null without a contract`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task contract enriches Intent through deriveTaskDescriptor plus explicit normalized fields', () => {
  const dir = makeCandidateRepo();
  try {
    const features = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 123,
      baseRef: 'main',
      offline: true,
      contract: {
        taskText: 'Implement a frontend feature for the candidate extractor',
        repositorySignals: {
          fileCount: 42,
          extensionCounts: { ts: 2 },
        },
        intent: {
          domain: 'frontend',
          is_greenfield: false,
          is_migration: false,
          requires_tests: true,
          cross_service: false,
          ui_heavy: true,
          risk_level: 'medium',
        },
        scope: {
          allowedPrefixes: ['src/'],
        },
        provenance: {
          human_intervention_count: 1,
          review_rounds: 2,
          change_requests: 1,
          self_review_iterations: 3,
          agent_iterations: 4,
        },
      },
    });

    assert.equal(features.task_type, 'feature');
    assert.equal(features.language, 'typescript');
    assert.equal(features.repo_size_bucket, 'small');
    assert.equal(features.files_touched_bucket, '2_5');
    assert.equal(features.description_length_bucket, 'short');
    assert.equal(features.domain, 'frontend');
    assert.equal(features.complexity, 5);
    assert.equal(features.requires_tests, true);
    assert.equal(features.ui_heavy, true);
    assert.equal(features.touched_out_of_scope_files, 0);
    assert.equal(features.human_intervention_count, 1);
    assert.equal(features.review_rounds, 2);
    assert.equal(features.change_requests, 1);
    assert.equal(features.self_review_iterations, 3);
    assert.equal(features.agent_iterations, 4);
    assert.equal(validateCandidateFeatures(features).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provenance counts out-of-scope files without affecting other groups', () => {
  const dir = makeCandidateRepo();
  try {
    const features = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 'not-a-pr',
      baseRef: 'main',
      offline: true,
      contract: {
        taskText: 'Update tests',
        repositorySignals: { fileCount: 1, extensionCounts: { ts: 1 } },
        scope: { allowedFiles: ['src/app.test.ts'] },
      },
    });

    assert.equal(features.files_touched, 2);
    assert.equal(features.tests_changed, true);
    assert.equal(features.touched_out_of_scope_files, 1);
    assert.equal(features.test_pass_rate, null);
    assert.equal(features.review_rounds, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validation rejects missing, unknown, and invalid fields without coercion', () => {
  const dir = makeCandidateRepo();
  try {
    const features = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 123,
      baseRef: 'main',
      offline: true,
    });
    const bad = {
      ...features,
      extra: true,
      build_ok: 0,
    };
    delete (bad as unknown as Partial<CandidateFeaturesV1>).files_touched;

    const issues = validateCandidateFeatures(bad);
    assert.ok(issues.some((issue) => issue.field === 'extra' && issue.message === 'unknown field'));
    assert.ok(issues.some((issue) => issue.field === 'build_ok'));
    assert.ok(issues.some((issue) => issue.field === 'files_touched'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare checkout and wavemill-adapter call match on checkout-derived groups', () => {
  // Exercises the real wavemill enrichment path: writes a
  // `features/<slug>/selected-task.json` + `.review-result.json`, invokes the
  // adapter, and passes the resulting contract to the extractor. This is the
  // exact code path `collectPostCompletionOutcomes` uses in-workflow.
  const dir = makeCandidateRepo();
  const featureDir = mkdtempSync(join(tmpdir(), 'cf-feature-'));
  try {
    writeFileSync(
      join(featureDir, 'selected-task.json'),
      JSON.stringify({
        taskId: 'HOK-0000',
        title: 'Implement a backend feature',
        description: 'Deliver the new capability described above.',
        workflowType: 'feature',
      }),
      'utf-8',
    );
    writeFileSync(
      join(featureDir, '.review-result.json'),
      JSON.stringify({ artifacts: { iterations: 2 } }),
      'utf-8',
    );

    const contract = buildWavemillCandidateContract({
      featureDir,
      agentIterations: 1,
      humanInterventionCount: 0,
    });
    assert.ok(contract, 'adapter should produce a contract when artifacts exist');

    const standalone = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 123,
      baseRef: 'main',
      offline: true,
    });
    const adapter = extractCandidateFeatures({
      checkoutDir: dir,
      prNumber: 123,
      baseRef: 'main',
      offline: true,
      contract,
    });

    for (const key of [
      'files_touched',
      'lines_added',
      'lines_deleted',
      'loc_touched',
      'dependency_depth',
      'module_hotspot_score',
      'diff_uncertain',
      'type_errors',
      'lint_errors',
      'build_ok',
      'complexity_delta',
      'tests_changed',
      'test_pass_rate',
      'test_runtime_seconds',
    ] as const) {
      assert.deepEqual(adapter[key], standalone[key], `${key} should match standalone extraction`);
    }

    for (const key of intentKeys()) {
      assert.equal(standalone[key], null, `${key} should be null standalone`);
    }
    // Adapter enriches Intent via deriveTaskDescriptor on the task text, and
    // Provenance via the artifacts on disk + explicit adapter inputs. Language
    // requires repositorySignals the adapter does not compute today, so it
    // remains null until a signals collector is added.
    assert.equal(adapter.task_type, 'feature');
    assert.equal(adapter.self_review_iterations, 2);
    assert.equal(adapter.agent_iterations, 1);
    assert.equal(adapter.human_intervention_count, 0);
    // description_length_bucket is derived from taskText so it should now be
    // populated (whereas it is null in the standalone extraction above).
    assert.notEqual(adapter.description_length_bucket, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(featureDir, { recursive: true, force: true });
  }
});
