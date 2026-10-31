#!/usr/bin/env -S npx tsx
/**
 * Stage Result CLI — Shell-callable interface for stage result I/O (HOK-1192)
 *
 * Provides write/read/update subcommands so the shell orchestrator can manage
 * stage result files without constructing JSON via heredoc.
 *
 * HOK-3369: on `completed` status, every write path resolves the executed
 * model in-process through {@link resolveStageExecutedModel} — one resolver
 * for Claude Code / Codex / native, keyed on the ownership row rather than
 * the `agent` label. The shell gate (claude|codex) is gone.
 *
 * Usage:
 *   npx tsx tools/stage-result-cli.ts write <feature_dir> <stage> <status> [options]
 *   npx tsx tools/stage-result-cli.ts read  <feature_dir> <stage>
 *   npx tsx tools/stage-result-cli.ts update <feature_dir> <stage> [options]
 */

import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import {
  writeStageResult,
  writeStageResultWithHistory,
  readStageResult,
  updateStageResult,
  isValidStage,
  isValidStatus,
  executionTruthFields,
} from '../shared/lib/stage-result.ts';
import type {
  StageResult,
  StageName,
  StageStatus,
  StageArtifacts,
  StageExecutionEvidence,
} from '../shared/lib/stage-result.ts';
import { applyReviewAnalysisIdentity } from '../shared/lib/review-analysis-identity.ts';
import {
  resolveStageExecutedModel,
  type ResolvedStageExecutedModel,
} from '../shared/lib/executed-model-resolver.ts';
import {
  OWNERSHIP_STAGES,
  readOwnershipRows,
  rowsForStage,
  type OwnershipStage,
} from '../shared/lib/session-ownership.ts';

/**
 * Fold `review-changes`' head-keyed analysis identity into the review stage
 * result (HOK-3247). Every review result write — the pane agent's update and
 * the monitor's `write_stage_result` — goes through here, so the identity
 * never depends on the prompt telling the agent to copy it. Best-effort.
 */
