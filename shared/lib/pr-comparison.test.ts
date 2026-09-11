import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  ARBITER_JUDGE_PROMPT_TEMPLATE_PATH,
  buildDiffIdentity,
  buildChallengeCommentBody,
  buildCappedComparisonPrompt,
  buildComparisonPrompt,
  fetchForkAwareDiffs,
  formatRoutingSummary,
  mapBlindVerdictToSides,
  parseUnifiedDiffLineRanges,
  prNumberFromValue,
  resolvePrDiffIdentity,
  resolvePresentationOrder,
  retainLoserPatch,
  runBlindJudge,
  validateComparisonJson,
  verifyForkCommit,
} from './pr-comparison.ts';
import { loadPromptTemplate } from './prompt-utils.ts';
import { hashString } from './prompt-hash.ts';

function criterionRationales(prefix = 'because') {
  return {
    completeness: { rationale: `${prefix} completeness differs` },
    correctness: { rationale: `${prefix} correctness differs` },
    code_quality: { rationale: `${prefix} code_quality differs` },
    intervention_impact: { rationale: `${prefix} intervention_impact differs` },
    autonomy: { rationale: `${prefix} autonomy differs` },
  };
}

function blindVerdictJson(winner: 'A' | 'B') {
  return JSON.stringify({
    winner,
    rationale: 'Candidate wins',
    dimensions: {
      completeness: { A: 8, B: 7 },
      correctness: { A: 8, B: 7 },
      code_quality: { A: 8, B: 7 },
      intervention_impact: { A: 8, B: 7 },
      autonomy: { A: 8, B: 7 },
    },
    criterionRationales: criterionRationales(),
  });
}

test('prNumberFromValue extracts the PR number from URLs', () => {
  assert.equal(prNumberFromValue('https://github.com/acme/repo/pull/123'), '123');
  assert.equal(prNumberFromValue('456'), '456');
});

test('parseUnifiedDiffLineRanges extracts added-side hunks across files', () => {
  const ranges = parseUnifiedDiffLineRanges(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@
+added
@@ -20 +22 @@
+single
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
diff --git a/src/renamed.ts b/src/renamed.ts
--- a/src/old.ts
+++ b/src/renamed.ts
@@ -0,0 +5,2 @@
+new
diff --git a/src/empty.ts b/src/empty.ts
--- a/src/empty.ts
+++ b/src/empty.ts
@@ -3 +3,0 @@
-only deletion`);

  assert.deepEqual(ranges, [
    { file: 'src/a.ts', start: 10, end: 12 },
    { file: 'src/a.ts', start: 22, end: 22 },
    { file: 'src/renamed.ts', start: 5, end: 6 },
  ]);
});

test('buildDiffIdentity keeps file-level identity when no hunks parse', () => {
  const identity = buildDiffIdentity({
    metadata: {
      url: 'https://github.com/acme/repo/pull/12',
      headRefName: 'feature',
      baseRefName: 'main',
      head_sha: 'head-sha',
    },
    merge_sha: 'base-sha',
    nameOnlyDiff: 'bin/image.png\nsrc/no-new-lines.ts\n',
    unifiedDiff: '',
  });

  assert.deepEqual(identity, {
    head_sha: 'head-sha',
    merge_sha: 'base-sha',
    files_touched: ['bin/image.png', 'src/no-new-lines.ts'],
    line_ranges: [],
  });
});

test('resolvePrDiffIdentity resolves metadata and derives identity from local git', () => {
  const commands: string[][] = [];
  const identity = resolvePrDiffIdentity({
    pr: 'https://github.com/acme/repo/pull/12',
    repoDir: '/repo',
    forkCommit: null,
    deps: {
      runGh(args) {
        commands.push(['gh', ...args]);
        return JSON.stringify({
          url: 'https://github.com/acme/repo/pull/12',
          headRefName: 'feature',
          baseRefName: 'main',
          headRefOid: 'head-sha',
        });
      },
      runGit(args) {
        commands.push(['git', ...args]);
        if (args[0] === 'merge-base') return 'merge-sha';
        if (args[0] === 'diff' && args[1] === '--name-only') return 'src/a.ts\nsrc/b.ts\n';
        if (args[0] === 'diff' && args[1] === '--unified=0') {
          return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
+added`;
        }
        return '';
      },
    },
  });

  assert.deepEqual(identity, {
    head_sha: 'head-sha',
    merge_sha: 'merge-sha',
    files_touched: ['src/a.ts', 'src/b.ts'],
    line_ranges: [{ file: 'src/a.ts', start: 1, end: 2 }],
  });
  assert.deepEqual(commands[0], [
    'gh',
    'pr',
    'view',
    '12',
    '--json',
    'headRefOid,headRefName,baseRefName,url',
  ]);
  assert.ok(commands.some((command) => command.join(' ') === 'git merge-base refs/remotes/origin/main head-sha'));
});

