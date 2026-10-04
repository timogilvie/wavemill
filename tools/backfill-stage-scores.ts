#!/usr/bin/env -S npx tsx

/**
 * Backfill Stage Scores — re-run eval judge on existing records to populate
 * missing plan and review stageScores.
 *
 * Uses the updated eval-judge.md prompt which always produces all 4 stage scores,
 * even when stage artifacts are not available (using inference from PR diff and
 * intervention patterns).
 *
 * Usage:
 *   npx tsx tools/backfill-stage-scores.ts --dry-run --limit 5
 *   npx tsx tools/backfill-stage-scores.ts --limit 50
 *   npx tsx tools/backfill-stage-scores.ts --input .wavemill/evals/aggregated-evals.jsonl
 *   npx tsx tools/backfill-stage-scores.ts --model claude-sonnet-5   # override to Claude
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { loadPromptTemplate } from '../shared/lib/prompt-utils.ts';
import { callLLM, resolveProviderForModel, type LLMProvider } from '../shared/lib/llm-cli.ts';

/** Exported for testing: derive provider from a backfill model name. */
export function getBackfillProvider(model: string, repoDir: string): LLMProvider {
  return resolveProviderForModel(model, repoDir);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface EvalRecord {
  id: string;
  score: number;
  scoreBand: string;
  issueId?: string;
  prUrl?: string;
  originalPrompt: string;
  rationale?: string;
  interventionCount?: number;
  interventionDetails?: string[];
  interventionRequired?: boolean;
  sourceRepo?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

interface StageScore {
  score: number;
  rationale: string;
}

interface JudgeStageResponse {
  score: number;
  rationale: string;
  interventionFlags: string[];
  stageScores: {
    expansion?: StageScore;
    plan?: StageScore;
    implementation?: StageScore;
    review?: StageScore;
  };
}

function needsBackfill(record: EvalRecord): boolean {
  const stages = record.metadata?.stageScores || {};
  // Need backfill if missing plan OR review stageScores
  return !stages.plan || !stages.review;
}

function buildBackfillPrompt(template: string, record: EvalRecord): string {
  const taskPrompt = record.originalPrompt?.slice(0, 3000) || 'Not available';

  // Build intervention metadata from the record
  const interventionMeta = JSON.stringify({
    interventionRequired: record.interventionRequired ?? (record.interventionCount ?? 0) > 0,
    interventionCount: record.interventionCount ?? 0,
    interventionDetails: record.interventionDetails ?? [],
    penaltyWeights: record.metadata?.interventionSummary?.penaltyWeights,
  }, null, 2);

  // Use the existing rationale as context for the PR review output
  const prReview = record.prUrl
    ? `[PR: ${record.prUrl}]\n\nPrevious judge rationale:\n${record.rationale || 'Not available'}`
    : `Previous judge rationale:\n${record.rationale || 'Not available'}`;

  return template
    .replace('{{TASK_PROMPT}}', taskPrompt)
    .replace('{{PR_REVIEW_OUTPUT}}', prReview)
    .replace('{{INTERVENTION_METADATA}}', interventionMeta)
    .replace('{{TASK_PACKET}}', 'Not available for this workflow.')
    .replace('{{PLAN_CONTENT}}', 'Not available for this workflow.')
    .replace('{{SELF_REVIEW_SUMMARY}}', 'Not available for this workflow.');
}

function parseJudgeOutput(raw: string): JudgeStageResponse | null {
  // Strip markdown fences
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/, '');
  cleaned = cleaned.replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score === 'number' && parsed.stageScores) {
      return parsed as JudgeStageResponse;
    }
  } catch {
    // Try to find JSON in the output
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.score === 'number' && parsed.stageScores) {
          return parsed as JudgeStageResponse;
        }
      } catch {
        // Give up
      }
    }
  }
  return null;
}