async function mergeReviewIdentity(featureDir: string, stage: StageName): Promise<void> {
  if (stage !== 'review') return;
  try {
    await applyReviewAnalysisIdentity(featureDir);
  } catch (error) {
    console.error(`Warning: review analysis identity not merged: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * HOK-3369: resolve `{featureDir, stage, worktreePath, branchName, repoDir}`
 * inputs for the one evidence pipeline. The repo dir prefers the documented
 * mill env (`WAVEMILL_MILLED_REPO_DIR` / `REPO_DIR`), then the git common dir
 * of the worktree.
 */
function evidenceContext(featureDir: string, stage: StageName): {
  worktreePath: string;
  branchName: string | null;
  repoDir: string | undefined;
} {
  const absFeatureDir = resolvePath(featureDir);
  // features/<slug>/ → <slug>'s worktree root.
  const worktreePath = resolvePath(absFeatureDir, '..', '..');
  let branchName: string | null = null;
  try {
    branchName = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    branchName = null;
  }
  let repoDir: string | undefined = process.env.WAVEMILL_MILLED_REPO_DIR
    ?? process.env.REPO_DIR
    ?? undefined;
  if (!repoDir) {
    try {
      const gitCommonDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (gitCommonDir) {
        // `<repo>/.git` → `<repo>`; `<repo>/.git/worktrees/<name>` → `<repo>/.git` →
        // one more up to `<repo>`.
        const gitDirParent = resolvePath(gitCommonDir, '..');
        repoDir = gitDirParent;
      }
    } catch {
      // No git / out of tree: leave repoDir undefined.
    }
  }
  return { worktreePath, branchName, repoDir };
}

/**
 * HOK-3369: compute `latestLaunchAt` for the stage so `executionTruthFields`
 * knows whether existing evidence is from a prior attempt. Returns `null` for
 * stages without ownership rows (`ready`).
 */
function latestLaunchAtFor(featureDir: string, stage: StageName): string | null {
  if (!(OWNERSHIP_STAGES as readonly string[]).includes(stage)) return null;
  let rows;
  try {
    rows = rowsForStage(readOwnershipRows(featureDir), stage as OwnershipStage);
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const latest = [...rows]
    .map((row) => row.launchedAt)
    .filter((at): at is string => typeof at === 'string')
    .sort()
    .pop();
  return latest ?? null;
}

/**
 * HOK-3369: call the one resolver when the status is `completed` and no
 * explicit `--executed-model` flag was supplied. Resolver exceptions are
 * caught and surfaced as `missing` — a stage transition must never fail on
 * attribution.
 */
function maybeResolveExecutedModel(input: {
  featureDir: string;
  stage: StageName;
  status: StageStatus;
  flags: Record<string, string>;
  existing: StageResult | null;
}): ResolvedStageExecutedModel | null {
  if (input.status !== 'completed') return null;
  if (input.flags['executed-model'] !== undefined) return null;
  if (!(OWNERSHIP_STAGES as readonly string[]).includes(input.stage)) return null;
  const ctx = evidenceContext(input.featureDir, input.stage);
  if (!ctx.branchName) return null;
  try {
    return resolveStageExecutedModel({
      featureDir: input.featureDir,
      stage: input.stage as OwnershipStage,
      worktreePath: ctx.worktreePath,
      branchName: ctx.branchName,
      repoDir: ctx.repoDir,
      existing: input.existing,
      agentHint: input.flags['agent'] ?? input.existing?.agent,
    });
  } catch (error) {
    console.error(`Warning: executed-model resolver failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * HOK-3369: fold the resolver's answer into the CLI flags. `direct` /
 * `contradicted` adds explicit flags (so `executionTruthFields` replaces
 * evidence); `missing` is a no-op, so the merge rule keeps prior evidence.
 */
function applyResolvedToFlags(
  flags: Record<string, string>,
  resolved: ResolvedStageExecutedModel | null,
): Record<string, string> {
  if (!resolved) return flags;
  // The native resolver fast path returned the launcher's own evidence. Do
  // not turn it into new flags: that would bypass `keptEvidence` and restamp
  // its recordedAt field on every later stage-result write.
  if (resolved.preservedExisting) return flags;
  if (resolved.evidenceStatus === 'missing') {
    if (resolved.evidenceDetail) {
      console.error(`[stage-result-cli] resolver: ${resolved.evidenceDetail}`);
    }
    return flags;
  }
  const next: Record<string, string> = { ...flags };
  if (resolved.executedModel) {
    next['executed-model'] = resolved.executedModel;
  }
  next['execution-evidence-status'] = resolved.evidenceStatus;
  next['execution-evidence-source'] = resolved.evidenceSource;
  if (resolved.evidenceDetail) {
    next['execution-evidence-detail'] = resolved.evidenceDetail;
  }
  console.error(`[stage-result-cli] resolver: ${resolved.evidenceSource}; ${resolved.evidenceDetail}`);
  return next;
}

/**
 * HOK-3369: merge provider-response fields from the resolver into the
 * freshly-built evidence block. `executionTruthFields` returns the plain
 * block; the fields the launcher recorded (identityVerdict, requestedWireId,
 * certifiedTarget, providerReportedModel, responseId, transportProvider)
 * come from the resolver's `providerEvidence` and are merged here.
 */
function mergeProviderEvidence(
  base: Partial<StageResult>,
  resolved: ResolvedStageExecutedModel | null,
): Partial<StageResult> {
  if (!resolved?.providerEvidence) return base;
  if (!base.executionEvidence) return base;
  const existing = base.executionEvidence;
  const merged: StageExecutionEvidence = { ...existing };
  for (const [key, value] of Object.entries(resolved.providerEvidence)) {
    if (value !== undefined && (merged as Record<string, unknown>)[key] === undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return { ...base, executionEvidence: merged };
}

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
    let writeFlags = parseFlags(args.slice(4));
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

    // HOK-3369: one resolver for every harness, keyed on the ownership row.
    const resolved = maybeResolveExecutedModel({
      featureDir,
      stage,
      status,
      flags: writeFlags,
      existing,
    });
    writeFlags = applyResolvedToFlags(writeFlags, resolved);

    const ctx = evidenceContext(featureDir, stage);
    const latestLaunchAt = latestLaunchAtFor(featureDir, stage);
    const truth = executionTruthFields({
      status,
      flags: writeFlags,
      existing,
      now,
      latestLaunchAt,
      newAttempt: subcommand === 'write-with-history',
      repoDir: ctx.repoDir,
    });
    const withProviderFields = mergeProviderEvidence(truth, resolved);

    const result: StageResult = {
      stage,
      status,
      startedAt,
      finishedAt,
      agent: writeFlags['agent'] ?? existing?.agent ?? '',
      model: writeFlags['model'] ?? existing?.model ?? '',
      ...withProviderFields,
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
    await mergeReviewIdentity(featureDir, stage);
    return;
  }

  if (subcommand === 'update') {
    let updateFlags = parseFlags(args.slice(3));

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

    const existing = await readStageResult(featureDir, stage);
    const status = (patch.status ?? existing?.status ?? 'running') as StageStatus;
    const hasEvidenceFlag =
      updateFlags['intended-model'] !== undefined
      || updateFlags['executed-model'] !== undefined
      || updateFlags['execution-evidence-status'] !== undefined
      || updateFlags['execution-evidence-source'] !== undefined
      || updateFlags['execution-evidence-detail'] !== undefined
      || updateFlags['model-attribution-eligible'] !== undefined;

    // HOK-3369: run executionTruthFields whenever the resulting status is
    // `completed` OR an evidence flag was passed. `update --status completed`
    // (review-phase prompt) now routes through the one resolver too; without
    // flags, the merge rule keeps prior `direct` evidence as a whole block.
    if (status === 'completed' || hasEvidenceFlag) {
      const resolved = maybeResolveExecutedModel({
        featureDir,
        stage,
        status,
        flags: updateFlags,
        existing,
      });
      updateFlags = applyResolvedToFlags(updateFlags, resolved);
      const ctx = evidenceContext(featureDir, stage);
      const latestLaunchAt = latestLaunchAtFor(featureDir, stage);
      const truth = executionTruthFields({
        status,
        flags: updateFlags,
        existing,
        now: new Date().toISOString(),
        latestLaunchAt,
        repoDir: ctx.repoDir,
      });
      const withProviderFields = mergeProviderEvidence(truth, resolved);
      Object.assign(patch, withProviderFields);
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
    await mergeReviewIdentity(featureDir, stage);
    return;
  }

  console.error(`Error: unknown subcommand '${subcommand}'. Use write, read, or update.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