test('resolvePrDiffIdentity uses forkCommit as diff base when present', () => {
  const gitCommands: string[][] = [];
  const identity = resolvePrDiffIdentity({
    pr: '12',
    repoDir: '/repo',
    forkCommit: 'fork-sha',
    deps: {
      runGh() {
        return JSON.stringify({
          url: 'https://github.com/acme/repo/pull/12',
          headRefName: 'feature',
          baseRefName: 'main',
          headRefOid: 'head-sha',
        });
      },
      runGit(args) {
        gitCommands.push(args);
        if (args[0] === 'diff' && args[1] === '--name-only') return 'src/a.ts';
        if (args[0] === 'diff' && args[1] === '--unified=0') return '';
        return '';
      },
    },
  });

  assert.equal(identity.merge_sha, 'fork-sha');
  assert.equal(gitCommands.some((args) => args[0] === 'merge-base'), false);
});

test('retainLoserPatch writes deterministic local artifact under the byte cap', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'loser-patch-test-'));
  try {
    const result = retainLoserPatch({
      challengePairId: 'pair-1',
      evalsDir: tmp,
      repoDir: '/repo',
      loserIdentity: {
        head_sha: 'head-sha',
        merge_sha: 'merge-sha',
        files_touched: ['src/a.ts'],
        line_ranges: [],
      },
      deps: {
        readPatch(args) {
          assert.deepEqual(args, ['diff', 'merge-sha', 'head-sha']);
          return Buffer.from('patch body\n');
        },
      },
    });

    assert.equal(result.written, true);
    assert.equal(result.bytes, 'patch body\n'.length);
    assert.equal(result.path, join(tmp, 'artifacts', 'pair-1', 'loser.patch'));
    assert.equal(readFileSync(result.path, 'utf-8'), 'patch body\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('retainLoserPatch skips artifacts over the retention cap', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'loser-patch-test-'));
  try {
    const result = retainLoserPatch({
      challengePairId: 'pair-1',
      evalsDir: tmp,
      repoDir: '/repo',
      maxBytes: 4,
      loserIdentity: {
        head_sha: 'head-sha',
        merge_sha: 'merge-sha',
        files_touched: ['src/a.ts'],
        line_ranges: [],
      },
      deps: {
        readPatch() {
          return 'too_large';
        },
      },
    });

    assert.equal(result.written, false);
    assert.equal(result.skippedReason, 'too_large');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildComparisonPrompt includes workflow context when routing metadata differs', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
    primaryRouting: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
    challengerRouting: {
      planner: 'planner-b',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
  });

  assert.match(prompt, /Workflow Context/);
  assert.match(prompt, /Variables that differed: planner/);
  assert.match(prompt, /intervention_impact/);
  assert.match(prompt, /criterionRationales/);
  assert.match(prompt, /"completeness": \{ "rationale"/);
  assert.match(prompt, /Candidate A side:/);
  assert.match(prompt, /Candidate B side:/);
  assert.doesNotMatch(prompt, /scopeDiscipline/);
  assert.doesNotMatch(prompt, /Primary/);
  assert.doesNotMatch(prompt, /Challenger/);
});

test('buildComparisonPrompt includes direct stage evidence for planner challenges', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
    challengeType: 'planner-only',
    primaryStageEval: {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured.',
      evidence: [
        { label: 'plan_text', summary: 'Plan chooses a staged auth migration.', source: 'plan.md' },
      ],
    },
    challengerStageEval: {
      stage: 'plan',
      provenance: 'direct',
      summary: 'Direct planning evidence captured.',
      evidence: [
        { label: 'plan_text', summary: 'Plan chooses a single-pass auth migration.', source: 'plan.md' },
      ],
    },
  });

  assert.match(prompt, /Direct Stage Evidence/);
  assert.match(prompt, /Candidate A plan evidence \(direct\)/);
  assert.match(prompt, /Candidate B plan evidence \(direct\)/);
  assert.match(prompt, /plan_text: Plan chooses a staged auth migration/);
  assert.doesNotMatch(prompt, /Primary/);
  assert.doesNotMatch(prompt, /Challenger/);
});

