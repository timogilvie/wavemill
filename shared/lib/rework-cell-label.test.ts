import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CELL_LABEL_SCHEMA_VERSION,
  REVIEW_LAYERS,
  REVIEW_LENSES,
  deduplicateReworkCellLabels,
  formatCell,
  parseCell,
  parseReworkCellLabelsJsonl,
  reworkCellNaturalKey,
  validateReworkCellLabel,
  type ReworkCellLabelV1,
} from './rework-cell-label.ts';
import {
  classifyStructuralSignals,
  classifyWithLlm,
  enrichOriginalPrReviewEvidence,
  reconcileClassification,
} from './rework-cell-classifier.ts';

function createSampleRecord(overrides: Partial<ReworkCellLabelV1> = {}): ReworkCellLabelV1 {
  return {
    schema_version: CELL_LABEL_SCHEMA_VERSION,
    source_rework_label: {
      version: 'cr-0.1.0',
      rework_id: 'cr:100:105',
    },
    original_pr: {
      number: 100,
      url: 'https://github.com/hokusai/wavemill/pull/100',
      head_sha: 'a'.repeat(40),
      merge_commit_sha: 'b'.repeat(40),
      title: 'feat: original feature',
    },
    corrective_pr: {
      number: 105,
      url: 'https://github.com/hokusai/wavemill/pull/105',
      head_sha: 'c'.repeat(40),
      merge_commit_sha: 'd'.repeat(40),
      title: 'fix: corrective bugfix',
    },
    chosen: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
    },
    structural: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
      confidence: 'high',
      matched_rules: ['path:wiring:shared/schemas/config.json'],
    },
    llm: {
      layer: 'wiring',
      lens: 'correctness',
      cell: 'wiring:correctness',
      explanation: 'Fixes interface contract between caller and callee.',
    },
    agreement: true,
    disagreement_state: 'agree',
    reason_codes: ['clean_agreement', 'llm_concurrence'],
    review_evidence: {
      reviewers_run: ['claude-3-7-sonnet'],
      challenge_stages: ['review'],
      provenance: 'direct',
      coverage_flags: ['review_artifact_direct'],
    },
    envelope: {
      schema_version: CELL_LABEL_SCHEMA_VERSION,
      labeller_version: '0.1.0',
      rules_version: '0.1.0',
      prompt_version: '0.1.0',
      model: 'claude-3-7-sonnet',
      diff_hash: 'e'.repeat(64),
      computed_at: '2026-10-31T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('rework-cell-label schema & storage', () => {
  // protects: schema drift where valid cell-0.1.0 records fail validation
  it('validates a well-formed cell-0.1.0 row against JSON Schema', () => {
    const record = createSampleRecord();
    const result = validateReworkCellLabel(record);
    assert.equal(result.valid, true, `Validation failed: ${result.errors?.join('; ')}`);
  });

  // protects: missing schema version or invalid version accepted
  it('rejects rows with incorrect schema_version', () => {
    const record = createSampleRecord({
      // @ts-expect-error invalid schema version
      schema_version: '0.2.0',
    });
    const result = validateReworkCellLabel(record);
    assert.equal(result.valid, false);
  });

  // protects: invalid layer or lens enum values accepted
  it('rejects rows with invalid layer or lens values', () => {
    const record = createSampleRecord({
      chosen: {
        // @ts-expect-error invalid layer
        layer: 'invalid_layer',
        lens: 'correctness',
        cell: 'invalid_layer:correctness',
      },
    });
    const result = validateReworkCellLabel(record);
    assert.equal(result.valid, false);
  });

  // protects: cell format helper emitting inconsistent cell identifiers
  it('formats and parses cell strings accurately across product space', () => {
    for (const layer of REVIEW_LAYERS) {
      for (const lens of REVIEW_LENSES) {
        const cell = formatCell(layer, lens);
        assert.equal(cell, `${layer}:${lens}`);
        const parsed = parseCell(cell);
        assert.equal(parsed.layer, layer);
        assert.equal(parsed.lens, lens);
      }
    }
    assert.equal(formatCell('unknown', 'correctness'), 'unknown');
    assert.equal(formatCell('wiring', 'unknown'), 'unknown');
    const parsedUnknown = parseCell('unknown');
    assert.equal(parsedUnknown.layer, 'unknown');
    assert.equal(parsedUnknown.lens, 'unknown');
  });

  // protects: append-only streams dropping newer versions or preserving stale entries on dedup
  it('deduplicates by natural key keeping latest computed_at', () => {
    const base = createSampleRecord();
    const older = {
      ...base,
      chosen: { layer: 'form' as const, lens: 'correctness' as const, cell: 'form:correctness' },
      envelope: { ...base.envelope, computed_at: '2026-10-30T10:00:00.000Z' },
    };
    const newer = {
      ...base,
      chosen: { layer: 'runtime' as const, lens: 'reversibility' as const, cell: 'runtime:reversibility' },
      envelope: { ...base.envelope, computed_at: '2026-10-31T15:00:00.000Z' },
    };

    const deduplicated = deduplicateReworkCellLabels([older, newer]);
    assert.equal(deduplicated.length, 1);
    assert.equal(deduplicated[0].chosen.cell, 'runtime:reversibility');
  });

  // protects: jsonl parser crashing on corrupted or malformed lines
  it('parses valid jsonl and isolates corrupt lines', () => {
    const record = createSampleRecord();
    const jsonl = `${JSON.stringify(record)}\n{ corrupt json\n${JSON.stringify(record)}\n`;
    const { records, errors } = parseReworkCellLabelsJsonl(jsonl);
    assert.equal(records.length, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /JSON parse error/);
  });
});