runTool({
  name: 'backfill-stage-scores',
  description: 'Backfill missing plan/review stageScores in eval records',
  options: {
    input: { type: 'string', description: 'Input JSONL file (default: aggregated-evals.jsonl)' },
    output: { type: 'string', description: 'Output JSONL file (default: <input>.backfilled.jsonl)' },
    limit: { type: 'string', description: 'Max records to process (number)' },
    model: { type: 'string', description: 'Judge model (default: gpt-5.6-terra; use claude-sonnet-5 to route via Claude)' },
    'dry-run': { type: 'boolean', description: 'Show what would be processed without making LLM calls' },
    'skip-has-impl': { type: 'boolean', description: 'Skip records that already have implementation stageScores (only backfill records with no stage scores at all)' },
  },
  async run({ args }) {
    const inputPath = args.input || join(process.cwd(), '.wavemill/evals/aggregated-evals.jsonl');
    const outputPath = args.output || inputPath.replace('.jsonl', '.backfilled.jsonl');
    const limit = args.limit ? Number(args.limit) : Infinity;
    const model = (args.model as string) || 'gpt-5.6-terra';
    const provider = getBackfillProvider(model, process.cwd());
    const dryRun = !!args['dry-run'];
    const skipHasImpl = !!args['skip-has-impl'];

    if (!existsSync(inputPath)) {
      console.error(`Input file not found: ${inputPath}`);
      process.exit(1);
    }

    // Load judge template
    const templatePath = join(__dirname, 'prompts/eval-judge.md');
    const template = await loadPromptTemplate(templatePath);

    // Read all records
    const lines = readFileSync(inputPath, 'utf-8').trim().split('\n');
    const records: EvalRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Skip invalid lines
      }
    }

    // Filter to records needing backfill
    let toBackfill = records.filter(needsBackfill);
    if (skipHasImpl) {
      toBackfill = toBackfill.filter(r => {
        const stages = r.metadata?.stageScores || {};
        return !stages.implementation;
      });
    }

    const processCount = Math.min(toBackfill.length, limit);

    console.log(`Input: ${inputPath}`);
    console.log(`Total records: ${records.length}`);
    console.log(`Need backfill: ${toBackfill.length}`);
    console.log(`Will process: ${processCount}`);
    console.log(`Model: ${model}`);
    console.log(`Provider: ${provider}`);
    console.log();

    if (dryRun) {
      console.log('--- Dry run: showing first 10 records that need backfill ---\n');
      for (const r of toBackfill.slice(0, 10)) {
        const stages = r.metadata?.stageScores || {};
        const hasStages = Object.keys(stages).join(', ') || 'none';
        console.log(`  ${r.issueId || r.id?.slice(0, 8)} (score=${r.score}, repo=${r.sourceRepo}, stages=${hasStages})`);
      }
      console.log(`\nDry run complete. Use without --dry-run to process.`);
      return;
    }

    // Ensure output directory exists
    mkdirSync(dirname(outputPath), { recursive: true });

    // Process records
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const record of toBackfill.slice(0, processCount)) {
      processed++;
      const id = record.issueId || record.id?.slice(0, 8) || `record-${processed}`;
      process.stdout.write(`[${processed}/${processCount}] ${id}... `);

      try {
        const prompt = buildBackfillPrompt(template, record);
        const result = await callLLM(prompt, {
          model,
          provider,
          repoDir: process.cwd(),
          mode: 'sync',
          timeout: 180_000,
          stripToolCalls: true,
        });
        const response = result.text;
        const parsed = parseJudgeOutput(response);

        if (parsed?.stageScores) {
          // Merge new stage scores into existing metadata
          const existingStages = record.metadata?.stageScores || {};
          const mergedStages = { ...existingStages };

          // Only fill in missing stages (don't overwrite existing ones)
          for (const [stage, data] of Object.entries(parsed.stageScores)) {
            if (!mergedStages[stage] && data && typeof data.score === 'number') {
              mergedStages[stage] = data;
            }
          }

          record.metadata = record.metadata || {};
          record.metadata.stageScores = mergedStages;
          record.metadata.backfilledAt = new Date().toISOString();

          const stageNames = Object.keys(mergedStages).join(', ');
          console.log(`OK (stages: ${stageNames})`);
          succeeded++;
        } else {
          console.log('PARSE_ERROR');
          failed++;
        }
      } catch (err: any) {
        console.log(`ERROR: ${err.message?.slice(0, 80)}`);
        failed++;
      }

      // Write the (possibly updated) record to output
      appendFileSync(outputPath, JSON.stringify(record) + '\n');
    }

    // Append remaining unprocessed records as-is
    const unprocessed = toBackfill.slice(processCount);
    const alreadyGood = records.filter(r => !needsBackfill(r));
    for (const record of [...unprocessed, ...alreadyGood]) {
      appendFileSync(outputPath, JSON.stringify(record) + '\n');
    }

    console.log(`\n--- Results ---`);
    console.log(`Processed: ${processed}`);
    console.log(`Succeeded: ${succeeded}`);
    console.log(`Failed: ${failed}`);
    console.log(`Output: ${outputPath}`);
  },
});
