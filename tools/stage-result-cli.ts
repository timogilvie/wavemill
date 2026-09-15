#!/usr/bin/env -S npx tsx
/**
 * Stage Result CLI — Shell-callable interface for stage result I/O (HOK-1192)
 *
 * Provides write/read/update subcommands so the shell orchestrator can manage
 * stage result files without constructing JSON via heredoc.
 *
 * Usage:
 *   npx tsx tools/stage-result-cli.ts write <feature_dir> <stage> <status> [options]
 *   npx tsx tools/stage-result-cli.ts read  <feature_dir> <stage>
 *   npx tsx tools/stage-result-cli.ts update <feature_dir> <stage> [options]
 */

import {
  writeStageResult,
  writeStageResultWithHistory,
  readStageResult,
  updateStageResult,
  isValidStage,
  isValidStatus,
} from '../shared/lib/stage-result.ts';
import type { StageResult, StageName, StageStatus, StageArtifacts } from '../shared/lib/stage-result.ts';
import { resolveStageExecutionEvidence } from '../shared/lib/stage-execution-evidence.ts';

const USAGE = `stage-result-cli — manage controller-owned stage result files

Subcommands:
  write  <feature_dir> <stage> <status>  Write a new stage result
  write-with-history <feature_dir> <stage> <status>  Archive prior terminal result, then write
  read   <feature_dir> <stage>           Read a stage result (JSON to stdout)
  update <feature_dir> <stage>           Update an existing stage result

Options (write/update):
  --agent <name>            Agent identifier
  --model <name>            Model identifier
  --notes <text>            Human-readable notes
  --artifacts <json>        Stage-specific artifacts (JSON string)
  --failure-reason <text>   Failure reason (for failed/aborted status)
  --started-at <iso>        Override startedAt timestamp
  --finished-at <iso>       Override finishedAt timestamp
  --intended-model <name>   Model requested by routing/launch
  --executed-model <name>   Evidence-backed executed model, or null
  --execution-evidence-status <status>  direct | missing | contradicted | inherited
  --execution-evidence-source <source>  Evidence producer/source
  --execution-evidence-detail <text>    Human-readable evidence diagnostic
  --model-attribution-eligible <bool>   Override quality-attribution eligibility
  --resolve-executed-from-session       Resolve CLI identity from retained session telemetry
  --worktree <path>                     Session worktree for resolution
  --branch <name>                       Session branch for resolution

Examples:
  npx tsx tools/stage-result-cli.ts write features/my-feat planning running --agent claude --model opus-4-6
  npx tsx tools/stage-result-cli.ts read features/my-feat planning
  npx tsx tools/stage-result-cli.ts update features/my-feat planning --status completed --notes "Plan approved"
`;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++; // skip value
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

function nullableModel(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  return trimmed;
}

function boolFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function validEvidenceStatus(value: string | undefined): value is 'direct' | 'missing' | 'contradicted' | 'inherited' {
  return value === 'direct' || value === 'missing' || value === 'contradicted' || value === 'inherited';
}