describe('structural defect classifier', () => {
  // protects: form layer misclassifying formatting changes as functional bugs
  it('classifies formatting and linter config changes as form layer', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: '.prettierrc.json',
          diffText: 'diff --git a/.prettierrc.json b/.prettierrc.json\n-{"semi": false}\n+{"semi": true}',
        },
      ],
    });
    assert.equal(outcome.layer, 'form');
  });

  // protects: local logic changes inside function misclassified as wiring
  it('classifies localized condition and null-checks as local_meaning', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'src/calculator.ts',
          diffText: 'diff --git a/src/calculator.ts b/src/calculator.ts\n-if (a > b) {\n+if (a >= b && c !== null) {',
        },
      ],
    });
    assert.equal(outcome.layer, 'local_meaning');
    assert.equal(outcome.lens, 'correctness');
  });

  // protects: module interfaces and schema changes misclassified as local meaning
  it('classifies schema, router, and exports as wiring layer', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'shared/schemas/task-contract.schema.json',
          diffText: 'diff --git a/schema.json b/schema.json\n+export interface TaskContract {\n+  endpoint: string;\n+}',
        },
      ],
    });
    assert.equal(outcome.layer, 'wiring');
  });

  // protects: async, timeout, and mutex changes misclassified as local meaning
  it('classifies concurrency, timer, and process lifecycle as runtime layer', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'shared/lib/state-mutex.ts',
          diffText: 'diff --git a/mutex.ts b/mutex.ts\n+await mutex.acquire();\n+setTimeout(() => process.exit(1), 5000);',
        },
      ],
    });
    assert.equal(outcome.layer, 'runtime');
  });

  // protects: CLI flags and markdown docs misclassified as code wiring
  it('classifies CLI flags and prompt templates as use layer', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'commands/workflow.md',
          diffText: 'diff --git a/workflow.md b/workflow.md\n+# Workflow Command\n+Pass --verbose for detailed diagnostic logging.',
        },
      ],
    });
    assert.equal(outcome.layer, 'use');
  });

  // protects: security sanitization misclassified as generic correctness
  it('classifies token, secret, and auth sanitization as security lens', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'shared/lib/auth-token.ts',
          diffText: 'diff --git a/auth.ts b/auth.ts\n+const token = sanitize(apiKey);\n+validateAuthorization(token);',
        },
      ],
    });
    assert.equal(outcome.lens, 'security');
  });

  // protects: rollback, teardown, and revert handlers misclassified as generic correctness
  it('classifies rollback and teardown logic as reversibility lens', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'shared/lib/cleanup.ts',
          diffText: 'diff --git a/cleanup.ts b/cleanup.ts\n+finally {\n+  await rollback();\n+  teardown();\n+}',
        },
      ],
    });
    assert.equal(outcome.lens, 'reversibility');
  });

  // protects: regression context missed in history lens
  it('classifies regressions noted in PR context as history lens', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'src/feature.ts',
          diffText: 'diff --git a/src/feature.ts b/src/feature.ts\n+restoreMethod();',
        },
      ],
      prTitle: 'fix: regression introduced after refactor broke feature',
    });
    assert.equal(outcome.lens, 'history');
  });

  // protects: ambiguous conflicting signals guessed rather than mapped to unknown
  it('maps ambiguous conflicting signals to unknown layer', () => {
    const outcome = classifyStructuralSignals({
      files: [
        {
          path: 'shared/schemas/contract.json',
          diffText: 'diff --git a/contract.json b/contract.json\n+export interface Foo {}',
        },
        {
          path: 'commands/doc.md',
          diffText: 'diff --git a/doc.md b/doc.md\n+--help options',
        },
      ],
    });
    assert.equal(outcome.layer, 'unknown');
    assert.equal(outcome.cell, 'unknown');
  });

  // protects: empty or absent substrate producing a guessed label
  it('maps empty diff substrate to unknown with insufficient substrate rule', () => {
    const outcome = classifyStructuralSignals({
      files: [],
      rawDiff: '',
    });
    assert.equal(outcome.layer, 'unknown');
    assert.equal(outcome.lens, 'unknown');
    assert.equal(outcome.confidence, 'none');
    assert.ok(outcome.matched_rules.includes('insufficient_substrate:no_files_changed'));
  });
});

