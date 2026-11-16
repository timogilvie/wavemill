import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readJsonlFile } from '../jsonl-utils.ts';
import { buildBudgetedComparisonPrompt, runBlindJudge, type BlindJudgeCall, type PresentationOrder } from '../pr-comparison.ts';
import type { TransportAdapter } from '../model-adapters/transport-adapter.ts';
import { formatRubricForJudgePrompt } from '../rubric.ts';
import { hashString } from '../prompt-hash.ts';
import { errorMessage } from '../error-utils.ts';
import type { ChallengeComparisonDimensions, ChallengeCriterionRationales } from '../challenge-comparison.ts';
import { readCorpusPair } from './corpus.ts';

export interface SwapTestRunManifest {
  runId: string;
  judge_model: string;
  judge_template_hash: string;
  pairIds: string[];
  harnessGitSha: string | null;
  startedAt: string;
  finishedAt?: string;
  totals?: {
    calls: number;
    ok: number;
    errors: number;
    dryRunPrompts?: number;
    costUsd: number;
  };
}

export interface SwapTestResultRow {
  pairId: string;
  order: PresentationOrder;
  status: 'ok' | 'error' | 'dry_run';
  winner?: 'primary' | 'challenger';
  dimensions?: ChallengeComparisonDimensions;
  criterionRationales?: ChallengeCriterionRationales;
  rationale?: string;
  workflowInsight?: string;
  judgePromptHash?: string;
  judgeTemplateHash: string;
  judgeModel: string;
  costUsd: number | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Judge prompt size in bytes. */
  promptBytes: number;
  /** Change files summarised rather than shown verbatim. */
  summarisedFiles: number;
  durationMs: number;
  error?: string;
  timestamp: string;
}

export interface SwapTestRunOptions {
  evalsDir: string;
  runId: string;
  pairIds: string[];
  judgeModel: string;
  promptTemplate: string;
  orders?: PresentationOrder[];
  concurrency?: number;
  maxCostUsd?: number;
  dryRun?: boolean;
  force?: boolean;
  limit?: number;
  onlyOrder?: PresentationOrder;
  deps?: {
    callLlm?: BlindJudgeCall;
    /** The judge's transport adapter; defaults to the Claude CLI adapter for the judge model. */
    adapter?: TransportAdapter | null;
    now?: () => Date;
  };
}

export interface SwapTestRunSummary {
  manifest: SwapTestRunManifest;
  rowsWritten: number;
  skipped: number;
  costUsd: number;
  stoppedForCost: boolean;
}

function runDir(evalsDir: string, runId: string): string {
  return join(evalsDir, 'swap-test', 'runs', runId);
}

export function manifestPath(evalsDir: string, runId: string): string {
  return join(runDir(evalsDir, runId), 'manifest.json');
}

export function resultsPath(evalsDir: string, runId: string): string {
  return join(runDir(evalsDir, runId), 'results.jsonl');
}

function readManifest(path: string): SwapTestRunManifest | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf-8')) as SwapTestRunManifest;
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function existingKeys(path: string, includeDryRun: boolean): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readJsonlFile<SwapTestResultRow>(path)
      .filter((row) => includeDryRun || row.status !== 'dry_run')
      .map((row) => `${row.pairId}\u0000${row.order}`),
  );
}

