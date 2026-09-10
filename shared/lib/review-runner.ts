/**
 * Review runner - Wrapper for review engine for local changes.
 *
 * Provides backward-compatible interface for reviewing local changes.
 * Delegates all review logic to shared/lib/review-engine.ts
 *
 * @module review-runner
 */

import { resolve } from 'node:path';
import {
  assertReviewableDiff,
  gatherReviewContextAsync,
  getCurrentBranch,
  getGitDiff,
} from './review-context-gatherer.ts';
import { runReview, type ReviewResult, type ReviewFinding, type ReviewerPersona } from './review-engine.ts';
import { ensureClaudeAvailable } from './llm-cli.ts';
import type { ReviewProgressReporter } from './review-progress.ts';
import type { OperatingMode } from './operating-mode.ts';
import { getIntegrationConfig, getReviewMergeConfig } from './config.ts';
import {
  detectCrossPrReverts,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
  type CrossPrRevertFinding,
} from './cross-pr-revert-detector.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  validateReviewScope,
  type ReviewScopeGuardFinding,
  type ReviewScopeGuardToolError,
} from './review-scope-guard.ts';
import { REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY } from './stage-result.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReviewOptions {
  /** Branch to diff against (default: "main") */
  targetBranch?: string;
  /** Repository directory (default: cwd) */
  repoDir?: string;
  /** Skip UI verification even if design context exists */
  skipUi?: boolean;
  /** Run only UI verification (skip code review) */
  uiOnly?: boolean;
  /** Print verbose output */
  verbose?: boolean;
  /** List of reviewer personas to run */
  reviewers?: ReviewerPersona[];
  /** Progress reporter for stderr milestones */
  reporter?: ReviewProgressReporter;
  /**
   * Commit SHA to scope the review from. When set, only changes after
   * this commit are reviewed, filtering out pre-existing branch changes.
   */
  sinceCommit?: string;
  /** Force normal vs degraded scoped-review behavior */
  operatingMode?: OperatingMode;
  /** Feature directory for stage-result cleanup reporting when available */
  featureDir?: string;
  /** Additional task-local context appended to the review prompt. */
  additionalContext?: string;
  /** Explicit reviewer model to pin for analysis (HOK-2969) */
  reviewerModel?: string;
}

// Re-export types from review-engine for backward compatibility
export type { ReviewFinding, ReviewResult, ReviewerPersona } from './review-engine.ts';

export const reviewRunnerDeps = {
  assertReviewableDiff,
  detectCrossPrReverts,
  ensureClaudeAvailable,
  execShellCommand,
  gatherReviewContextAsync,
  getCurrentBranch,
  getGitDiff,
  runReview,
  validateReviewScope,
};


// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Run a code review on the current branch.
 *
 * This is a backward-compatible wrapper that gathers local change context
 * and delegates to the shared review engine.
 *
 * @param options - Review configuration options
 * @returns ReviewResult with verdict and findings
 */
