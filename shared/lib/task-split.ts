/**
 * Task split and size override (HOK-3469)
 *
 * The operator-facing half of the size hold: accepting a task's proposed slices
 * creates ordered sub-issues (each blocked by the one before it) and labels the
 * parent `wm:split`; overriding a hold labels the parent `wm:size-override`,
 * records the reason and leaves one audit comment.
 *
 * Both actions are recorded, idempotent (a second call refuses rather than
 * creating a duplicate split) and reuse the shared issue-creation helper.
 *
 * @module task-split
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  getIssue,
  getOrCreateLabel,
  addLabelsToIssue,
  updateIssue,
  createComment,
  type LinearIssue,
} from './linear.ts';
import {
  createIssuesWithDependencies,
  type CreateIssuesResult,
  type CreatedIssue,
  type IssueCreationSpec,
} from './plan-decomposer.ts';
import { normalizeIssueId } from './task-identity.ts';
import { getTaskSizeConfig } from './config.ts';
import {
  MIN_PROPOSED_SLICES,
  evaluateTaskSize,
  parseSizeSection,
  renderSizeSection,
  stripSizeSection,
  type TaskSizeEstimate,
  type TaskSizeSlice,
  type TaskSizeVerdict,
} from './task-size.ts';

/** Label that keeps a split parent held at the picker. */
export const SPLIT_LABEL = 'wm:split';
/** Label that releases one task's size hold. */
export const SIZE_OVERRIDE_LABEL = 'wm:size-override';
/** Repo-relative path of the override audit log. */
export const SIZE_OVERRIDE_LOG = path.join('.wavemill', 'size-overrides.jsonl');

/**
 * Labels that describe the parent's launch state rather than its subject.
 * Slices never inherit them: the operator accepted the split to proceed, so a
 * `wm:hold` on the parent must not hold every child.
 */
const CONTROL_LABELS = new Set([SPLIT_LABEL, SIZE_OVERRIDE_LABEL, 'wm:hold']);

/** A refusal the operator can act on (missing estimate, already split). */
export class TaskSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskSplitError';
  }
}

/** I/O seams, injectable for tests. */
export interface TaskSplitDeps {
  getIssue: (identifier: string) => Promise<LinearIssue>;
  createIssuesWithDependencies: (
    specs: IssueCreationSpec[],
    options: Parameters<typeof createIssuesWithDependencies>[1],
  ) => Promise<CreateIssuesResult>;
  getOrCreateLabel: (name: string, teamId: string, options?: { description?: string }) => Promise<{ id: string; name: string }>;
  addLabelsToIssue: (issueId: string, labelIds: string[]) => Promise<{ success: boolean }>;
  updateIssue: (issueId: string, input: { description?: string }) => Promise<{ success: boolean }>;
  createComment: (issueId: string, body: string) => Promise<unknown>;
}

export const defaultTaskSplitDeps: TaskSplitDeps = {
  getIssue,
  createIssuesWithDependencies,
  getOrCreateLabel,
  addLabelsToIssue,
  updateIssue,
  createComment,
};

export interface AcceptSplitOptions {
  /** Repository root, used for size limits and the override log. */
  repoDir?: string;
  deps?: Partial<TaskSplitDeps>;
  log?: (message: string) => void;
}

export interface AcceptSplitResult {
  parent: { id: string; identifier: string; title: string };
  created: CreatedIssue[];
}

function describeSlice(issue: LinearIssue, slice: TaskSizeSlice): string {
  const lines = [slice.scope.trim()];
  if (slice.files.length > 0) lines.push('', `Files: ${slice.files.join(', ')}`);
  if (slice.estimatedAddedLines !== null) {
    lines.push(`Estimated added lines: ${slice.estimatedAddedLines}`);
  }
  lines.push(
    '',
    `Part of ${issue.identifier}: ${issue.title}`,
    'Created by accepting the parent task\'s proposed size slices.',
  );
  return lines.join('\n');
}

