#!/usr/bin/env -S npx tsx

/**
 * Rework Risk: cell-0.1.0 derived label backfill CLI (HOK-3361).
 *
 * Reads authoritative cr-0.1.0 rework pairs, resolves diffs and historical
 * artifacts, classifies defect review layer x lens product space, and emits
 * append-only cell-0.1.0 records as JSONL.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  CELL_LABEL_SCHEMA_VERSION,
  DEFAULT_CELL_LABELLER_VERSION,
  DEFAULT_PROMPT_VERSION,
  DEFAULT_RULES_VERSION,
  sha256Hex,
  validateReworkCellLabel,
  serializeReworkCellLabel,
  type PrRef,
  type ReworkCellLabelV1,
} from '../shared/lib/rework-cell-label.ts';
import {
  classifyStructuralSignals,
  classifyWithLlm,
  enrichOriginalPrReviewEvidence,
  reconcileClassification,
  type LlmRunner,
} from '../shared/lib/rework-cell-classifier.ts';

export interface CorrectivePairInput {
  version?: string;
  rework_id?: string;
  cr_id?: string;
  original_pr: {
    number: number;
    url?: string;
    head_sha?: string;
    merge_commit_sha?: string | null;
    title?: string;
    issue_id?: string;
    slug?: string;
  };
  corrective_pr: {
    number: number;
    url?: string;
    head_sha?: string;
    merge_commit_sha?: string | null;
    title?: string;
  };
  diff?: string;
}

export function resolveDiffForCommit(repoDir: string, sha: string): string {
  if (!sha || sha.length < 7) return '';
  const result = execArgvCommand('git', ['-C', repoDir, 'diff', `${sha}^!`], { timeout: 30_000 });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout;
  }
  const showResult = execArgvCommand('git', ['-C', repoDir, 'show', '--format=', sha], { timeout: 30_000 });
  if (showResult.exitCode === 0) {
    return showResult.stdout;
  }
  return '';
}

export async function processCorrectivePair(
  pair: CorrectivePairInput,
  options: {
    repoDir: string;
    offline?: boolean;
    model?: string;
    llmRunner?: LlmRunner;
    now?: () => Date;
  },
): Promise<ReworkCellLabelV1> {
  const repoDir = options.repoDir;
  const now = options.now ?? (() => new Date());

  const originalPr: PrRef = {
    number: pair.original_pr.number,
    url: pair.original_pr.url ?? `https://github.com/hokusai/wavemill/pull/${pair.original_pr.number}`,
    head_sha: pair.original_pr.head_sha ?? '0'.repeat(40),
    merge_commit_sha: pair.original_pr.merge_commit_sha ?? null,
    title: pair.original_pr.title,
  };

  const correctivePr: PrRef = {
    number: pair.corrective_pr.number,
    url: pair.corrective_pr.url ?? `https://github.com/hokusai/wavemill/pull/${pair.corrective_pr.number}`,
    head_sha: pair.corrective_pr.head_sha ?? '0'.repeat(40),
    merge_commit_sha: pair.corrective_pr.merge_commit_sha ?? null,
    title: pair.corrective_pr.title,
  };

  // Resolve diff
  let diff = pair.diff ?? '';
  if (!diff && correctivePr.head_sha && correctivePr.head_sha !== '0'.repeat(40)) {
    diff = resolveDiffForCommit(repoDir, correctivePr.head_sha);
  }

  // Structural classification
  const structural = classifyStructuralSignals({
    files: [],
    rawDiff: diff,
    commitMessage: correctivePr.title,
    prTitle: correctivePr.title,
  });

  // LLM classification
  const llm = await classifyWithLlm(
    {
      originalPr,
      correctivePr,
      diff,
    },
    options.llmRunner,
    { offline: options.offline ?? true },
  );

  // Reconciliation
  const reconciled = reconcileClassification(structural, llm, { offline: options.offline });

  // Original PR review evidence
  const reviewEvidence = enrichOriginalPrReviewEvidence({
    prNumber: originalPr.number,
    issueId: pair.original_pr.issue_id,
    slug: pair.original_pr.slug,
    repoDir,
  });

  const diffHash = sha256Hex(diff || 'empty');
  const reworkId = pair.rework_id || pair.cr_id || `cr:${originalPr.number}:${correctivePr.number}`;
  const reworkVersion = pair.version || 'cr-0.1.0';

  const record: ReworkCellLabelV1 = {
    schema_version: CELL_LABEL_SCHEMA_VERSION,
    source_rework_label: {
      version: reworkVersion,
      rework_id: reworkId,
    },
    original_pr: originalPr,
    corrective_pr: correctivePr,
    chosen: reconciled.chosen,
    structural: reconciled.structural,
    llm: reconciled.llm,
    agreement: reconciled.agreement,
    disagreement_state: reconciled.disagreement_state,
    reason_codes: reconciled.reason_codes,
    review_evidence: reviewEvidence,
    envelope: {
      schema_version: CELL_LABEL_SCHEMA_VERSION,
      labeller_version: DEFAULT_CELL_LABELLER_VERSION,
      rules_version: DEFAULT_RULES_VERSION,
      prompt_version: DEFAULT_PROMPT_VERSION,
      model: options.model ?? null,
      diff_hash: diffHash,
      computed_at: now().toISOString(),
    },
  };

  const validation = validateReworkCellLabel(record);
  if (!validation.valid) {
    throw new Error(`Generated record is invalid: ${validation.errors?.join('; ')}`);
  }

  return record;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  runTool({
  name: 'backfill-rework-cells',
  description: 'Emit cell-0.1.0 derived labels for corrective rework PR pairs',
  options: {
    corpus: { type: 'string', description: 'Path to cr-0.1.0 rework pairs JSONL file' },
    out: { type: 'string', description: 'Output path for cell-0.1.0 JSONL (default: stdout)' },
    'repo-dir': { type: 'string', description: 'Local git repository directory (default: .)' },
    'max-prs': { type: 'string', description: 'Max pairs to process' },
    offline: { type: 'boolean', description: 'Skip LLM second-opinion calls (run structural only)' },
    model: { type: 'string', description: 'Model identifier if LLM classification is used' },
  },
  examples: [
    'npx tsx tools/backfill-rework-cells.ts --corpus .wavemill/evals/rework-pairs.jsonl > rework-cell-labels.jsonl',
    'npx tsx tools/backfill-rework-cells.ts --corpus pairs.jsonl --offline --out .wavemill/evals/rework-cell-labels.jsonl',
  ],
  async run({ args }) {
    const corpusPath = args.corpus as string | undefined;
    if (!corpusPath) {
      throw new Error('--corpus is required');
    }
    const resolvedCorpus = resolve(corpusPath);
    if (!existsSync(resolvedCorpus)) {
      throw new Error(`Corpus file does not exist: ${resolvedCorpus}`);
    }

    const repoDir = resolve((args['repo-dir'] as string | undefined) || '.');
    const outPath = args.out ? resolve(args.out as string) : undefined;
    const maxPrs = args['max-prs'] ? Number(args['max-prs']) : Infinity;
    const offline = args.offline === true;
    const model = args.model as string | undefined;

    const content = readFileSync(resolvedCorpus, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    let count = 0;
    let errorCount = 0;
    for (const line of lines) {
      if (count >= maxPrs) break;
      try {
        const parsed = JSON.parse(line) as CorrectivePairInput;
        const label = await processCorrectivePair(parsed, {
          repoDir,
          offline,
          model,
        });

        const lineOut = serializeReworkCellLabel(label) + '\n';
        if (outPath) {
          appendFileSync(outPath, lineOut, 'utf-8');
        } else {
          process.stdout.write(lineOut);
        }
        count++;
      } catch (error) {
        errorCount++;
        process.stderr.write(`[backfill-rework-cells] Warning: skipped invalid line: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    if (errorCount > 0) {
      process.stderr.write(`[backfill-rework-cells] Warning: encountered ${errorCount} invalid lines in ${resolvedCorpus}\n`);
    }

    if (outPath) {
      process.stderr.write(`[backfill-rework-cells] Wrote ${count} records to ${outPath}\n`);
    }
  },
});
}