export async function reviewChanges(
  options: ReviewOptions = {}
): Promise<ReviewResult> {
  const targetBranch = options.targetBranch || 'main';
  const repoDir = options.repoDir ? resolve(options.repoDir) : process.cwd();
  const reporter = options.reporter;

  await reporter?.emit({
    event: 'preflight_start',
    message: `Checking git diff against ${targetBranch}`,
  });

  const branch = reviewRunnerDeps.getCurrentBranch(repoDir);
  const diff = reviewRunnerDeps.getGitDiff(targetBranch, repoDir, options.sinceCommit);
  reviewRunnerDeps.assertReviewableDiff(
    diff,
    branch,
    options.sinceCommit ? `commit ${options.sinceCommit.slice(0, 8)}` : targetBranch,
  );

  await reporter?.emit({
    event: 'preflight_ok',
    message: `Found committed changes against ${targetBranch}`,
    details: { branch },
  });

  if (!process.env.SKIP_PREFLIGHT_CHECK) {
    await reviewRunnerDeps.ensureClaudeAvailable({
      verbose: options.verbose,
      reporter,
    });
  }

  await reporter?.emit({
    event: 'context_loading',
    message: 'Loading review context',
  });

  // Gather review context (skip design standards if explicitly requested)
  const context = await reviewRunnerDeps.gatherReviewContextAsync(targetBranch, repoDir, {
    designStandards: !options.skipUi,
    sinceCommit: options.sinceCommit,
  });

  const deterministic = await collectDeterministicReviewFindings({
    repoDir,
    featureDir: options.featureDir,
    sinceCommit: options.sinceCommit,
  });
  const deterministicFindings = deterministic.findings;
  const reviewContextWithDeterministicFindings = deterministicFindings.length > 0
    ? {
      ...context,
      diff: prependCrossPrRevertContext(context.diff, deterministicFindings),
    }
    : context;
  const additionalContext = options.additionalContext?.trim();
  const reviewContext = additionalContext
    ? {
      ...reviewContextWithDeterministicFindings,
      taskPacket: [
        reviewContextWithDeterministicFindings.taskPacket,
        'Additional review context:',
        additionalContext,
      ].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join('\n\n'),
    }
    : reviewContextWithDeterministicFindings;

  await reporter?.emit({
    event: 'context_loaded',
    message: `Loaded review context for ${context.metadata.files.length} changed files`,
    details: {
      hasUiChanges: context.metadata.hasUiChanges,
      fileCount: context.metadata.files.length,
    },
  });

  // Delegate to review engine
  const result = await reviewRunnerDeps.runReview(reviewContext, repoDir, {
    skipUi: options.skipUi,
    verbose: options.verbose,
    reviewers: options.reviewers,
    reporter,
    skipClaudePreflight: true,
    operatingMode: options.operatingMode,
    featureDir: options.featureDir,
    reviewerModel: options.reviewerModel,
  });

  return mergeDeterministicFindings(result, deterministic);
}

interface DeterministicReviewFindings {
  findings: ReviewFinding[];
  /**
   * True when the review scope guard could not evaluate scope at all
   * (status 'error'). Surfaced on the ReviewResult as
   * `failureCategory: 'review-scope-unverifiable'` so the orchestrator's
   * infrastructure-retry path can act on it (HOK-2889). Never set for a
   * guard that ran and found violations.
   */
  scopeUnverifiable: boolean;
}

async function collectDeterministicReviewFindings(input: {
  repoDir: string;
  featureDir?: string;
  sinceCommit?: string;
}): Promise<DeterministicReviewFindings> {
  const scopeGuard = collectReviewScopeGuardFindings(input);
  const findings: ReviewFinding[] = [...scopeGuard.findings];
  findings.push(...await collectCrossPrRevertReviewFindings(input));
  return {
    findings: deduplicateReviewFindings(findings),
    scopeUnverifiable: scopeGuard.scopeUnverifiable,
  };
}

function collectReviewScopeGuardFindings(input: {
  repoDir: string;
  featureDir?: string;
  sinceCommit?: string;
}): DeterministicReviewFindings {
  // The guard always evaluates: without sinceCommit/featureDir it derives
  // scope from git (merge base against the integration branch), so there is
  // no "cannot evaluate" skip path any more (HOK-2887). Verified on this
  // branch: validateReviewScope with neither input returns ok with
  // baselineSource "git merge-base auto/integration".
  let result;
  try {
    result = reviewRunnerDeps.validateReviewScope({
      repoDir: input.repoDir,
      featureDir: input.featureDir,
      sinceCommit: input.sinceCommit,
      headRef: 'HEAD',
      includeWorkingTree: false,
      writeBaseline: true,
    });
  } catch (error) {
    // validateReviewScope's contract is to return status 'error' rather than
    // throw, but a crash here must degrade to "unverifiable", not take down
    // the whole review.
    return {
      findings: [buildScopeUnverifiableFinding({
        commandClass: 'review-scope-guard',
        command: 'validateReviewScope',
        stderr: error instanceof Error ? error.message : String(error),
      })],
      scopeUnverifiable: true,
    };
  }

  if (result.status === 'error') {
    // The guard could not verify scope (tool/git failure). "Cannot evaluate"
    // is not evidence of a violation, so this is a warning, never a blocker:
    // a blocker here poisons the verdict and permanently blocks the ready
    // gate with no retry (HOK-2889).
    return {
      findings: [
        ...result.findings.map(buildReviewScopeFinding),
        buildScopeUnverifiableFinding(result.toolError),
      ],
      scopeUnverifiable: true,
    };
  }

  return {
    findings: result.findings.map(buildReviewScopeFinding),
    scopeUnverifiable: false,
  };
}