function executionTruthFields(input: {
  status: StageStatus;
  flags: Record<string, string>;
  existing: StageResult | null;
  now: string;
}): Pick<StageResult, 'intendedModel' | 'executedModel' | 'executionEvidence' | 'modelAttributionEligible' | 'modelAttributionIneligibleReason'> {
  const flagModel = nullableModel(input.flags.model);
  const intendedModel = nullableModel(input.flags['intended-model'])
    ?? flagModel
    ?? input.existing?.intendedModel
    ?? (input.flags.model === undefined ? input.existing?.model : undefined)
    ?? null;

  const explicitExecuted = nullableModel(input.flags['executed-model']);
  const mayPreserveExisting =
    explicitExecuted === undefined
    && (input.existing?.status === 'running' || input.existing?.status === 'awaiting_user')
    && (
      input.flags.model === undefined
      || input.existing.model === input.flags.model
      || input.existing.executedModel === input.flags.model
    );
  const executedModel = explicitExecuted !== undefined
    ? explicitExecuted
    : mayPreserveExisting
      ? input.existing?.executedModel ?? null
      : null;

  const explicitEvidenceStatus = input.flags['execution-evidence-status'];
  if (explicitEvidenceStatus !== undefined && !validEvidenceStatus(explicitEvidenceStatus)) {
    throw new Error(`invalid --execution-evidence-status '${explicitEvidenceStatus}'`);
  }
  const evidenceStatus = explicitEvidenceStatus
    ?? (executedModel ? (mayPreserveExisting ? input.existing?.executionEvidence?.status ?? 'direct' : 'direct') : 'missing');
  const evidenceSource = input.flags['execution-evidence-source']
    ?? (mayPreserveExisting ? input.existing?.executionEvidence?.source : undefined)
    ?? (executedModel ? 'stage-result-cli' : 'unknown');
  const executionEvidence = {
    status: evidenceStatus,
    source: evidenceSource,
    ...(input.flags['execution-evidence-detail'] !== undefined
      ? { detail: input.flags['execution-evidence-detail'] }
      : input.existing?.executionEvidence?.detail && mayPreserveExisting
        ? { detail: input.existing.executionEvidence.detail }
        : {}),
    recordedAt: input.now,
  };

  let modelAttributionEligible = boolFlag(input.flags['model-attribution-eligible']);
  let modelAttributionIneligibleReason = input.existing?.modelAttributionIneligibleReason;
  if (modelAttributionEligible === undefined) {
    if (input.status !== 'completed') {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'stage_not_completed';
    } else if (!executedModel) {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'missing_execution_evidence';
    } else if (evidenceStatus === 'contradicted') {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'execution_contradicted';
    } else if (intendedModel && intendedModel !== executedModel) {
      modelAttributionEligible = false;
      modelAttributionIneligibleReason = 'runtime_fallback';
    } else {
      modelAttributionEligible = true;
      modelAttributionIneligibleReason = undefined;
    }
  } else if (modelAttributionEligible) {
    modelAttributionIneligibleReason = undefined;
  } else {
    modelAttributionIneligibleReason ??= !executedModel ? 'missing_execution_evidence' : 'execution_contradicted';
  }

  return {
    intendedModel,
    executedModel,
    executionEvidence,
    modelAttributionEligible,
    ...(modelAttributionIneligibleReason ? { modelAttributionIneligibleReason } : {}),
  };
}

function cliAgent(value: string | undefined): value is 'claude' | 'codex' | 'claude-deepseek' {
  return value === 'claude' || value === 'codex' || value === 'claude-deepseek';
}

function preservesDirectEvidence(flags: Record<string, string>, existing: StageResult | null): boolean {
  if (flags['executed-model'] !== undefined || existing?.executionEvidence?.status !== 'direct') return false;
  return flags.model === undefined
    || existing.model === flags.model
    || existing.executedModel === flags.model;
}