describe('bounded LLM adapter & reconciliation', () => {
  // protects: LLM classification throwing unhandled error when malformed
  it('handles malformed LLM responses gracefully without throwing', async () => {
    const fakeRunner = async () => 'not json at all';
    const originalPr = { number: 1, url: 'http://pr/1', head_sha: 'a'.repeat(40) };
    const correctivePr = { number: 2, url: 'http://pr/2', head_sha: 'b'.repeat(40) };

    const llm = await classifyWithLlm(
      { originalPr, correctivePr, diff: 'some diff' },
      fakeRunner,
    );
    assert.ok(llm);
    assert.equal(llm.layer, 'unknown');
    assert.match(llm.error ?? '', /llm_malformed_response/);
  });

  // protects: LLM network or runner failure halting classification
  it('handles LLM runner network errors gracefully', async () => {
    const fakeRunner = async () => {
      throw new Error('connection reset');
    };
    const originalPr = { number: 1, url: 'http://pr/1', head_sha: 'a'.repeat(40) };
    const correctivePr = { number: 2, url: 'http://pr/2', head_sha: 'b'.repeat(40) };

    const llm = await classifyWithLlm(
      { originalPr, correctivePr, diff: 'some diff' },
      fakeRunner,
    );
    assert.ok(llm);
    assert.equal(llm.layer, 'unknown');
    assert.match(llm.error ?? '', /llm_unavailable/);
  });

  // protects: agreement status reporting false when both classifiers select the same cell
  it('reconciles agreement accurately when structural and LLM match', () => {
    const structural = {
      layer: 'wiring' as const,
      lens: 'correctness' as const,
      cell: 'wiring:correctness',
      confidence: 'high' as const,
      matched_rules: ['dominant:wiring'],
    };
    const llm = {
      layer: 'wiring' as const,
      lens: 'correctness' as const,
      cell: 'wiring:correctness',
      explanation: 'Matches wiring contract.',
    };

    const reconciled = reconcileClassification(structural, llm);
    assert.equal(reconciled.agreement, true);
    assert.equal(reconciled.disagreement_state, 'agree');
    assert.equal(reconciled.chosen.cell, 'wiring:correctness');
    assert.ok(reconciled.reason_codes.includes('clean_agreement'));
  });

  // protects: disagreement status masked or choosing wrong cell on conflict
  it('reconciles disagreement when structural and LLM diverge', () => {
    const structural = {
      layer: 'wiring' as const,
      lens: 'correctness' as const,
      cell: 'wiring:correctness',
      confidence: 'high' as const,
      matched_rules: ['dominant:wiring'],
    };
    const llm = {
      layer: 'runtime' as const,
      lens: 'correctness' as const,
      cell: 'runtime:correctness',
      explanation: 'Looked like runtime.',
    };

    const reconciled = reconcileClassification(structural, llm);
    assert.equal(reconciled.agreement, false);
    assert.equal(reconciled.disagreement_state, 'disagree');
    // High-confidence structural signal takes precedence
    assert.equal(reconciled.chosen.cell, 'wiring:correctness');
    assert.ok(reconciled.reason_codes.includes('llm_disagreement'));
  });

  // protects: structural unknown failing to use valid LLM fallback
  it('uses LLM fallback when structural is unknown and LLM is valid', () => {
    const structural = {
      layer: 'unknown' as const,
      lens: 'unknown' as const,
      cell: 'unknown',
      confidence: 'none' as const,
      matched_rules: ['ambiguous'],
    };
    const llm = {
      layer: 'local_meaning' as const,
      lens: 'correctness' as const,
      cell: 'local_meaning:correctness',
      explanation: 'Clear localized bug.',
    };

    const reconciled = reconcileClassification(structural, llm);
    assert.equal(reconciled.disagreement_state, 'llm_only');
    assert.equal(reconciled.chosen.cell, 'local_meaning:correctness');
    assert.ok(reconciled.reason_codes.includes('llm_fallback_used'));
  });

  // protects: offline mode accidentally invoking LLM or failing to record skip
  it('records offline skip when running in offline mode', () => {
    const structural = {
      layer: 'use' as const,
      lens: 'correctness' as const,
      cell: 'use:correctness',
      confidence: 'medium' as const,
      matched_rules: ['path:use'],
    };

    const reconciled = reconcileClassification(structural, null, { offline: true });
    assert.equal(reconciled.disagreement_state, 'structural_only');
    assert.ok(reconciled.reason_codes.includes('llm_skipped_offline'));
  });
});