async function collectCrossPrRevertReviewFindings(input: {
  repoDir: string;
  sinceCommit?: string;
}): Promise<ReviewFinding[]> {
  const reviewMergeConfig = getReviewMergeConfig(input.repoDir);
  if (!reviewMergeConfig.crossPrRevertCheck.enabled) {
    return [];
  }

  const integrationBranch = getIntegrationConfig(input.repoDir).integrationBranch;
  let baseRef: string;
  let findings: CrossPrRevertFinding[];

  try {
    baseRef = input.sinceCommit || String(reviewRunnerDeps.execShellCommand(
      `git merge-base ${escapeShellArg(integrationBranch)} HEAD`,
      { cwd: input.repoDir, encoding: 'utf-8' },
    )).trim();

    findings = reviewRunnerDeps.detectCrossPrReverts({
      repoDir: input.repoDir,
      baseRef,
      headRef: 'HEAD',
      integrationRef: integrationBranch,
      maxRecentMerges: reviewMergeConfig.crossPrRevertCheck.maxRecentMerges,
    });
  } catch (error) {
    return [buildCrossPrEvidenceUnavailableFinding(error)];
  }

  const acknowledgements = parseRevertAcknowledgements(loadRevertAcknowledgementText(input.repoDir));
  const unacknowledged = filterUnacknowledgedReverts(findings, acknowledgements);
  const filtered = filterRevertsAlreadyOnIntegration(
    unacknowledged,
    input.repoDir,
    integrationBranch,
  );

  return filtered.map(buildCrossPrRevertReviewFinding);
}

/**
 * Drop revert findings the branch did not introduce: when HEAD's blob for a
 * flagged path matches the integration tip's blob, the "revert" already
 * lives in the integration branch's own history (e.g. integration itself
 * reverted the PR), so merging this branch cannot regress that path.
 */
function filterRevertsAlreadyOnIntegration(
  reverts: CrossPrRevertFinding[],
  repoDir: string,
  integrationRef: string,
): CrossPrRevertFinding[] {
  return reverts
    .map((revert) => ({
      ...revert,
      files: revert.files.filter((file) => {
        const integrationBlob = lookupBlobAtRef(repoDir, integrationRef, file.path);
        const headBlob = lookupBlobAtRef(repoDir, 'HEAD', file.path);

        // An unreadable ref is not proof a path is unchanged, so a lookup
        // failure keeps the finding: this guard must fail closed.
        if (integrationBlob.kind === 'error' || headBlob.kind === 'error') {
          return true;
        }

        // A path that does not exist on integration cannot be reverted by this
        // branch -- there is no integration content to regress. Distinguishing
        // this from a failed lookup matters: `git rev-parse` reports both as an
        // empty result, so treating them alike either fails open on real errors
        // or fabricates blockers for files integration never had.
        if (integrationBlob.kind === 'absent') {
          return false;
        }

        // Present on integration but gone at HEAD is a deletion -- exactly the
        // case this guard exists to catch.
        if (headBlob.kind === 'absent') {
          return true;
        }

        return integrationBlob.id !== headBlob.id;
      }),
    }))
    .filter((revert) => revert.files.length > 0);
}

type BlobLookup =
  | { kind: 'blob'; id: string }
  | { kind: 'absent' }
  | { kind: 'error' };

/**
 * Resolve a path's blob at a ref, distinguishing "the ref is unreadable" from
 * "the ref is fine but does not contain this path".
 *
 * `git rev-parse --verify --quiet <ref>:<path>` reports both as an empty
 * result, which is why the ref itself is verified first.
 */
function lookupBlobAtRef(
  repoDir: string,
  ref: string,
  path: string,
): BlobLookup {
  try {
    reviewRunnerDeps.execShellCommand(
      `git rev-parse --verify --quiet ${escapeShellArg(`${ref}^{commit}`)}`,
      { cwd: repoDir, encoding: 'utf-8' },
    );
  } catch {
    return { kind: 'error' };
  }

  try {
    const blob = String(reviewRunnerDeps.execShellCommand(
      `git rev-parse --verify --quiet ${escapeShellArg(`${ref}:${path}`)}`,
      { cwd: repoDir, encoding: 'utf-8' },
    )).trim();
    return blob ? { kind: 'blob', id: blob } : { kind: 'absent' };
  } catch {
    // The ref resolved above, so a failure here means the path is not present.
    return { kind: 'absent' };
  }
}