function writeManifest(path: string, manifest: SwapTestRunManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function promptInput(pair: ReturnType<typeof readCorpusPair>, order: PresentationOrder, promptTemplate: string) {
  return {
    issuePrompt: pair.context.issuePrompt,
    primaryDiff: pair.primaryDiff,
    challengerDiff: pair.challengerDiff,
    presentationOrder: order,
    promptTemplate,
    primaryRouting: pair.context.primaryRouting,
    challengerRouting: pair.context.challengerRouting,
    challengeType: pair.context.challengeType.type,
    primaryStageEval: pair.context.primaryStageEval,
    challengerStageEval: pair.context.challengerStageEval,
    primaryExecution: pair.context.primaryExecution,
    challengerExecution: pair.context.challengerExecution,
  };
}

export async function runSwapTest(options: SwapTestRunOptions): Promise<SwapTestRunSummary> {
  const now = options.deps?.now ?? (() => new Date());
  const dir = runDir(options.evalsDir, options.runId);
  const manifestFile = manifestPath(options.evalsDir, options.runId);
  const resultsFile = resultsPath(options.evalsDir, options.runId);
  const judgeTemplateHash = hashString(`${options.promptTemplate}\n${formatRubricForJudgePrompt()}`);
  const existingManifest = readManifest(manifestFile);
  const pairIds = options.limit ? options.pairIds.slice(0, options.limit) : options.pairIds;

  let manifest: SwapTestRunManifest;
  if (existingManifest) {
    if (existingManifest.judge_model !== options.judgeModel || existingManifest.judge_template_hash !== judgeTemplateHash) {
      throw new Error(
        `Run ${options.runId} was created with model/template ${existingManifest.judge_model}/${existingManifest.judge_template_hash}; ` +
        `requested ${options.judgeModel}/${judgeTemplateHash}`,
      );
    }
    manifest = existingManifest;
  } else {
    manifest = {
      runId: options.runId,
      judge_model: options.judgeModel,
      judge_template_hash: judgeTemplateHash,
      pairIds,
      harnessGitSha: gitSha(),
      startedAt: now().toISOString(),
    };
    mkdirSync(dir, { recursive: true });
    writeManifest(manifestFile, manifest);
  }

  const orders = (options.onlyOrder ? [options.onlyOrder] : options.orders) ?? ['primary-first', 'challenger-first'];
  const keys = options.force ? new Set<string>() : existingKeys(resultsFile, options.dryRun === true);
  const tasks: Array<{ pairId: string; order: PresentationOrder }> = [];
  for (const pairId of pairIds) {
    const pair = readCorpusPair(options.evalsDir, pairId);
    if (pair.context.hydrationStatus !== 'ok') continue;
    for (const order of orders) {
      if (!keys.has(`${pairId}\u0000${order}`)) {
        tasks.push({ pairId, order });
      }
    }
  }

  let cursor = 0;
  let rowsWritten = 0;
  let skipped = pairIds.length * orders.length - tasks.length;
  let costUsd = 0;
  let stoppedForCost = false;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));

  async function worker(): Promise<void> {
    while (true) {
      if (options.maxCostUsd !== undefined && costUsd >= options.maxCostUsd) {
        stoppedForCost = true;
        return;
      }
      const index = cursor++;
      if (index >= tasks.length) break;
      const task = tasks[index];
      const pair = readCorpusPair(options.evalsDir, task.pairId);
      const started = Date.now();
      let row: SwapTestResultRow;
      try {
        const input = promptInput(pair, task.order, options.promptTemplate);
        if (options.dryRun) {
          const built = buildBudgetedComparisonPrompt(input, options.deps?.adapter ?? null);
          row = {
            pairId: task.pairId,
            order: task.order,
            status: 'dry_run',
            judgeTemplateHash,
            judgeModel: options.judgeModel,
            costUsd: null,
            promptBytes: Buffer.byteLength(built.prompt, 'utf8'),
            summarisedFiles:
              built.inputs.primary.summarisedCount + built.inputs.challenger.summarisedCount
              + (built.inputs.shared?.summarisedCount ?? 0),
            durationMs: Date.now() - started,
            timestamp: now().toISOString(),
          };
        } else {
          const outcome = await runBlindJudge({
            ...input,
            model: options.judgeModel,
            deps: {
              callLlm: options.deps?.callLlm,
              adapter: options.deps?.adapter,
            },
          });
          row = {
            pairId: task.pairId,
            order: task.order,
            status: 'ok',
            winner: outcome.verdict.winner,
            dimensions: outcome.verdict.dimensions,
            criterionRationales: outcome.verdict.criterionRationales,
            rationale: outcome.verdict.rationale,
            workflowInsight: outcome.verdict.workflowInsight,
            judgePromptHash: outcome.judgePromptHash,
            judgeTemplateHash,
            judgeModel: outcome.judgeModel,
            costUsd: outcome.costUsd,
            usage: outcome.usage,
            promptBytes: outcome.promptBytes,
            summarisedFiles: outcome.summarisedFiles,
            durationMs: Date.now() - started,
            timestamp: now().toISOString(),
          };
          costUsd += outcome.costUsd ?? 0;
        }
      } catch (error) {
        row = {
          pairId: task.pairId,
          order: task.order,
          status: 'error',
          judgeTemplateHash,
          judgeModel: options.judgeModel,
          costUsd: null,
          promptBytes: 0,
          summarisedFiles: 0,
          durationMs: Date.now() - started,
          error: errorMessage(error),
          timestamp: now().toISOString(),
        };
      }
      mkdirSync(dirname(resultsFile), { recursive: true });
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`, 'utf-8');
      rowsWritten++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length || 1) }, () => worker()));

  const rows = existsSync(resultsFile) ? readJsonlFile<SwapTestResultRow>(resultsFile) : [];
  manifest = {
    ...manifest,
    finishedAt: now().toISOString(),
    totals: {
      calls: rows.filter((row) => row.status !== 'dry_run').length,
      ok: rows.filter((row) => row.status === 'ok').length,
      errors: rows.filter((row) => row.status === 'error').length,
      dryRunPrompts: rows.filter((row) => row.status === 'dry_run').length || undefined,
      costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    },
  };
  writeManifest(manifestFile, manifest);

  return {
    manifest,
    rowsWritten,
    skipped,
    costUsd,
    stoppedForCost,
  };
}