test('buildComparisonPrompt omits direct stage evidence when fallback inference is required', () => {
  const prompt = buildComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff',
    challengerDiff: 'beta diff',
    presentationOrder: 'primary-first',
    challengeType: 'reviewer-only',
    primaryStageEval: {
      stage: 'review',
      provenance: 'direct',
      summary: 'Direct review evidence captured.',
      evidence: [
        { label: 'self_review_summary', summary: 'Raised one blocker.', source: 'review-log' },
      ],
    },
    challengerStageEval: {
      stage: 'review',
      provenance: 'inferred',
      summary: 'Fallback to inferred review evidence.',
      fallbackReason: 'Missing self-review summary',
      evidence: [
        { label: 'inferred_review_score', summary: 'score=0.75', source: 'metadata.stageScores.review' },
      ],
    },
  });

  assert.doesNotMatch(prompt, /Direct Stage Evidence/);
});

test('buildCappedComparisonPrompt truncates oversized diff bodies', () => {
  const result = buildCappedComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff: 'p'.repeat(4000),
    challengerDiff: 'c'.repeat(4000),
    presentationOrder: 'challenger-first',
  }, 3000);

  assert.equal(result.truncated, true);
  assert.ok(result.finalBytes <= 3000);
  assert.match(result.prompt, /TRUNCATED candidate A diff/);
  assert.match(result.prompt, /TRUNCATED candidate B diff/);
  assert.doesNotMatch(result.prompt, /TRUNCATED primary diff/);
  assert.doesNotMatch(result.prompt, /TRUNCATED challenger diff/);
});

test('rendered judge prompt hash changes when the registered template changes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'arbiter-judge-template-test-'));
  try {
    const templatePath = join(tmp, 'arbiter-judge.md');
    const registryDir = join(tmp, 'evals');
    const baseTemplate = readFileSync(ARBITER_JUDGE_PROMPT_TEMPLATE_PATH, 'utf-8');
    writeFileSync(templatePath, baseTemplate, 'utf-8');

    const firstTemplate = await loadPromptTemplate(templatePath, { dir: registryDir });
    const firstPrompt = buildComparisonPrompt({
      issuePrompt: 'Issue context',
      primaryDiff: 'alpha diff',
      challengerDiff: 'beta diff',
      presentationOrder: 'primary-first',
      promptTemplate: firstTemplate,
    });
    const firstHash = hashString(firstPrompt);

    writeFileSync(templatePath, `${baseTemplate}\n\nAdditional judging instruction.\n`, 'utf-8');
    const secondTemplate = await loadPromptTemplate(templatePath, { dir: registryDir });
    const secondPrompt = buildComparisonPrompt({
      issuePrompt: 'Issue context',
      primaryDiff: 'alpha diff',
      challengerDiff: 'beta diff',
      presentationOrder: 'primary-first',
      promptTemplate: secondTemplate,
    });
    const secondHash = hashString(secondPrompt);

    assert.notEqual(firstHash, secondHash);
    const registry = readFileSync(join(registryDir, 'prompt-registry.jsonl'), 'utf-8');
    assert.match(registry, /arbiter-judge/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateComparisonJson trims fields and rejects invalid score payloads', () => {
  const valid = validateComparisonJson({
    winner: 'A',
    rationale: ' better result ',
    workflowInsight: ' routing mattered ',
    dimensions: {
      completeness: { A: 8, B: 7 },
      correctness: { A: 8, B: 6 },
      code_quality: { A: 7, B: 6 },
      intervention_impact: { A: 9, B: 7 },
      autonomy: { A: 8, B: 7 },
    },
    criterionRationales: criterionRationales(' judge says '),
  });

  assert.equal(valid.rationale, 'better result');
  assert.equal(valid.workflowInsight, 'routing mattered');
  assert.equal(valid.winner, 'A');
  assert.equal(valid.criterionRationales.completeness.rationale, 'judge says  completeness differs');

  assert.throws(
    () => validateComparisonJson({
      winner: 'B',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 11, B: 6 },
        code_quality: { A: 7, B: 6 },
        intervention_impact: { A: 9, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
      criterionRationales: criterionRationales(),
    }),
    /Expected integers from 1 to 10/
  );
});

test('validateComparisonJson rejects missing, blank, legacy, and unblinded criterion rationales', () => {
  const basePayload = {
    winner: 'A',
    rationale: 'ok',
    dimensions: {
      completeness: { A: 8, B: 7 },
      correctness: { A: 8, B: 7 },
      code_quality: { A: 8, B: 7 },
      intervention_impact: { A: 8, B: 7 },
      autonomy: { A: 8, B: 7 },
    },
  };

  assert.throws(
    () => validateComparisonJson(basePayload),
    /criterionRationales must be an object/
  );

  assert.throws(
    () => validateComparisonJson({
      ...basePayload,
      criterionRationales: {
        ...criterionRationales(),
        autonomy: { rationale: ' ' },
      },
    }),
    /criterionRationales\.autonomy\.rationale must be a non-empty string/
  );

  assert.throws(
    () => validateComparisonJson({
      ...basePayload,
      criterionRationales: {
        ...criterionRationales(),
        scopeDiscipline: { rationale: 'legacy' },
      },
    }),
    /Legacy criterionRationales keys/
  );

  assert.throws(
    () => validateComparisonJson({
      ...basePayload,
      criterionRationales: {
        ...criterionRationales(),
        correctness: { primary: 'primary was better', rationale: 'ok' },
      },
    }),
    /Unblinded or side-level criterionRationales keys/
  );
});

test('validateComparisonJson rejects unblinded and legacy keys', () => {
  assert.throws(
    () => validateComparisonJson({
      winner: 'primary',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
      criterionRationales: criterionRationales(),
    }),
    /Unblinded comparison winner keys/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
      criterionRationales: criterionRationales(),
    }),
    /Invalid dimension payload for completeness/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { A: 8, B: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
        scopeDiscipline: { A: 8, B: 7 },
      },
      criterionRationales: criterionRationales(),
    }),
    /Legacy comparison keys/
  );

  assert.throws(
    () => validateComparisonJson({
      winner: 'A',
      rationale: 'ok',
      dimensions: {
        completeness: { primary: 8, challenger: 7 },
        correctness: { A: 8, B: 7 },
        code_quality: { A: 8, B: 7 },
        intervention_impact: { A: 8, B: 7 },
        autonomy: { A: 8, B: 7 },
      },
      criterionRationales: criterionRationales(),
    }),
    /Unblinded comparison dimension keys/
  );
});