function estimateFromParsed(parsed: NonNullable<ReturnType<typeof parseSizeSection>>): TaskSizeEstimate {
  return {
    addedLines: parsed.addedLines,
    files: parsed.files,
    coreFiles: parsed.coreFiles,
    linesSource: parsed.linesSource,
  };
}

/**
 * Create the task's proposed slices as sub-issues with ordered `blocks`
 * relations, label the parent `wm:split`, and record the accepted slice IDs in
 * packet §12.
 */
export async function acceptSplitProposal(
  issueRef: string,
  options: AcceptSplitOptions = {},
): Promise<AcceptSplitResult> {
  const deps: TaskSplitDeps = { ...defaultTaskSplitDeps, ...options.deps };
  const log = options.log ?? (() => {});
  const repoDir = options.repoDir ?? process.cwd();

  const linearId = normalizeIssueId(issueRef);
  if (!linearId) throw new TaskSplitError(`Not a Linear issue ID: ${issueRef}`);
  const issue = await deps.getIssue(linearId);
  const description = issue.description ?? '';
  const parsed = parseSizeSection(description);
  if (!parsed) {
    throw new TaskSplitError(
      `${issue.identifier} has no recorded size estimate. Run "wavemill expand ${issue.identifier}" first.`,
    );
  }

  const labelNames = (issue.labels?.nodes ?? []).map((label) => label.name);
  if (labelNames.includes(SPLIT_LABEL)) {
    const accepted = parsed.accepted.length > 0 ? ` into ${parsed.accepted.join(', ')}` : '';
    throw new TaskSplitError(`${issue.identifier} is already split${accepted}.`);
  }

  const slices = parsed.slices;
  if (slices.length < MIN_PROPOSED_SLICES) {
    throw new TaskSplitError(
      parsed.slicesUnavailable
        ? `${issue.identifier} has no proposed slices (the proposal step failed). Re-run "wavemill expand ${issue.identifier}".`
        : `${issue.identifier} has no proposed slices to accept.`,
    );
  }

  const inheritedLabelIds = (issue.labels?.nodes ?? [])
    .filter((label) => !CONTROL_LABELS.has(label.name))
    .map((label) => label.id);

  const specs: IssueCreationSpec[] = slices.map((slice, index) => ({
    title: slice.title,
    description: describeSlice(issue, slice),
    ...(typeof issue.priority === 'number' ? { priority: issue.priority } : {}),
    ...(inheritedLabelIds.length > 0 ? { labelIds: inheritedLabelIds } : {}),
    // Each slice merges on its own, in order: slice N is blocked by N-1.
    ...(index > 0 ? { blockedBy: [index - 1] } : {}),
  }));

  log(`Creating ${specs.length} slice(s) for ${issue.identifier}...`);
  const { created } = await deps.createIssuesWithDependencies(specs, {
    teamId: issue.team.id,
    ...(issue.project ? { projectId: issue.project.id } : {}),
    log,
  });

  // Record the accepted slice IDs so the picker can show what the parent
  // became, and refresh the verdict from the recorded numbers.
  const limits = getTaskSizeConfig(repoDir);
  const estimate = estimateFromParsed(parsed);
  const verdict = evaluateTaskSize(estimate, limits);
  const body = stripSizeSection(description).trimEnd();
  const section = renderSizeSection(estimate, verdict, slices, {
    accepted: created.map((child) => child.identifier),
  });
  try {
    await deps.updateIssue(issue.id, { description: `${body}\n\n${section}` });
  } catch (error) {
    log(`  ⚠ Could not record accepted slices on ${issue.identifier}: ${(error as Error).message}`);
  }

  try {
    const splitLabel = await deps.getOrCreateLabel(SPLIT_LABEL, issue.team.id, {
      description: 'Parent of a task split into independently mergeable slices (HOK-3469)',
    });
    const labelIds = [...new Set([...(issue.labels?.nodes ?? []).map((label) => label.id), splitLabel.id])];
    await deps.addLabelsToIssue(issue.id, labelIds);
  } catch (error) {
    log(`  ⚠ Could not label ${issue.identifier} ${SPLIT_LABEL}: ${(error as Error).message}`);
  }

  try {
    await deps.createComment(
      issue.id,
      `Split into ${created.map((child) => child.identifier).join(', ')}. ` +
        'Each slice is blocked by the one before it so they merge in order.',
    );
  } catch (error) {
    log(`  ⚠ Could not comment on ${issue.identifier}: ${(error as Error).message}`);
  }

  return {
    parent: { id: issue.id, identifier: issue.identifier, title: issue.title },
    created,
  };
}

