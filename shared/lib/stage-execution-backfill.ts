/** Backfill durable stage execution evidence from retained CLI sessions. */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StageName, StageResult } from './stage-result.ts';
import { resolveStageExecutionEvidence } from './stage-execution-evidence.ts';

export interface BackfillStageExecutionOptions {
  directory: string;
  archived: boolean;
  worktreePath: string;
  branchName: string;
  repoDir: string;
  stages?: StageName[];
  dryRun?: boolean;
  claudeProjectsDirs?: string[];
  codexSessionsRoot?: string;
}

export interface BackfillStageExecutionReport {
  stage: StageName;
  outcome: 'updated' | 'unchanged' | 'unrecoverable' | 'skipped';
  previousExecutedModel: string | null;
  executedModel: string | null;
  evidenceStatus: string;
  modelAttributionEligible: boolean;
  detail: string;
}

function resultPath(directory: string, stage: StageName, archived: boolean): string {
  return join(directory, archived ? `${stage}-result.json` : `.${stage}-result.json`);
}

function terminal(status: StageResult['status']): boolean {
  return status === 'completed' || status === 'aborted' || status === 'failed';
}

function attribution(result: StageResult, executedModel: string | null, evidenceStatus: string): Pick<StageResult, 'modelAttributionEligible' | 'modelAttributionIneligibleReason'> {
  if (result.status !== 'completed') return { modelAttributionEligible: false, modelAttributionIneligibleReason: 'stage_not_completed' };
  if (!executedModel) return { modelAttributionEligible: false, modelAttributionIneligibleReason: 'missing_execution_evidence' };
  if (evidenceStatus === 'contradicted') return { modelAttributionEligible: false, modelAttributionIneligibleReason: 'execution_contradicted' };
  const intended = result.intendedModel ?? result.model;
  if (intended && intended !== executedModel) return { modelAttributionEligible: false, modelAttributionIneligibleReason: 'runtime_fallback' };
  return { modelAttributionEligible: true };
}

/** Backfill each requested result file. Missing or unresolvable evidence is reported, never guessed. */
export async function backfillStageExecutionEvidence(
  options: BackfillStageExecutionOptions,
): Promise<BackfillStageExecutionReport[]> {
  const reports: BackfillStageExecutionReport[] = [];
  for (const stage of options.stages ?? ['planning', 'coding', 'review']) {
    const file = resultPath(options.directory, stage, options.archived);
    let result: StageResult;
    try {
      result = JSON.parse(await readFile(file, 'utf8')) as StageResult;
    } catch {
      reports.push({ stage, outcome: 'skipped', previousExecutedModel: null, executedModel: null, evidenceStatus: 'missing', modelAttributionEligible: false, detail: 'result_file_missing_or_invalid' });
      continue;
    }
    if (!terminal(result.status)) {
      reports.push({ stage, outcome: 'skipped', previousExecutedModel: result.executedModel ?? null, executedModel: result.executedModel ?? null, evidenceStatus: result.executionEvidence?.status ?? 'missing', modelAttributionEligible: result.modelAttributionEligible === true, detail: 'stage_not_terminal' });
      continue;
    }
    if (result.executedModel && result.executionEvidence?.status === 'direct') {
      reports.push({ stage, outcome: 'unchanged', previousExecutedModel: result.executedModel, executedModel: result.executedModel, evidenceStatus: 'direct', modelAttributionEligible: result.modelAttributionEligible === true, detail: 'already_direct' });
      continue;
    }
    const agent = result.agent as 'claude' | 'codex' | 'claude-deepseek';
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'claude-deepseek') {
      reports.push({ stage, outcome: 'unrecoverable', previousExecutedModel: result.executedModel ?? null, executedModel: null, evidenceStatus: 'missing', modelAttributionEligible: false, detail: 'unsupported_agent' });
      continue;
    }
    const evidence = await resolveStageExecutionEvidence({
      agentType: agent,
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      windowStart: result.startedAt ?? null,
      windowEnd: result.finishedAt ?? null,
      repoDir: options.repoDir,
      claudeProjectsDirs: options.claudeProjectsDirs,
      codexSessionsRoot: options.codexSessionsRoot,
    });
    const fields = attribution(result, evidence.executedModel, evidence.evidenceStatus);
    const next: StageResult = {
      ...result,
      executedModel: evidence.executedModel,
      executionEvidence: { status: evidence.evidenceStatus, source: evidence.evidenceSource, detail: evidence.detail, recordedAt: new Date().toISOString() },
      ...fields,
    };
    const outcome = evidence.executedModel ? 'updated' : 'unrecoverable';
    if (!options.dryRun) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    }
    reports.push({ stage, outcome, previousExecutedModel: result.executedModel ?? null, executedModel: evidence.executedModel, evidenceStatus: evidence.evidenceStatus, modelAttributionEligible: fields.modelAttributionEligible, detail: evidence.detail });
  }
  return reports;
}