test('formatRoutingSummary includes challenge type when present', () => {
  const summary = formatRoutingSummary(
    {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    {
      planner: 'planner-b',
      coder: 'coder-b',
      reviewer: 'reviewer-b',
      planDepth: 'medium',
      codeDepth: 'medium',
      reviewMode: 'lite',
    },
    'multi-variable'
  );

  assert.match(summary, /Primary intended planner-a/);
  assert.match(summary, /Challenge type: multi-variable/);
});

test('formatRoutingSummary separates intended routing from executed provenance and validation', () => {
  const summary = formatRoutingSummary(
    {
      planner: 'claude-opus-4-7',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    {
      planner: 'claude-sonnet-5',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'high',
      reviewMode: 'full',
    },
    'planner-only',
    {
      planning: {
        stage: 'planning',
        role: 'planner',
        model: 'kimi-k2.7-code',
        rawModel: 'moonshotai/kimi-k2.7-code',
        agent: 'native-openrouter',
        status: 'completed',
        source: '.planning-result.json',
        artifactPath: '/tmp/primary/.planning-result.json',
        consultedArtifactPaths: ['/tmp/primary/.planning-result.json'],
      },
      coding: {
        stage: 'coding',
        role: 'coder',
        model: 'coder-a',
        agent: 'claude',
        status: 'completed',
        source: '.coding-result.json',
        artifactPath: '/tmp/primary/.coding-result.json',
        consultedArtifactPaths: ['/tmp/primary/.coding-result.json'],
      },
      review: {
        stage: 'review',
        role: 'reviewer',
        model: 'reviewer-a',
        agent: 'claude',
        status: 'completed',
        source: '.review-result.json',
        artifactPath: '/tmp/primary/.review-result.json',
        consultedArtifactPaths: ['/tmp/primary/.review-result.json'],
      },
    },
    {
      planning: {
        stage: 'planning',
        role: 'planner',
        model: 'claude-sonnet-5',
        agent: 'claude',
        status: 'completed',
        source: '.planning-result.json',
        artifactPath: '/tmp/challenger/.planning-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.planning-result.json'],
      },
      coding: {
        stage: 'coding',
        role: 'coder',
        model: 'coder-a',
        agent: 'claude',
        status: 'completed',
        source: '.coding-result.json',
        artifactPath: '/tmp/challenger/.coding-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.coding-result.json'],
      },
      review: {
        stage: 'review',
        role: 'reviewer',
        model: 'reviewer-a',
        agent: 'claude',
        status: 'completed',
        source: '.review-result.json',
        artifactPath: '/tmp/challenger/.review-result.json',
        consultedArtifactPaths: ['/tmp/challenger/.review-result.json'],
      },
    },
    {
      valid: false,
      outcome: 'invalid',
      challengedStage: 'planning',
      challengedRole: 'planner',
      issues: [
        {
          side: 'primary',
          stage: 'planning',
          role: 'planner',
          reason: 'executed-model-mismatch',
          intendedModel: 'claude-opus-4-7',
          executedModel: 'kimi-k2.7-code',
          artifactPath: '/tmp/primary/.planning-result.json',
        },
      ],
    },
  );

  assert.match(summary, /Primary intended claude-opus-4-7/);
  assert.match(summary, /Executed primary: planner native-openrouter\/kimi-k2\.7-code/);
  assert.match(summary, /Provenance validation: invalid/);
  assert.match(summary, /executed-model-mismatch intended=claude-opus-4-7 executed=kimi-k2\.7-code/);
});