describe('historical review evidence enrichment', () => {
  // protects: missing review artifacts being inferred as unreviewed rather than unavailable
  it('emits explicit unavailable provenance when review artifact is missing', () => {
    const evidence = enrichOriginalPrReviewEvidence({
      prNumber: 99999,
      issueId: 'NONEXISTENT-999',
    });
    assert.equal(evidence.provenance, 'unavailable');
    assert.equal(evidence.reviewers_run.length, 0);
    assert.ok(evidence.coverage_flags.includes('missing_review_artifact'));
  });

  // protects: recoverable review artifacts failing to extract executed models
  it('recovers reviewer and challenge stage when artifact exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'review-evidence-'));
    try {
      const featDir = join(tmp, 'features', 'my-feature');
      mkdirSync(featDir, { recursive: true });
      writeFileSync(
        join(featDir, '.review-result.json'),
        JSON.stringify({
          executedModel: 'qwen-3-coder',
          challenge: { stage: 'review' },
        }),
      );

      const evidence = enrichOriginalPrReviewEvidence({
        prNumber: 1234,
        slug: 'my-feature',
        repoDir: tmp,
      });

      assert.equal(evidence.provenance, 'direct');
      assert.deepEqual(evidence.reviewers_run, ['qwen-3-coder']);
      assert.deepEqual(evidence.challenge_stages, ['review']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