/** Add fail-closed telemetry evidence to flags, while keeping explicit evidence authoritative. */
async function resolveExecutionEvidenceFlags(input: {
  flags: Record<string, string>;
  existing: StageResult | null;
  agent: string | undefined;
  startedAt: string | null;
  finishedAt: string | null;
}): Promise<void> {
  if (
    input.flags['resolve-executed-from-session'] === undefined
    || input.flags['executed-model'] !== undefined
    || !cliAgent(input.agent)
    || preservesDirectEvidence(input.flags, input.existing)
  ) return;
  const worktreePath = input.flags.worktree;
  const branchName = input.flags.branch;
  if (!worktreePath || !branchName) return;
  const evidence = await resolveStageExecutionEvidence({
    agentType: input.agent,
    worktreePath,
    branchName,
    windowStart: input.startedAt,
    windowEnd: input.finishedAt,
    repoDir: input.flags['repo-dir'] ?? worktreePath,
    ...(input.flags['claude-projects-dir'] ? { claudeProjectsDirs: input.flags['claude-projects-dir'].split(':') } : {}),
    ...(input.flags['codex-sessions-root'] ? { codexSessionsRoot: input.flags['codex-sessions-root'] } : {}),
  });
  input.flags['executed-model'] = evidence.executedModel ?? 'null';
  input.flags['execution-evidence-status'] = evidence.evidenceStatus;
  input.flags['execution-evidence-source'] = evidence.evidenceSource;
  input.flags['execution-evidence-detail'] = evidence.detail;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const subcommand = args[0];
  const featureDir = args[1];
  const stageArg = args[2];

  if (!featureDir) {
    console.error('Error: feature_dir is required');
    process.exit(1);
  }

  if (!stageArg) {
    console.error('Error: stage is required');
    process.exit(1);
  }

  if (!isValidStage(stageArg)) {
    console.error(`Error: invalid stage '${stageArg}'. Must be one of: planning, coding, review, ready`);
    process.exit(1);
  }

  const stage: StageName = stageArg;

  if (subcommand === 'read') {
    const result = await readStageResult(featureDir, stage);
    if (result) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // No result file — output nothing, exit 0 (caller checks empty stdout)
      process.exit(0);
    }
    return;
  }

  const flags = parseFlags(args.slice(3));

  if (subcommand === 'write' || subcommand === 'write-with-history') {
    const statusArg = args[3];
    if (!statusArg || !isValidStatus(statusArg)) {
      console.error(
        `Error: invalid status '${statusArg ?? '(missing)'}'. Must be one of: running, awaiting_user, completed, aborted, failed`,
      );
      process.exit(1);
    }

    // Re-parse flags from after the status positional
    const writeFlags = parseFlags(args.slice(4));
    const now = new Date().toISOString();
    const status: StageStatus = statusArg;

    const isTerminal = status === 'completed' || status === 'aborted' || status === 'failed';

    // Check if there's an existing file to preserve startedAt
    const existing = await readStageResult(featureDir, stage);
    const startedAt = writeFlags['started-at'] ?? existing?.startedAt ?? now;
    const finishedAt = writeFlags['finished-at'] ?? (isTerminal ? now : null);

    await resolveExecutionEvidenceFlags({
      flags: writeFlags,
      existing,
      agent: writeFlags.agent ?? existing?.agent,
      startedAt,
      finishedAt,
    });

    let artifacts: StageArtifacts | undefined;
    if (writeFlags['artifacts']) {
      try {
        artifacts = JSON.parse(writeFlags['artifacts']);
      } catch {
        console.error(`Error: --artifacts must be valid JSON`);
        process.exit(1);
      }
    }

    const result: StageResult = {
      stage,
      status,
      startedAt,
      finishedAt,
      agent: writeFlags['agent'] ?? existing?.agent ?? '',
      model: writeFlags['model'] ?? existing?.model ?? '',
      ...executionTruthFields({ status, flags: writeFlags, existing, now }),
      notes: writeFlags['notes'] ?? '',
      ...(artifacts !== undefined && { artifacts }),
      ...(writeFlags['failure-reason'] !== undefined && { failureReason: writeFlags['failure-reason'] }),
      ...(existing?.history?.length ? { history: existing.history } : {}),
    };

    if (subcommand === 'write-with-history') {
      await writeStageResultWithHistory(featureDir, stage, result);
    } else {
      await writeStageResult(featureDir, result);
    }
    return;
  }

  if (subcommand === 'update') {
    const updateFlags = parseFlags(args.slice(3));

    const patch: Partial<StageResult> = {};

    if (updateFlags['status']) {
      if (!isValidStatus(updateFlags['status'])) {
        console.error(`Error: invalid status '${updateFlags['status']}'`);
        process.exit(1);
      }
      patch.status = updateFlags['status'] as StageStatus;
    }
    if (updateFlags['agent'] !== undefined) patch.agent = updateFlags['agent'];
    if (updateFlags['model'] !== undefined) patch.model = updateFlags['model'];
    if (updateFlags['notes'] !== undefined) patch.notes = updateFlags['notes'];
    if (updateFlags['started-at'] !== undefined) patch.startedAt = updateFlags['started-at'];
    if (updateFlags['finished-at'] !== undefined) patch.finishedAt = updateFlags['finished-at'];
    if (updateFlags['failure-reason'] !== undefined) patch.failureReason = updateFlags['failure-reason'];
    if (
      updateFlags['intended-model'] !== undefined
      || updateFlags['executed-model'] !== undefined
      || updateFlags['execution-evidence-status'] !== undefined
      || updateFlags['execution-evidence-source'] !== undefined
      || updateFlags['execution-evidence-detail'] !== undefined
      || updateFlags['model-attribution-eligible'] !== undefined
      || updateFlags['resolve-executed-from-session'] !== undefined
    ) {
      const existing = await readStageResult(featureDir, stage);
      const status = (patch.status ?? existing?.status ?? 'running') as StageStatus;
      await resolveExecutionEvidenceFlags({
        flags: updateFlags,
        existing,
        agent: updateFlags.agent ?? existing?.agent,
        startedAt: updateFlags['started-at'] ?? existing?.startedAt ?? null,
        finishedAt: updateFlags['finished-at'] ?? (['completed', 'aborted', 'failed'].includes(status) ? new Date().toISOString() : null),
      });
      Object.assign(patch, executionTruthFields({
        status,
        flags: updateFlags,
        existing,
        now: new Date().toISOString(),
      }));
    }

    if (updateFlags['artifacts']) {
      try {
        patch.artifacts = JSON.parse(updateFlags['artifacts']);
      } catch {
        console.error(`Error: --artifacts must be valid JSON`);
        process.exit(1);
      }
    }

    // If updating to terminal status and no finishedAt provided, set it now
    if (patch.status && ['completed', 'aborted', 'failed'].includes(patch.status) && !patch.finishedAt) {
      patch.finishedAt = new Date().toISOString();
    }

    await updateStageResult(featureDir, stage, patch);
    return;
  }

  console.error(`Error: unknown subcommand '${subcommand}'. Use write, read, or update.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