test('buildComparisonPrompt blinds labels and eval scores in both presentation orders', () => {
  for (const presentationOrder of ['primary-first', 'challenger-first'] as const) {
    const prompt = buildComparisonPrompt({
      issuePrompt: 'Issue context',
      primaryDiff: 'alpha diff body',
      challengerDiff: 'beta diff body',
      presentationOrder,
      primaryRouting: {
        planner: 'planner-a',
        coder: 'coder-a',
        reviewer: 'reviewer-a',
        planDepth: 'deep',
        codeDepth: 'medium',
        reviewMode: 'full',
      },
      challengerRouting: {
        planner: 'planner-b',
        coder: 'coder-b',
        reviewer: 'reviewer-b',
        planDepth: 'medium',
        codeDepth: 'low',
        reviewMode: 'lite',
      },
    });

    assert.match(prompt, /Candidate A/);
    assert.match(prompt, /Candidate B/);
    assert.match(prompt, /"winner": "A" \| "B"/);
    assert.doesNotMatch(prompt, /Primary/);
    assert.doesNotMatch(prompt, /Challenger/);
    assert.doesNotMatch(prompt, /0\.7|0\.8|0\.60|0\.75/);
    assert.doesNotMatch(prompt, /eval score|Per-stage scores|review-stage eval/i);
  }
});

test('buildComparisonPrompt places routing, evidence, and diffs according to presentation order', () => {
  const baseInput = {
    issuePrompt: 'Issue context',
    primaryDiff: 'alpha diff body',
    challengerDiff: 'beta diff body',
    primaryRouting: {
      planner: 'planner-a',
      coder: 'coder-a',
      reviewer: 'reviewer-a',
      planDepth: 'deep',
      codeDepth: 'medium',
      reviewMode: 'full',
    },
    challengerRouting: {
      planner: 'planner-b',
      coder: 'coder-b',
      reviewer: 'reviewer-b',
      planDepth: 'medium',
      codeDepth: 'low',
      reviewMode: 'lite',
    },
    challengeType: 'planner-only',
    primaryStageEval: {
      stage: 'plan' as const,
      provenance: 'direct' as const,
      summary: 'Alpha stage evidence.',
      evidence: [{ label: 'plan_text', summary: 'Alpha plan summary.', source: 'alpha-plan' }],
    },
    challengerStageEval: {
      stage: 'plan' as const,
      provenance: 'direct' as const,
      summary: 'Beta stage evidence.',
      evidence: [{ label: 'plan_text', summary: 'Beta plan summary.', source: 'beta-plan' }],
    },
  };

  const primaryFirst = buildComparisonPrompt({
    ...baseInput,
    presentationOrder: 'primary-first',
  });
  assert.ok(primaryFirst.indexOf('Candidate A side:\n- Planner: planner-a') < primaryFirst.indexOf('Candidate B side:\n- Planner: planner-b'));
  assert.ok(primaryFirst.indexOf('Candidate A plan evidence (direct): Alpha') < primaryFirst.indexOf('Candidate B plan evidence (direct): Beta'));
  assert.ok(primaryFirst.indexOf('Candidate A diff:\nalpha diff body') < primaryFirst.indexOf('Candidate B diff:\nbeta diff body'));

  const challengerFirst = buildComparisonPrompt({
    ...baseInput,
    presentationOrder: 'challenger-first',
  });
  assert.ok(challengerFirst.indexOf('Candidate A side:\n- Planner: planner-b') < challengerFirst.indexOf('Candidate B side:\n- Planner: planner-a'));
  assert.ok(challengerFirst.indexOf('Candidate A plan evidence (direct): Beta') < challengerFirst.indexOf('Candidate B plan evidence (direct): Alpha'));
  assert.ok(challengerFirst.indexOf('Candidate A diff:\nbeta diff body') < challengerFirst.indexOf('Candidate B diff:\nalpha diff body'));
});

