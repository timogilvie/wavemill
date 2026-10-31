/**
 * Backfill orchestration over a schema-valid fixture corpus (HOK-3361).
 * protects: corpus coverage of every cell plus unknown/unavailable/disagreement
 * cases, append-only emission, deterministic re-runs, and the git-numstat
 * diff resolver.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  backfillCellLabels,
  loadDeduplicatedCellLabels,
  parseNumstat,
  type CellBackfillDeps,
} from './cell-backfill.ts';
import { CELL_LAYERS, CELL_LENSES, type CellLabelRowV0, type CorrectivePairRowV0 } from './cell-label-contract.ts';
import { classifyCellWithLlm } from './cell-llm-adapter.ts';
import { collectReviewEvidenceFromFeatureDir } from './cell-review-evidence.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cell-backfill-'));
}

function crRow(index: number, overrides: Partial<CorrectivePairRowV0> = {}): CorrectivePairRowV0 {
  return {
    schema_version: 'cr-0.1.0',
    repo: 'owner/repo',
    original_pr: { number: 100 + index, url: `https://github.com/owner/repo/pull/${100 + index}`, head_sha: 'a'.repeat(40) },
    corrective_pr: { number: 200 + index, url: `https://github.com/owner/repo/pull/${200 + index}`, head_sha: 'b'.repeat(40), merged_at: '2026-01-05T00:00:00Z' },
    label: 'reworked',
    changed_paths: [],
    ...overrides,
  };
}

const SUBSTRATE_BY_CELL: Record<string, string[]> = {
  'form/correctness': ['deployment.yaml'],
  'form/security': ['security-notes.txt'],
  'form/history': ['release-history.txt'],
  'form/reversibility': ['rollback-notes.txt'],
  'local_meaning/correctness': ['shared/lib/eval-formatter.ts'],
  'local_meaning/security': ['shared/lib/auth-token.ts'],
  'local_meaning/history': ['tools/szz-blame-helper.ts'],
  'local_meaning/reversibility': ['rollback-notes.ts'],
  'wiring/correctness': ['shared/lib/routes.ts'],
  'wiring/security': ['routes-auth-config.ts'],
  'wiring/history': ['config-szz.ts'],
  'wiring/reversibility': ['package.json'],
  'runtime/correctness': ['shared/lib/wavemill-monitor.sh'],
  'runtime/security': ['monitor-auth-check.sh'],
  'runtime/history': ['scheduler-szz.ts'],
  'runtime/reversibility': ['shared/migrations/007-add-index.sql'],
  'use/correctness': ['docs/ready-stage.md'],
  'use/security': ['docs/auth-guide.md'],
  'use/history': ['docs/szz-notes.md'],
  'use/reversibility': ['docs/rollback-notes.md'],
};

describe('cell backfill', () => {
  it('protects: the fixture corpus reaches every populated cell, unknown, unavailable evidence and disagreement', async () => {
    const dir = tempDir();
    const crRows: CorrectivePairRowV0[] = [];
    let index = 0;
    for (const layer of CELL_LAYERS) {
      for (const lens of CELL_LENSES) {
        const substrate = SUBSTRATE_BY_CELL[`${layer}/${lens}`] ?? [];
        crRows.push(crRow(index++, { changed_paths: substrate.map((path) => ({ path })) }));
      }
    }
    // unknown: no substrate at all
    crRows.push(crRow(index++, { changed_paths: [] }));
    // unavailable review evidence: no feature dir registered for this original PR
    crRows.push(crRow(index++, { changed_paths: [{ path: 'shared/lib/routes.ts' }] }));
    // disagreement: structural wiring/correctness vs LLM runtime/security
    crRows.push(crRow(index++, { changed_paths: [{ path: 'shared/lib/routes.ts' }] }));
    // non-reworked rows are skipped, never labelled
    crRows.push(crRow(index++, { label: 'not_reworked' }));

    const crPath = join(dir, 'cr-labels.jsonl');
    writeFileSync(crPath, crRows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const featureDirs = new Map<string, string>();
    const withEvidence = crRows[0] as CorrectivePairRowV0;
    const evidenceDir = join(dir, 'feature-a');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, '.review-result.json'), JSON.stringify({
      stage: 'review',
      status: 'completed',
      executedModel: 'claude-haiku-4-5-20251001',
      executionEvidence: { status: 'direct', source: 'provider-response' },
      headSha: 'a'.repeat(40),
      recordedAt: '2026-01-01T00:00:00Z',
    }));
    featureDirs.set(withEvidence.original_pr.url, evidenceDir);
    // Historical artifacts exist for this original PR but carry no stage rows.
    const unavailableRow = crRows[21] as CorrectivePairRowV0;
    const emptyDir = join(dir, 'feature-b');
    mkdirSync(emptyDir, { recursive: true });
    featureDirs.set(unavailableRow.original_pr.url, emptyDir);
    const deps: CellBackfillDeps = {
      loadCorrectiveRows: () => crRows,
      resolveChangedPaths: async (row) => row.changed_paths ?? [],
      collectReviewEvidence: collectReviewEvidenceFromFeatureDir,
    };

    const outPath = join(dir, 'cell-labels.jsonl');
    const result = await backfillCellLabels({ crLabelsPath: crPath, outPath, computedAt: '2026-02-01T00:00:00Z', deps, featureDirsByOriginalPrUrl: featureDirs });

    assert.equal(result.rows.length, crRows.length - 1);
    assert.ok(result.skipped.some((skip) => skip.reason === 'not_reworked'));
    const chosen = result.rows.map((row) => row.chosen);
    const decidedCells = chosen.filter((cell) => cell.kind === 'cell');
    // 20 fixture rows reach their cell; the unavailable-evidence and
    // disagreement rows also decide (routes.ts substrate).
    assert.equal(decidedCells.length, CELL_LAYERS.length * CELL_LENSES.length + 2);
    const covered = new Set(decidedCells.map((cell) => cell.kind === 'cell' ? `${cell.layer}/${cell.lens}` : ''));
    for (const layer of CELL_LAYERS) {
      for (const lens of CELL_LENSES) {
        assert.ok(covered.has(`${layer}/${lens}`), `missing cell ${layer}/${lens}`);
      }
    }
    const unknown = chosen.filter((cell) => cell.kind === 'unknown');
    assert.equal(unknown.length, 1);
    assert.deepEqual(unknown[0]?.kind === 'unknown' ? unknown[0].reason_codes : [], ['no_substrate']);
    const withEvidenceRow = result.rows[0] as CellLabelRowV0;
    assert.equal(withEvidenceRow.review_evidence?.coverage, 'available');
    assert.equal(withEvidenceRow.review_evidence?.reviewer_runs[0]?.evidence_backed, true);
    const unavailableEvidenceRow = result.rows[21] as CellLabelRowV0;
    assert.equal(unavailableEvidenceRow.review_evidence?.coverage, 'unavailable');
    assert.deepEqual(unavailableEvidenceRow.review_evidence?.reason_codes, ['no_stage_artifact']);
    // Rows with no feature dir carry no review evidence at all (orthogonal).
    const noEvidenceRow = result.rows[22] as CellLabelRowV0;
    assert.equal(noEvidenceRow.review_evidence, undefined);
    const disagreementRow = result.rows[result.rows.length - 2] as CellLabelRowV0;
    assert.equal(disagreementRow.agreement, 'not_comparable');

    const stream = loadDeduplicatedCellLabels(outPath);
    assert.equal(stream.length, result.rows.length);
    assert.equal(readFileSync(outPath, 'utf-8').trim().split('\n').length, result.rows.length);
  });

  it('protects: a disagreeing LLM is flagged but never overrides the structural decision', async () => {
    const dir = tempDir();
    const crRows = [crRow(0, { changed_paths: [{ path: 'shared/lib/routes.ts' }] })];
    const deps: CellBackfillDeps = {
      loadCorrectiveRows: () => crRows,
      resolveChangedPaths: async (row) => row.changed_paths ?? [],
      resolveDiffText: async () => 'diff --git a/shared/lib/routes.ts b/shared/lib/routes.ts',
      llmDeps: { classify: async () => '{"layer":"runtime","lens":"security"}', model: 'test-model' },
    };
    const result = await backfillCellLabels({
      crLabelsPath: join(dir, 'cr.jsonl'),
      useLlm: true,
      computedAt: '2026-02-01T00:00:00Z',
      deps,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.agreement, 'disagree');
    assert.equal(result.rows[0]?.llm.model, 'test-model');
    const chosen = result.rows[0]?.chosen;
    assert.deepEqual(chosen, { kind: 'cell', layer: 'wiring', lens: 'correctness' });
  });

  it('protects: numstat parsing feeds the substrate resolver', () => {
    const entries = parseNumstat('12\t3\tshared/lib/routes.ts\n-\t-\tbinary.bin\n');
    assert.deepEqual(entries, [
      { path: 'shared/lib/routes.ts', additions: 12, deletions: 3 },
      { path: 'binary.bin', additions: 0, deletions: 0 },
    ]);
  });

  it('protects: disabled LLM channel is explicit, not fabricated', async () => {
    const dir = tempDir();
    const crRows = [crRow(0, { changed_paths: [{ path: 'shared/lib/routes.ts' }] })];
    const deps: CellBackfillDeps = {
      loadCorrectiveRows: () => crRows,
      resolveChangedPaths: async (row) => row.changed_paths ?? [],
    };
    const result = await backfillCellLabels({ crLabelsPath: join(dir, 'cr.jsonl'), computedAt: '2026-02-01T00:00:00Z', deps });
    assert.equal(result.rows[0]?.llm.decided, false);
    assert.deepEqual(result.rows[0]?.llm.reason_codes, ['llm_disabled']);
  });

  it('protects: the bounded LLM adapter stays within its attempt budget during backfill', async () => {
    const outcome = await classifyCellWithLlm({ diff: 'x', deps: { classify: async () => 'nope' }, maxAttempts: 1 });
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.reason_codes, ['llm_malformed_response']);
  });
});