export interface OverrideSizeOptions {
  repoDir?: string;
  deps?: Partial<TaskSplitDeps>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface OverrideSizeResult {
  issueId: string;
  reason: string;
  /** False when the task already carried the override label. */
  labelAdded: boolean;
  estimate: TaskSizeEstimate | null;
  verdict: TaskSizeVerdict | null;
}

/**
 * Release one task's size hold: label it `wm:size-override`, append a row to
 * `.wavemill/size-overrides.jsonl`, and leave one audit comment.
 */
export async function overrideSizeHold(
  issueRef: string,
  reason: string,
  options: OverrideSizeOptions = {},
): Promise<OverrideSizeResult> {
  const deps: TaskSplitDeps = { ...defaultTaskSplitDeps, ...options.deps };
  const log = options.log ?? (() => {});
  const repoDir = options.repoDir ?? process.cwd();
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new TaskSplitError('An override needs a reason.');

  const linearId = normalizeIssueId(issueRef);
  if (!linearId) throw new TaskSplitError(`Not a Linear issue ID: ${issueRef}`);
  const issue = await deps.getIssue(linearId);

  const parsed = parseSizeSection(issue.description ?? '');
  const limits = getTaskSizeConfig(repoDir);
  const estimate = parsed ? estimateFromParsed(parsed) : null;
  const verdict = estimate ? evaluateTaskSize(estimate, limits) : null;

  const labelNames = (issue.labels?.nodes ?? []).map((label) => label.name);
  if (labelNames.includes(SPLIT_LABEL)) {
    throw new TaskSplitError(
      `${issue.identifier} is already split; its slices carry the work, so there is no size hold to override.`,
    );
  }
  if (labelNames.includes(SIZE_OVERRIDE_LABEL)) {
    log(`${issue.identifier} already carries ${SIZE_OVERRIDE_LABEL}; nothing to record.`);
    return {
      issueId: issue.identifier,
      reason: trimmedReason,
      labelAdded: false,
      estimate,
      verdict,
    };
  }

  const overrideLabel = await deps.getOrCreateLabel(SIZE_OVERRIDE_LABEL, issue.team.id, {
    description: 'Operator released the task size hold for this task only (HOK-3469)',
  });
  const labelIds = [...new Set([...(issue.labels?.nodes ?? []).map((label) => label.id), overrideLabel.id])];
  await deps.addLabelsToIssue(issue.id, labelIds);

  const at = (options.now ?? (() => new Date()))().toISOString();
  const row = {
    issue: issue.identifier,
    at,
    reason: trimmedReason,
    estimatedLines: estimate?.addedLines ?? null,
    files: estimate?.files ?? [],
    oversized: verdict?.oversized ?? false,
    reasons: verdict?.reasons ?? [],
  };
  const logPath = path.join(repoDir, SIZE_OVERRIDE_LOG);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(row)}\n`);
  } catch (error) {
    log(`  ⚠ Could not write ${SIZE_OVERRIDE_LOG}: ${(error as Error).message}`);
  }

  try {
    await deps.createComment(
      issue.id,
      `Size hold overridden by the operator: ${trimmedReason}\n\n` +
        'The task may launch despite its size estimate. Recorded in `.wavemill/size-overrides.jsonl`.',
    );
  } catch (error) {
    log(`  ⚠ Could not comment on ${issue.identifier}: ${(error as Error).message}`);
  }

  return { issueId: issue.identifier, reason: trimmedReason, labelAdded: true, estimate, verdict };
}