function loadRevertAcknowledgementText(repoDir: string): string {
  try {
    return String(reviewRunnerDeps.execShellCommand(
      'gh pr view --json body,title,number --jq \'.title + "\\n" + (.body // "")\'',
      { cwd: repoDir, encoding: 'utf-8' },
    ));
  } catch {
    try {
      return String(reviewRunnerDeps.execShellCommand(
        'git log --format=%B -n 20 HEAD',
        { cwd: repoDir, encoding: 'utf-8' },
      ));
    } catch {
      return '';
    }
  }
}

function buildCrossPrRevertReviewFinding(finding: CrossPrRevertFinding): ReviewFinding {
  const paths = finding.files.map((file) => file.path);
  const changedKinds = finding.files.map((file) => `${file.path}:${file.confidence}`).join(', ');
  return {
    severity: 'blocker',
    location: paths.join(', ') || 'cross-pr-revert',
    category: 'cross-pr-revert',
    description:
      `This change appears to revert files changed by PR #${finding.prNumber}` +
      `${finding.title ? ` (${finding.title})` : ''}. ` +
      `Evidence: ${changedKinds}. ` +
      `Add an explicit acknowledgement like "Reverts #${finding.prNumber}" or ` +
      `"Intentionally reverts #${finding.prNumber}" for every affected PR.`,
  };
}

function buildCrossPrEvidenceUnavailableFinding(error: unknown): ReviewFinding {
  return {
    severity: 'blocker',
    location: 'cross-pr-revert',
    category: 'cross-pr-revert',
    description:
      'Unable to prove this branch does not revert recent integration work. ' +
      `Git evidence collection failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function buildReviewScopeFinding(finding: ReviewScopeGuardFinding): ReviewFinding {
  return {
    severity: finding.severity,
    location: finding.path ?? finding.category,
    category: finding.category,
    description: finding.message,
  };
}

function buildScopeUnverifiableFinding(toolError?: ReviewScopeGuardToolError): ReviewFinding {
  const detail = toolError
    ? ` (${toolError.commandClass}: ${toolError.stderr || `exit ${toolError.exitCode ?? 'unknown'}`})`
    : '';
  return {
    severity: 'warning',
    location: 'review-scope',
    category: 'review-scope',
    description:
      `Review scope could not be verified${detail}. ` +
      'This is a review-infrastructure condition, not a code defect: nothing was found wrong with the change. ' +
      `It is surfaced as failureCategory "${REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY}" so the orchestrator can retry the review.`,
  };
}

function prependCrossPrRevertContext(diff: string, findings: ReviewFinding[]): string {
  const advisory = [
    'Cross-PR revert detector findings:',
    ...findings.map((finding) => `- ${finding.description} [${finding.location}]`),
    '',
  ].join('\n');
  return `${advisory}${diff}`;
}

function mergeDeterministicFindings(
  result: ReviewResult,
  deterministic: DeterministicReviewFindings,
): ReviewResult {
  const { findings, scopeUnverifiable } = deterministic;
  // An existing category (e.g. native-runtime-unavailable) describes the
  // bigger failure and must win; only fill in the scope classification when
  // nothing else claimed the failure.
  const merged: ReviewResult = scopeUnverifiable
    ? { ...result, failureCategory: result.failureCategory ?? REVIEW_SCOPE_UNVERIFIABLE_FAILURE_CATEGORY }
    : result;
  if (findings.length === 0) {
    return merged;
  }

  const codeReviewFindings = deduplicateReviewFindings([
    ...findings,
    ...merged.codeReviewFindings,
  ]);

  return {
    ...merged,
    verdict: codeReviewFindings.some((finding) => finding.severity === 'blocker') ? 'not_ready' : merged.verdict,
    codeReviewFindings,
  };
}

function deduplicateReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const deduped = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = `${finding.severity}|${finding.location}|${finding.category}|${finding.description}`;
    if (!deduped.has(key)) {
      deduped.set(key, finding);
    }
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'blocker' ? -1 : 1;
    }
    return a.location.localeCompare(b.location);
  });
}
