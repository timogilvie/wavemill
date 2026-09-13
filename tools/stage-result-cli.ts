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
import type { StageResult, StageName, StageStatus, StageArtifacts, ExecutionEvidenceStatus } from '../shared/lib/stage-result.ts';

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

Examples:
  npx tsx tools/stage-result-cli.ts write features/my-feat planning running --agent claude --model opus-4-6
  npx tsx tools/stage-result-cli.ts read features/my-feat planning
  npx tsx tools/stage-result-cli.ts update features/my-feat planning --status completed --notes "Plan approved"
`;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1];
      i++; // skip value
    }
  }
  return flags;
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

    let artifacts: StageArtifacts | undefined;
    if (writeFlags['artifacts']) {
      try {
        artifacts = JSON.parse(writeFlags['artifacts']);
      } catch {
        console.error(`Error: --artifacts must be valid JSON`);
        process.exit(1);
      }
    }

    const VALID_EVIDENCE_STATUSES = ['confirmed', 'fallback', 'missing', 'contradicted'] as const;
    const evidenceStatus = writeFlags['execution-evidence-status'] as ExecutionEvidenceStatus | undefined;
    if (evidenceStatus && !(VALID_EVIDENCE_STATUSES as readonly string[]).includes(evidenceStatus)) {
      console.error(`Error: invalid --execution-evidence-status '${evidenceStatus}'`);
      process.exit(1);
    }

    const result: StageResult = {
      stage,
      status,
      startedAt,
      finishedAt,
      agent: writeFlags['agent'] ?? existing?.agent ?? '',
      model: writeFlags['model'] ?? existing?.model ?? '',
      notes: writeFlags['notes'] ?? '',
      ...(artifacts !== undefined && { artifacts }),
      ...(writeFlags['failure-reason'] !== undefined && { failureReason: writeFlags['failure-reason'] }),
      ...(existing?.history?.length ? { history: existing.history } : {}),
      ...(writeFlags['intended-model'] !== undefined && { intendedModel: writeFlags['intended-model'] }),
      ...(writeFlags['executed-model'] !== undefined && { executedModel: writeFlags['executed-model'] || null }),
      ...(evidenceStatus && { executionEvidenceStatus: evidenceStatus }),
      ...(writeFlags['quality-eligible'] !== undefined && { qualityEligible: writeFlags['quality-eligible'] === 'true' }),
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