test('mapBlindVerdictToSides attributes winners and dimensions under both orders', () => {
  const blindVerdict = {
    winner: 'A' as const,
    rationale: 'Candidate A did better.',
    workflowInsight: 'Routing mattered.',
    dimensions: {
      completeness: { A: 9, B: 6 },
      correctness: { A: 8, B: 5 },
      code_quality: { A: 7, B: 4 },
      intervention_impact: { A: 6, B: 3 },
      autonomy: { A: 5, B: 2 },
    },
    criterionRationales: criterionRationales('A beats B on'),
  };

  const primaryFirst = mapBlindVerdictToSides(blindVerdict, 'primary-first');
  assert.equal(primaryFirst.winner, 'primary');
  assert.deepEqual(primaryFirst.dimensions.completeness, { primary: 9, challenger: 6 });
  assert.deepEqual(primaryFirst.criterionRationales?.correctness, { rationale: 'A beats B on correctness differs' });

  const challengerFirst = mapBlindVerdictToSides(blindVerdict, 'challenger-first');
  assert.equal(challengerFirst.winner, 'challenger');
  assert.deepEqual(challengerFirst.dimensions.completeness, { primary: 6, challenger: 9 });
  assert.deepEqual(challengerFirst.criterionRationales?.correctness, { rationale: 'A beats B on correctness differs' });

  assert.equal(mapBlindVerdictToSides({ ...blindVerdict, winner: 'B' }, 'primary-first').winner, 'challenger');
  assert.equal(mapBlindVerdictToSides({ ...blindVerdict, winner: 'B' }, 'challenger-first').winner, 'primary');
});

test('resolvePresentationOrder supports random, explicit override, and invalid values', () => {
  assert.equal(resolvePresentationOrder(undefined, () => 0.1), 'primary-first');
  assert.equal(resolvePresentationOrder('random', () => 0.9), 'challenger-first');
  assert.equal(resolvePresentationOrder('challenger-first', () => 0.1), 'challenger-first');
  assert.equal(resolvePresentationOrder('primary-first', () => 0.9), 'primary-first');
  assert.throws(() => resolvePresentationOrder('primary'), /Invalid presentation order/);
});

