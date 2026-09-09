import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArbiterSurvivalLabelV1 } from '../arbiter-survival-label.ts';
import { loadSurvivalLabelsByPrUrl, getSurvivalLabel } from './survival-labels.ts';

describe('survival-labels', () => {
  describe('loadSurvivalLabelsByPrUrl', () => {
    it('loads and deduplicates by (prUrl, horizon)', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'labels.jsonl');

      const label1: ArbiterSurvivalLabelV1 = {
        schema_version: '1.0.0',
        prUrl: 'https://github.com/owner/repo/pull/1',
        horizon_days: 30,
        label_provenance: 'harvested',
        line_ranges: [],
        outcome: {
          survived: true,
          survival_ratio: 1.0,
          reverted: false,
          followup: false,
          undone_by: null,
          report_outcome: 'survived',
          reason_codes: [],
        },
        envelope: {
          schema_version: '1.0.0',
          labeller_version: '1.0.0',
          normalization_version: '1.0.0',
          pr_head_sha: 'abc123',
          merge_sha: 'def456',
          horizon_terminal_sha: 'ghi789',
          integration_branch: 'auto/integration',
          computed_at: '2026-01-01T00:00:00Z',
        },
      };

      const label2: ArbiterSurvivalLabelV1 = {
        ...label1,
        horizon_days: 14,
      };

      const label1_newer: ArbiterSurvivalLabelV1 = {
        ...label1,
        envelope: {
          ...label1.envelope,
          computed_at: '2026-01-02T00:00:00Z',
        },
        outcome: {
          ...label1.outcome,
          survived: false,
          report_outcome: 'reverted',
        },
      };

      // Write labels in order: old 30-day, 14-day, newer 30-day
      writeFileSync(labelsPath, JSON.stringify(label1) + '\n');
      writeFileSync(labelsPath, JSON.stringify(label2) + '\n' + JSON.stringify(label1_newer) + '\n', { flag: 'a' });

      const map = await loadSurvivalLabelsByPrUrl(labelsPath);

      // Check the map structure
      assert(map.has(label1.prUrl));
      const horizonMap = map.get(label1.prUrl)!;

      // The 30-day horizon should have the newer version
      const label30 = horizonMap.get(30);
      assert(label30);
      assert.strictEqual(label30.envelope.computed_at, '2026-01-02T00:00:00Z');
      assert.strictEqual(label30.outcome.report_outcome, 'reverted');

      // The 14-day horizon should have the original
      const label14 = horizonMap.get(14);
      assert(label14);
      assert.strictEqual(label14.envelope.computed_at, '2026-01-01T00:00:00Z');
    });

    it('handles empty JSONL file', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'empty.jsonl');
      writeFileSync(labelsPath, '');

      const map = await loadSurvivalLabelsByPrUrl(labelsPath);
      assert.strictEqual(map.size, 0);
    });

    it('skips rows with missing prUrl or horizon_days', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'partial.jsonl');

      const validLabel: ArbiterSurvivalLabelV1 = {
        schema_version: '1.0.0',
        prUrl: 'https://github.com/owner/repo/pull/1',
        horizon_days: 30,
        label_provenance: 'harvested',
        line_ranges: [],
        outcome: {
          survived: true,
          survival_ratio: 1.0,
          reverted: false,
          followup: false,
          undone_by: null,
          report_outcome: 'survived',
          reason_codes: [],
        },
        envelope: {
          schema_version: '1.0.0',
          labeller_version: '1.0.0',
          normalization_version: '1.0.0',
          pr_head_sha: 'abc123',
          merge_sha: 'def456',
          horizon_terminal_sha: 'ghi789',
          integration_branch: 'auto/integration',
          computed_at: '2026-01-01T00:00:00Z',
        },
      };

      const invalidLabel = { ...validLabel, prUrl: undefined as unknown as string };

      writeFileSync(labelsPath, JSON.stringify(validLabel) + '\n');
      writeFileSync(labelsPath, JSON.stringify(invalidLabel) + '\n', { flag: 'a' });

      const map = await loadSurvivalLabelsByPrUrl(labelsPath);
      assert.strictEqual(map.size, 1);
    });
  });

  describe('getSurvivalLabel', () => {
    it('retrieves a label for a given prUrl and horizon', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'labels.jsonl');

      const label: ArbiterSurvivalLabelV1 = {
        schema_version: '1.0.0',
        prUrl: 'https://github.com/owner/repo/pull/42',
        horizon_days: 30,
        label_provenance: 'harvested',
        line_ranges: [],
        outcome: {
          survived: true,
          survival_ratio: 1.0,
          reverted: false,
          followup: false,
          undone_by: null,
          report_outcome: 'survived',
          reason_codes: [],
        },
        envelope: {
          schema_version: '1.0.0',
          labeller_version: '1.0.0',
          normalization_version: '1.0.0',
          pr_head_sha: 'abc123',
          merge_sha: 'def456',
          horizon_terminal_sha: 'ghi789',
          integration_branch: 'auto/integration',
          computed_at: '2026-01-01T00:00:00Z',
        },
      };

      writeFileSync(labelsPath, JSON.stringify(label) + '\n');
      const map = await loadSurvivalLabelsByPrUrl(labelsPath);

      const retrieved = getSurvivalLabel(map, 'https://github.com/owner/repo/pull/42', 30);
      assert(retrieved);
      assert.strictEqual(retrieved.outcome.report_outcome, 'survived');
    });

    it('returns undefined for missing prUrl', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'empty.jsonl');
      writeFileSync(labelsPath, '');

      const map = await loadSurvivalLabelsByPrUrl(labelsPath);
      const retrieved = getSurvivalLabel(map, 'https://github.com/owner/repo/pull/999', 30);
      assert.strictEqual(retrieved, undefined);
    });

    it('returns undefined for missing horizon', async () => {
      const tmpdir = mkdtempSync('/tmp/survival-test-');
      const labelsPath = join(tmpdir, 'labels.jsonl');

      const label: ArbiterSurvivalLabelV1 = {
        schema_version: '1.0.0',
        prUrl: 'https://github.com/owner/repo/pull/42',
        horizon_days: 30,
        label_provenance: 'harvested',
        line_ranges: [],
        outcome: {
          survived: true,
          survival_ratio: 1.0,
          reverted: false,
          followup: false,
          undone_by: null,
          report_outcome: 'survived',
          reason_codes: [],
        },
        envelope: {
          schema_version: '1.0.0',
          labeller_version: '1.0.0',
          normalization_version: '1.0.0',
          pr_head_sha: 'abc123',
          merge_sha: 'def456',
          horizon_terminal_sha: 'ghi789',
          integration_branch: 'auto/integration',
          computed_at: '2026-01-01T00:00:00Z',
        },
      };

      writeFileSync(labelsPath, JSON.stringify(label) + '\n');
      const map = await loadSurvivalLabelsByPrUrl(labelsPath);

      const retrieved = getSurvivalLabel(map, 'https://github.com/owner/repo/pull/42', 14);
      assert.strictEqual(retrieved, undefined);
    });
  });
});
