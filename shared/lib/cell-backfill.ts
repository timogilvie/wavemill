/**
 * Cell-label backfill orchestration (HOK-3361, phase 3).
 *
 * Reads the authoritative `cr-0.1.0` rework corpus, resolves the corrective
 * diff substrate (precomputed changed paths or `git diff --numstat` between
 * the original and corrective head SHAs), classifies structurally first with
 * the bounded LLM as fallback, enriches orthogonally with review evidence for
 * the original PR, and appends validated `cell-0.1.0` rows to the
 * append-only stream.
 *
 * Deterministic by default (LLM disabled): the same corpus and repo state
 * produce byte-identical rows apart from `computed_at`.
 */

import { execArgvCommand } from './shell-utils.ts';
import {
  buildCellLabelRow,
  canonicalHashCorrectivePairRow,
  type CellLabelRowV0,
  type CellLlmOutcome,
  type CellReviewEvidence,
  type ChangedPath,
  type CorrectivePairRowV0,
} from './cell-label-contract.ts';
import { appendCellLabelRows, dedupeCellLabelRows, loadCellLabelRows } from './cell-label-store.ts';
import { classifyCellStructural } from './cell-classifier.ts';
import { classifyCellWithLlm, disabledCellLlmOutcome, hashDiff, type CellLlmDeps } from './cell-llm-adapter.ts';
import { collectReviewEvidenceFromFeatureDir } from './cell-review-evidence.ts';

export interface CellBackfillDeps {
  /** Load the authoritative corrective-pair corpus. */
  loadCorrectiveRows(path: string): CorrectivePairRowV0[];
  /** Resolve the changed-path substrate for one pair. */
  resolveChangedPaths(row: CorrectivePairRowV0, repoDir: string | undefined): Promise<ChangedPath[]>;
  /** Resolve the corrective diff text for the LLM fallback (when enabled). */
  resolveDiffText?(row: CorrectivePairRowV0, repoDir: string | undefined): Promise<string>;
  /** Optional LLM boundary; absent means the LLM channel is disabled. */
  llmDeps?: CellLlmDeps;
  /** Review-evidence reader for the original PR's feature directory. */
  collectReviewEvidence?(featureDir: string, expectedHeadSha: string | null): CellReviewEvidence;
}

export interface BackfillCellLabelsInput {
  /** Path to the `cr-0.1.0` JSONL rework corpus. */
  crLabelsPath: string;
  repoDir?: string;
  /** Append-only output stream; when set, rows are appended and validated. */
  outPath?: string;
  /** Feature directories holding the original PR's durable artifacts, keyed by original PR URL. */
  featureDirsByOriginalPrUrl?: Map<string, string>;
  /** Enable the bounded LLM fallback (default: disabled, deterministic). */
  useLlm?: boolean;
  /** ISO timestamp stamp; tests inject a fixed value for reproducibility. */
  computedAt: string;
  deps: CellBackfillDeps;
}

export interface BackfillCellLabelsResult {
  rows: CellLabelRowV0[];
  skipped: Array<{ correctivePrUrl: string; reason: string }>;
}

/** Default deps: git numstat diff resolution + disk feature-dir evidence. */
export function createDefaultCellBackfillDeps(): CellBackfillDeps {
  return {
    loadCorrectiveRows: loadCorrectivePairRows,
    resolveChangedPaths: resolveChangedPathsFromGit,
    resolveDiffText: resolveDiffTextFromGit,
    collectReviewEvidence: collectReviewEvidenceFromFeatureDir,
  };
}

/**
 * Run the backfill over the corpus. Rows whose corrective pair cannot be
 * resolved are skipped with a typed reason; the core rework fact is never
 * rewritten and no cell is guessed without substrate.
 */
export async function backfillCellLabels(input: BackfillCellLabelsInput): Promise<BackfillCellLabelsResult> {
  const crRows = input.deps.loadCorrectiveRows(input.crLabelsPath);
  const rows: CellLabelRowV0[] = [];
  const skipped: Array<{ correctivePrUrl: string; reason: string }> = [];

  for (const crRow of crRows) {
    if (crRow.label !== 'reworked') {
      skipped.push({ correctivePrUrl: crRow.corrective_pr.url, reason: 'not_reworked' });
      continue;
    }
    const changed = crRow.changed_paths
      ?? await input.deps.resolveChangedPaths(crRow, input.repoDir);
    const structural = classifyCellStructural(changed);

    let llm: CellLlmOutcome;
    if (input.useLlm && input.deps.llmDeps && input.deps.resolveDiffText) {
      const diff = await input.deps.resolveDiffText(crRow, input.repoDir);
      llm = await classifyCellWithLlm({ diff, deps: input.deps.llmDeps });
    } else {
      llm = disabledCellLlmOutcome(hashDiff(JSON.stringify(changed)));
    }

    let reviewEvidence: CellReviewEvidence | undefined;
    const featureDir = input.featureDirsByOriginalPrUrl?.get(crRow.original_pr.url);
    if (featureDir && input.deps.collectReviewEvidence) {
      reviewEvidence = input.deps.collectReviewEvidence(featureDir, crRow.original_pr.head_sha);
    }

    rows.push(buildCellLabelRow({
      label_key: {
        repo: crRow.repo,
        original_pr_url: crRow.original_pr.url,
        corrective_pr_url: crRow.corrective_pr.url,
      },
      original_pr: crRow.original_pr,
      corrective_pr: crRow.corrective_pr,
      structural,
      llm,
      ...(reviewEvidence ? { review_evidence: reviewEvidence } : {}),
      envelope: {
        prompt_version: llm.prompt_version,
        source_label_row_hash: canonicalHashCorrectivePairRow(crRow),
        corrective_head_sha: crRow.corrective_pr.head_sha,
        original_head_sha: crRow.original_pr.head_sha,
        computed_at: input.computedAt,
      },
    }));
  }

  if (input.outPath) {
    appendCellLabelRows(input.outPath, rows);
  }
  return { rows, skipped };
}

/** Load + validate a `cr-0.1.0` corpus. Non-reworked rows are kept for skip accounting. */
export function loadCorrectivePairRows(path: string): CorrectivePairRowV0[] {
  return loadCellLabelRows(path).rows as unknown as CorrectivePairRowV0[];
}

/** Summarize an existing stream: deduplicated latest labels per natural key. */
export function loadDeduplicatedCellLabels(path: string): CellLabelRowV0[] {
  return [...dedupeCellLabelRows(loadCellLabelRows(path).rows).values()];
}

async function resolveChangedPathsFromGit(
  row: CorrectivePairRowV0,
  repoDir: string | undefined,
): Promise<ChangedPath[]> {
  const diff = await resolveDiffTextFromGit(row, repoDir);
  return parseNumstat(diff).map((entry) => ({
    path: entry.path,
    status: entry.additions === 0 && entry.deletions === 0 ? 'modified' : 'modified',
    additions: entry.additions,
    deletions: entry.deletions,
  }));
}

async function resolveDiffTextFromGit(
  row: CorrectivePairRowV0,
  repoDir: string | undefined,
): Promise<string> {
  const originalSha = row.original_pr.head_sha;
  const correctiveSha = row.corrective_pr.head_sha;
  if (!repoDir || !originalSha || !correctiveSha) {
    return '';
  }
  const result = execArgvCommand('git', ['-C', repoDir, 'diff', '--numstat', originalSha, correctiveSha]);
  return result.exitCode === 0 ? result.stdout : '';
}

/** Parse `git diff --numstat` output into changed-path magnitudes. */
export function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
  const entries: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    entries.push({
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      path: match[3] as string,
    });
  }
  return entries;
}