test('runBlindJudge maps blind verdicts, hashes the successful prompt, and passes through cost', async () => {
  const outcome = await runBlindJudge({
    issuePrompt: 'Issue',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    presentationOrder: 'challenger-first',
    promptTemplate: '{{ISSUE_PROMPT}}\n{{CANDIDATE_A_DIFF}}\n{{CANDIDATE_B_DIFF}}\n{{RUBRIC}}\n{{WORKFLOW_CONTEXT}}\n{{STAGE_EVIDENCE_CONTEXT}}',
    model: 'judge-model',
    maxPromptBytes: 100000,
    deps: {
      async callLlm(prompt, options) {
        assert.equal(options?.model, 'judge-model');
        assert.match(prompt, /challenger diff/);
        return {
          text: blindVerdictJson('A'),
          rawOutput: blindVerdictJson('A'),
          provider: 'claude',
          model: 'judge-model',
          costUsd: 1.23,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    },
  });

  assert.equal(outcome.verdict.winner, 'challenger');
  assert.equal(outcome.costUsd, 1.23);
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(outcome.judgePromptHash, hashString(outcome.judgePrompt));
  assert.equal(outcome.retriedStricterJson, false);
});

test('runBlindJudge retries JavaScript-syntax responses once with stricter JSON instructions', async () => {
  const prompts: string[] = [];
  const outcome = await runBlindJudge({
    issuePrompt: 'Issue',
    primaryDiff: 'primary diff',
    challengerDiff: 'challenger diff',
    presentationOrder: 'primary-first',
    promptTemplate: '{{ISSUE_PROMPT}}\n{{CANDIDATE_A_DIFF}}\n{{CANDIDATE_B_DIFF}}\n{{RUBRIC}}\n{{WORKFLOW_CONTEXT}}\n{{STAGE_EVIDENCE_CONTEXT}}',
    model: 'judge-model',
    maxPromptBytes: 100000,
    deps: {
      async callLlm(prompt, options) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          assert.equal(options?.retry, true);
          return {
            text: '{ winner: "A", ...rest }',
            rawOutput: '{ winner: "A", ...rest }',
            provider: 'claude',
            model: 'judge-model',
          };
        }
        assert.equal(options?.retry, false);
        return {
          text: blindVerdictJson('B'),
          rawOutput: blindVerdictJson('B'),
          provider: 'claude',
          model: 'judge-model',
          costUsd: 0.5,
        };
      },
    },
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Return ONLY valid JSON/);
  assert.equal(outcome.verdict.winner, 'challenger');
  assert.equal(outcome.retriedStricterJson, true);
  assert.equal(outcome.judgePromptHash, hashString(prompts[1]));
});

test('existing comparison replay maps to the same stored winner and dimensions when order is fixed', () => {
  const stored = {
    winner: 'primary' as const,
    dimensions: {
      completeness: { primary: 8, challenger: 6 },
      correctness: { primary: 9, challenger: 5 },
      code_quality: { primary: 7, challenger: 6 },
      intervention_impact: { primary: 8, challenger: 4 },
      autonomy: { primary: 9, challenger: 5 },
    },
  };

  const primaryFirstBlind = {
    winner: 'A' as const,
    rationale: 'Candidate A wins.',
    dimensions: {
      completeness: { A: 8, B: 6 },
      correctness: { A: 9, B: 5 },
      code_quality: { A: 7, B: 6 },
      intervention_impact: { A: 8, B: 4 },
      autonomy: { A: 9, B: 5 },
    },
    criterionRationales: criterionRationales(),
  };
  assert.deepEqual(
    {
      winner: mapBlindVerdictToSides(primaryFirstBlind, 'primary-first').winner,
      dimensions: mapBlindVerdictToSides(primaryFirstBlind, 'primary-first').dimensions,
    },
    stored,
  );

  const challengerFirstBlind = {
    winner: 'B' as const,
    rationale: 'Candidate B wins.',
    dimensions: {
      completeness: { A: 6, B: 8 },
      correctness: { A: 5, B: 9 },
      code_quality: { A: 6, B: 7 },
      intervention_impact: { A: 4, B: 8 },
      autonomy: { A: 5, B: 9 },
    },
    criterionRationales: criterionRationales(),
  };
  assert.deepEqual(
    {
      winner: mapBlindVerdictToSides(challengerFirstBlind, 'challenger-first').winner,
      dimensions: mapBlindVerdictToSides(challengerFirstBlind, 'challenger-first').dimensions,
    },
    stored,
  );
});

test('buildChallengeCommentBody points each PR at the opposite PR', () => {
  const primaryComment = buildChallengeCommentBody({
    pairId: 'pair-123',
    winner: 'challenger',
    winnerModel: 'model-b',
    rationale: 'challenger produced the better fix',
    otherPrUrl: 'https://github.com/acme/repo/pull/22',
    routingSummary: 'routing summary',
  });
  const challengerComment = buildChallengeCommentBody({
    pairId: 'pair-123',
    winner: 'challenger',
    winnerModel: 'model-b',
    rationale: 'challenger produced the better fix',
    otherPrUrl: 'https://github.com/acme/repo/pull/11',
    routingSummary: 'routing summary',
  });

  assert.match(primaryComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/22/);
  assert.match(challengerComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/11/);
  assert.doesNotMatch(primaryComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/11/);
  assert.doesNotMatch(challengerComment, /Other PR: https:\/\/github\.com\/acme\/repo\/pull\/22/);
});

test('buildChallengeCommentBody reports invalid comparisons without a winner', () => {
  const body = buildChallengeCommentBody({
    pairId: 'pair-123',
    rationale: 'Challenge comparison invalid: primary planner mismatch.',
    otherPrUrl: 'https://github.com/acme/repo/pull/22',
    routingSummary: 'routing summary',
    provenanceValidation: {
      valid: false,
      outcome: 'invalid',
      issues: [
        {
          side: 'primary',
          stage: 'planning',
          role: 'planner',
          reason: 'executed-model-mismatch',
        },
      ],
    },
  });

  assert.match(body, /Comparison outcome: invalid/);
  assert.doesNotMatch(body, /Recommended winner/);
});

test('verifyForkCommit validates fork commit presence, tree, and ancestry', () => {
  const gitCommands: string[][] = [];
  const result = verifyForkCommit({
    forkCommit: 'fork-sha',
    recordedTree: 'expected-tree',
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    repoDir: '/repo',
    deps: {
      runGit(args) {
        gitCommands.push(args);
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'rev-parse') return 'expected-tree';
        if (args[0] === 'merge-base') return '';
        return '';
      },
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.resolvedTree, 'expected-tree');
  assert.ok(gitCommands.some((cmd) => cmd.join(' ').includes('cat-file -e fork-sha')));
  assert.ok(gitCommands.some((cmd) => cmd.join(' ').includes('rev-parse fork-sha^{tree}')));
  assert.ok(gitCommands.some((cmd) => cmd.join(' ').includes('merge-base --is-ancestor fork-sha primary-sha')));
  assert.ok(gitCommands.some((cmd) => cmd.join(' ').includes('merge-base --is-ancestor fork-sha challenger-sha')));
});

test('verifyForkCommit rejects fork commit when tree does not match recorded value', () => {
  const result = verifyForkCommit({
    forkCommit: 'fork-sha',
    recordedTree: 'expected-tree',
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    repoDir: '/repo',
    deps: {
      runGit(args) {
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'rev-parse') return 'different-tree';
        return '';
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'tree_mismatch');
  assert.match(result.detail!, /expected-tree does not match resolved tree different-tree/);
});

test('verifyForkCommit rejects fork commit when not ancestor of primary', () => {
  const result = verifyForkCommit({
    forkCommit: 'fork-sha',
    recordedTree: undefined,
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    repoDir: '/repo',
    deps: {
      runGit(args) {
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'rev-parse') return 'tree-sha';
        if (args[0] === 'merge-base' && args[3] === 'primary-sha') throw new Error('not ancestor');
        return '';
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'not_ancestor_of_primary');
  assert.match(result.detail!, /not an ancestor of primary/);
});

test('verifyForkCommit rejects fork commit when not ancestor of challenger', () => {
  const result = verifyForkCommit({
    forkCommit: 'fork-sha',
    recordedTree: undefined,
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    repoDir: '/repo',
    deps: {
      runGit(args) {
        if (args[0] === 'cat-file') return '';
        if (args[0] === 'rev-parse') return 'tree-sha';
        if (args[0] === 'merge-base' && args[3] === 'primary-sha') return '';
        if (args[0] === 'merge-base' && args[3] === 'challenger-sha') throw new Error('not ancestor');
        return '';
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'not_ancestor_of_challenger');
  assert.match(result.detail!, /not an ancestor of challenger/);
});

test('verifyForkCommit rejects when fork commit is not available locally', () => {
  const result = verifyForkCommit({
    forkCommit: 'fork-sha',
    recordedTree: undefined,
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    repoDir: '/repo',
    deps: {
      runGit() {
        throw new Error('commit not found');
      },
    },
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'unverified_fork_commit');
  assert.match(result.detail!, /not available locally/);
});

test('fetchForkAwareDiffs computes shared prefix and each arm delta', () => {
  const gitCommands: string[][] = [];
  const diffs = fetchForkAwareDiffs({
    forkCommit: 'fork-sha',
    primaryHeadSha: 'primary-sha',
    challengerHeadSha: 'challenger-sha',
    baseRefName: 'main',
    repoDir: '/repo',
    deps: {
      runGit(args) {
        gitCommands.push(args);
        if (args[0] === 'merge-base') return 'base-sha';
        if (args[0] === 'diff' && args[1] === 'base-sha') return 'shared prefix diff content';
        if (args[0] === 'diff' && args[2] === 'primary-sha') return 'primary delta diff';
        if (args[0] === 'diff' && args[2] === 'challenger-sha') return 'challenger delta diff';
        return '';
      },
    },
  });

  assert.equal(diffs.sharedContext, 'shared prefix diff content');
  assert.equal(diffs.primaryDelta, 'primary delta diff');
  assert.equal(diffs.challengerDelta, 'challenger delta diff');
  assert.ok(gitCommands.some((cmd) => cmd.join(' ') === 'merge-base refs/remotes/origin/main fork-sha'));
});

test('buildCappedComparisonPrompt accounts for sharedContext in byte budgeting', () => {
  const sharedContext = 'x'.repeat(1000);
  const primaryDiff = 'p'.repeat(1500);
  const challengerDiff = 'c'.repeat(1500);

  const result = buildCappedComparisonPrompt({
    issuePrompt: 'Issue context',
    primaryDiff,
    challengerDiff,
    presentationOrder: 'primary-first',
    sharedContext,
  }, 3500);

  // Total would be: ~500 scaffold + 1000 shared + 1500 primary + 1500 challenger = 4500
  // With a 3500 byte budget, both diffs should be truncated to make room for shared context
  assert.equal(result.truncated, true);
  assert.ok(result.finalBytes <= 3500);
  // Shared context should be preserved in the prompt
  assert.match(result.prompt, /Shared Pre-Fork Context/);
  assert.ok(result.prompt.includes(sharedContext));
});
