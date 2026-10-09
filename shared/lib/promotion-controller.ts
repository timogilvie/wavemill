import { writeFileSync } from 'fs';
import { confirm } from './cli-prompt.ts';
import { getIntegrationConfig, getPromotionConfig } from './config.ts';
import { detectSurvivingChangeWarnings, type CrossPrRevertFinding } from './cross-pr-revert-detector.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import { errorMessage } from './error-utils.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  defaultHealthChecker,
  waitForChecks,
  type CheckWaitResult,
  type HealthChecker,
  type IntegrationHealth,
} from './tend-controller.ts';

export interface PromotionResult {
  status: 'opened' | 'updated' | 'noop' | 'blocked';
  prUrl?: string;
  checkSummary?: string;
  squashRecovery?: {
    status: 'not-needed' | 'applied-in-place' | 'applied-via-promotion-head' | 'blocked';
    detail?: string;
  };
  blockReason?:
    | 'base-behind'
    | 'base-behind-conflicts'
    | 'base-unknown'
    | 'integration-diverged'
    | 'integration-unknown'
    | 'protected-integration-reconciliation-required'
    | 'promotion-head-update-failed';
  blockSummary?: string;
  infoSummary?: string;
  headBranch?: string;
}

export interface PromotionOptions {
  repoDir: string;
  dryRun?: boolean;
  shellRunner?: (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;
  healthChecker?: HealthChecker;
  confirmUpdate?: (message: string) => Promise<boolean>;
  interactive?: boolean;
}

type ShellRunner = NonNullable<PromotionOptions['shellRunner']>;

interface PromotionPr {
  number: number;
  url: string;
  body?: string;
}

interface MergedPrSummary {
  number: number;
  title: string;
  url?: string;
  mergedAt?: string;
  labels?: Array<{ name: string }>;
}

type PromotionBlockReason = NonNullable<PromotionResult['blockReason']>;

interface PromotionBaseState {
  remoteRef: string;
  tip: string;
}

interface BaseContainment {
  status: 'up-to-date' | 'behind';
}

interface IntegrationBranchState {
  localRef: string;
  remoteRef: string;
  localTip: string;
  remoteTip: string;
  status: 'up-to-date' | 'fast-forwarded';
}

type IntegrationBranchValidationResult =
  | { status: 'ready'; state: IntegrationBranchState }
  | {
    status: 'blocked';
    blockReason: Extract<PromotionBlockReason, 'integration-diverged' | 'integration-unknown'>;
    blockSummary: string;
  };

interface MergePrediction {
  status: 'clean' | 'conflicts' | 'unknown';
  detail?: string;
}

interface BranchProtectionStatus {
  state: 'unprotected' | 'protected' | 'unknown';
  allowsForcePush: boolean;
  requiresStatusChecks: boolean;
  restrictsDirectPush: boolean;
  reasonCode?: ProtectedIntegrationReasonCode;
}

type ProtectedIntegrationReasonCode =
  | 'protected'
  | 'force-push-disabled'
  | 'required-status-checks'
  | 'restricted-push'
  | 'protection-unknown';

type SquashReconciliationPlan =
  | {
    kind: 'reset-to-promotion-tip';
    integrationTip: string;
    promotionTip: string;
  }
  | {
    kind: 'synthetic-commit';
    integrationTip: string;
    promotionTip: string;
    commitMessage: string;
  };

export interface BranchBaseUpdateResult {
  status: 'success' | 'conflict' | 'push-failed' | 'fetch-failed' | 'dirty-worktree' | 'unknown-failed';
  detail: string;
  /**
   * On `conflict`, the unmerged file paths reported by `git diff --name-only
   * --diff-filter=U` immediately before `git merge --abort` (HOK-3092). Empty
   * when parsing failed. Absent for every non-conflict status.
   */
  conflictingFiles?: string[];
}

/** Commit-count distance between a branch and its base (HOK-3092 / HOK-3096). */
export interface BranchBaseDistance {
  /** Commits on `baseRef` not on `branch`; undefined when the count could not be determined. */
  behindBase?: number;
  /** Commits on `branch` not on `baseRef`; undefined when the count could not be determined. */
  aheadOfBase?: number;
  /** The ref the counts were computed against, when known. */
  baseRef?: string;
}

/**
 * Measure how far `branch` has diverged from `baseBranch`, reusing the same
 * `git rev-list --count` predicate `coding_compare_commit_counts` uses in
 * `wavemill-monitor.sh` (HOK-3092). Prefers `origin/<baseBranch>` and falls
 * back to the local `<baseBranch>` ref when no remote-tracking ref exists,
 * mirroring `inspectTaskBranchResidue` in `tools/observer.ts`.
 *
 * Never fetches: this reads whatever ref is already known locally, which
 * keeps it fast and deterministic for callers like the HOK-3096 observer
 * detectors that run across many tasks per cycle. Callers that need a fresh
 * remote view should fetch first (see `updateBranchWithBase`). Every git
 * failure degrades to `undefined` fields rather than throwing.
 */
export function measureBranchBaseDistance(
  branch: string,
  baseBranch: string,
  repoDir: string,
  shellRunner: ShellRunner = (cmd, opts) => String(execShellCommand(cmd, opts)),
): BranchBaseDistance {
  const countRevList = (range: string): number | undefined => {
    try {
      const raw = String(shellRunner(
        `git rev-list --count ${range}`,
        { encoding: 'utf-8', cwd: repoDir },
      )).trim();
      const count = Number.parseInt(raw, 10);
      return Number.isFinite(count) && count >= 0 ? count : undefined;
    } catch {
      return undefined;
    }
  };

  const tryRef = (ref: string): BranchBaseDistance | undefined => {
    const behindBase = countRevList(`${escapeShellArg(branch)}..${escapeShellArg(ref)}`);
    const aheadOfBase = countRevList(`${escapeShellArg(ref)}..${escapeShellArg(branch)}`);
    if (behindBase === undefined || aheadOfBase === undefined) return undefined;
    return { behindBase, aheadOfBase, baseRef: ref };
  };

  return tryRef(`origin/${baseBranch}`) ?? tryRef(baseBranch) ?? {};
}

const PROMOTION_SECTION_BEGIN = '<!-- wavemill-promote:begin -->';
const PROMOTION_SECTION_END = '<!-- wavemill-promote:end -->';
const RECENT_PR_LIMIT = 10;
const RECENT_COMMIT_LIMIT = 10;

export async function runPromotion(options: PromotionOptions): Promise<PromotionResult> {
  const shellRunner = options.shellRunner ?? ((cmd, opts) => String(execShellCommand(cmd, opts)));
  const healthChecker = options.healthChecker ?? defaultHealthChecker;
  const integrationConfig = getIntegrationConfig(options.repoDir);
  const promotionConfig = getPromotionConfig(options.repoDir);
  const integrationBranch = integrationConfig.integrationBranch;
  const promotionBranch = integrationConfig.promotionBranch;
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  const confirmUpdate = options.confirmUpdate ?? ((message: string) => confirm(message));

  const currentPr = findExistingPromotionPr(integrationBranch, promotionBranch, options.repoDir, shellRunner);
  let promotionBase: PromotionBaseState;
  try {
    promotionBase = fetchPromotionBase(promotionBranch, options.repoDir, shellRunner);
  } catch (error) {
    return buildBlockedPromotionResult({
      blockReason: 'base-unknown',
      blockSummary: formatBaseBehindSummary(
        'base-unknown',
        integrationBranch,
        remoteBranchRef(promotionBranch),
        errorMessage(error),
      ),
      prUrl: currentPr?.url,
      checkSummary: currentPr
        ? formatCheckSummary(await waitForChecks(
          currentPr.number,
          options.repoDir,
          shellRunner,
          { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
      ))
        : undefined,
    });
  }
  const integrationRefresh = refreshIntegrationBranch({
    integrationBranch,
    repoDir: options.repoDir,
    shellRunner,
    dryRun: options.dryRun,
  });
  if (integrationRefresh.status === 'blocked') {
    return buildBlockedPromotionResult({
      blockReason: integrationRefresh.blockReason,
      blockSummary: integrationRefresh.blockSummary,
      prUrl: currentPr?.url,
      checkSummary: currentPr
        ? formatCheckSummary(await waitForChecks(
          currentPr.number,
          options.repoDir,
          shellRunner,
          { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
        ))
        : undefined,
    });
  }
  let integrationTip = integrationRefresh.state.localTip;
  const expectedRemoteIntegrationTip = integrationRefresh.state.remoteTip;
  const promotionTip = promotionBase.tip;
  const promotionTree = resolveCommitTree(promotionTip, options.repoDir, shellRunner);
  const promotionTipIsIntegrated = isAncestor(promotionTip, integrationTip, options.repoDir, shellRunner);
  const matchingPromotionTreeCommit = promotionTipIsIntegrated
    ? null
    : findIntegrationCommitWithTree(
      integrationBranch,
      promotionTree,
      options.repoDir,
      shellRunner,
    );
  const baseContainment = classifyBaseContainment(
    promotionTip,
    integrationTip,
    options.repoDir,
    shellRunner,
  );

  if (baseContainment.status === 'behind' && !matchingPromotionTreeCommit) {
    const blockedResult = await handleBaseBehind({
      config: integrationConfig,
      integrationBranch,
      promotionBranch,
      promotionBase,
      integrationTip,
      repoDir: options.repoDir,
      shellRunner,
      currentPr,
      interactive,
      dryRun: options.dryRun,
      confirmUpdate,
    });

    if (blockedResult) {
      return blockedResult;
    }

    integrationTip = resolveBranchTip(integrationBranch, options.repoDir, shellRunner);
  }

  const comparisonBase =
    matchingPromotionTreeCommit && matchingPromotionTreeCommit !== integrationTip
      ? matchingPromotionTreeCommit
      : promotionBase.remoteRef;

  const reconciliationPlan = buildSquashReconciliationPlan({
    integrationBranch,
    integrationTip,
    promotionTip,
    promotionTree,
    matchingPromotionTreeCommit,
    repoDir: options.repoDir,
    shellRunner,
  });

  let effectiveHeadBranch = integrationBranch;
  let effectiveHeadTip = integrationTip;
  let infoSummary: string | undefined;
  let promotionNote: string | undefined;
  let squashRecovery: PromotionResult['squashRecovery'] = { status: 'not-needed' };

  if (reconciliationPlan) {
    const recoveryDetail = formatSquashRecoveryDetail({
      matchingPromotionTreeCommit,
      integrationBranch,
    });
    const protectionStatus = getBranchProtectionStatus(
      integrationBranch,
      options.repoDir,
      shellRunner,
    );

    if (protectionStatus.state === 'unknown') {
      return buildBlockedPromotionResult({
        blockReason: 'protected-integration-reconciliation-required',
        blockSummary: formatProtectedIntegrationBlockSummary({
          integrationBranch,
          promotionBranch,
          reasonCode: protectionStatus.reasonCode ?? 'protection-unknown',
          detail: 'Wavemill could not verify whether the integration branch allows the required reconciliation rewrite.',
        }),
        squashRecovery: {
          status: 'blocked',
          detail: recoveryDetail,
        },
        prUrl: currentPr?.url,
        checkSummary: currentPr
          ? formatCheckSummary(await waitForChecks(
            currentPr.number,
            options.repoDir,
            shellRunner,
            { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
          ))
          : undefined,
      });
    }

    const reconciliationAllowed =
      protectionStatus.state === 'unprotected' ||
      (
        protectionStatus.allowsForcePush &&
        !protectionStatus.requiresStatusChecks &&
        !protectionStatus.restrictsDirectPush
      );

    if (reconciliationAllowed) {
      effectiveHeadTip = applyIntegrationReconciliationPlan({
        plan: reconciliationPlan,
        integrationBranch,
        expectedRemoteTip: expectedRemoteIntegrationTip,
        repoDir: options.repoDir,
        shellRunner,
        dryRun: options.dryRun,
      });
      squashRecovery = {
        status: 'applied-in-place',
        detail: recoveryDetail,
      };
      promotionNote = `Squash reconciliation applied to ${integrationBranch} (${recoveryDetail}).`;
      infoSummary = `Applied squash reconciliation to ${integrationBranch} before promoting (${recoveryDetail}).`;
    } else if (promotionConfig.protectedIntegrationStrategy === 'block') {
      return buildBlockedPromotionResult({
        blockReason: 'protected-integration-reconciliation-required',
        blockSummary: formatProtectedIntegrationBlockSummary({
          integrationBranch,
          promotionBranch,
          reasonCode: protectionStatus.reasonCode ?? 'protected',
        }),
        squashRecovery: {
          status: 'blocked',
          detail: recoveryDetail,
        },
        prUrl: currentPr?.url,
        checkSummary: currentPr
          ? formatCheckSummary(await waitForChecks(
            currentPr.number,
            options.repoDir,
            shellRunner,
            { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
          ))
          : undefined,
      });
    } else if (promotionConfig.protectedIntegrationStrategy === 'use-promotion-head') {
      effectiveHeadBranch = promotionConfig.promotionHeadBranch;
      promotionNote =
        `Squash reconciliation applied via dedicated promotion head ${effectiveHeadBranch} because ${integrationBranch} is protected (${recoveryDetail}).`;
      infoSummary =
        `${integrationBranch} is protected; using dedicated promotion head ${effectiveHeadBranch} for squash reconciliation (${recoveryDetail}).`;

      const promotionHeadResult = applyPromotionHeadReconciliationPlan({
        plan: reconciliationPlan,
        promotionHeadBranch: effectiveHeadBranch,
        repoDir: options.repoDir,
        shellRunner,
        dryRun: options.dryRun,
      });

      if (typeof promotionHeadResult !== 'string') {
        return promotionHeadResult;
      }

      effectiveHeadTip = promotionHeadResult;
      squashRecovery = {
        status: 'applied-via-promotion-head',
        detail: `${recoveryDetail}; head=${effectiveHeadBranch}`,
      };
    } else {
      return buildBlockedPromotionResult({
        blockReason: 'protected-integration-reconciliation-required',
        blockSummary: formatProtectedIntegrationBlockSummary({
          integrationBranch,
          promotionBranch,
          reasonCode: protectionStatus.reasonCode ?? 'protected',
          detail: [
            `Detected a prior squash-merged snapshot (${recoveryDetail}), so updating the direct ${integrationBranch} -> ${promotionBranch} PR would be known-conflicted by ancestry.`,
            'Configure promotion.protectedIntegrationStrategy="use-promotion-head", keep it on "block" for explicit manual handling, or have an admin reconcile the integration branch before rerunning.',
          ].join(' '),
        }),
        squashRecovery: {
          status: 'blocked',
          detail: recoveryDetail,
        },
        prUrl: currentPr?.url,
        checkSummary: currentPr
          ? formatCheckSummary(await waitForChecks(
            currentPr.number,
            options.repoDir,
            shellRunner,
            { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
          ))
          : undefined,
        headBranch: integrationBranch,
      });
    }
  }

  if (isAlreadyPromoted(effectiveHeadTip, promotionBase.remoteRef, options.repoDir, shellRunner)) {
    return { status: 'noop' };
  }

  let health: IntegrationHealth;
  try {
    health = await healthChecker(integrationBranch, options.repoDir);
  } catch (error) {
    health = { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }

  const recentCommits = listRecentIntegrationCommits(comparisonBase, integrationBranch, options.repoDir, shellRunner);
  const recentPrs = listRecentMergedWavemillPrs(
    integrationBranch,
    extractPrNumbers(recentCommits),
    options.repoDir,
    shellRunner,
  );
  const survivingChangeWarnings = detectSurvivingChangeWarnings({
    repoDir: options.repoDir,
    baseRef: comparisonBase,
    headRef: promotionTip,
    integrationRef: integrationBranch,
    maxRecentMerges: RECENT_COMMIT_LIMIT,
    shellRunner,
  });
  const nextBody = updatePromotionSection(
    currentPr?.body ?? '',
    renderPromotionSection({
      integrationBranch,
      promotionBranch,
      health,
      promotionNote,
      recentPrs,
      recentCommits,
      survivingChangeWarnings,
    }),
  );

  const effectivePr = findExistingPromotionPr(
    effectiveHeadBranch,
    promotionBranch,
    options.repoDir,
    shellRunner,
  );
  const status: PromotionResult['status'] = effectivePr ? 'updated' : 'opened';
  if (!options.dryRun) {
    if (effectivePr) {
      updatePromotionPrBody(effectivePr.number, nextBody, shellRunner, options.repoDir);
    } else {
      const bodyFile = writeBodyToTempFile(nextBody, shellRunner, options.repoDir);
      try {
        const title = `chore: promote ${effectiveHeadBranch} to ${promotionBranch}`;
        shellRunner(
          [
            'gh',
            'pr',
            'create',
            '--head',
            escapeShellArg(effectiveHeadBranch),
            '--base',
            escapeShellArg(promotionBranch),
            '--title',
            escapeShellArg(title),
            '--body-file',
            escapeShellArg(bodyFile),
          ].join(' '),
          { encoding: 'utf-8', cwd: options.repoDir },
        );
      } finally {
        shellRunner(`rm -f ${escapeShellArg(bodyFile)}`, { encoding: 'utf-8', cwd: options.repoDir });
      }
    }
  }

  const promotionPr = effectivePr ?? findExistingPromotionPr(
    effectiveHeadBranch,
    promotionBranch,
    options.repoDir,
    shellRunner,
  );
  const checkSummary = promotionPr
    ? formatCheckSummary(await waitForChecks(
      promotionPr.number,
      options.repoDir,
      shellRunner,
      { timeoutMs: 0, requiredChecks: integrationConfig.requiredChecks },
    ))
    : undefined;

  return {
    status,
    prUrl: promotionPr?.url,
    checkSummary,
    infoSummary,
    headBranch: effectiveHeadBranch,
    squashRecovery,
  };
}

function fetchPromotionBase(
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): PromotionBaseState {
  try {
    shellRunner(
      `git fetch --quiet origin ${escapeShellArg(promotionBranch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    throw new Error(`promote: failed to fetch origin/${promotionBranch}: ${errorMessage(error)}`);
  }

  const remoteRef = remoteBranchRef(promotionBranch);
  try {
    return {
      remoteRef,
      tip: resolveBranchTip(remoteRef, repoDir, shellRunner),
    };
  } catch {
    throw new Error(`promote: remote promotion branch not found: ${remoteRef}`);
  }
}

function remoteBranchRef(branch: string): string {
  return `origin/${branch}`;
}

function resolveBranchTip(
  branch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string {
  try {
    return String(shellRunner(
      `git rev-parse ${escapeShellArg(branch)} 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
  } catch {
    throw new Error(`promote: branch not found: ${branch}`);
  }
}

function classifyBaseContainment(
  promotionTip: string,
  integrationTip: string,
  repoDir: string,
  shellRunner: ShellRunner,
): BaseContainment {
  return isAncestor(promotionTip, integrationTip, repoDir, shellRunner)
    ? { status: 'up-to-date' }
    : { status: 'behind' };
}

function refreshIntegrationBranch(input: {
  integrationBranch: string;
  repoDir: string;
  shellRunner: ShellRunner;
  dryRun?: boolean;
}): IntegrationBranchValidationResult {
  const remoteRef = remoteBranchRef(input.integrationBranch);
  const localRef = `refs/heads/${input.integrationBranch}`;

  try {
    input.shellRunner(
      `git fetch --quiet origin ${escapeShellArg(input.integrationBranch)}`,
      { encoding: 'utf-8', cwd: input.repoDir },
    );
  } catch (error) {
    return {
      status: 'blocked',
      blockReason: 'integration-unknown',
      blockSummary: `failed to fetch ${remoteRef}: ${errorMessage(error)}`,
    };
  }

  let remoteTip: string;
  let localTip: string;
  try {
    remoteTip = resolveBranchTip(remoteRef, input.repoDir, input.shellRunner);
  } catch (error) {
    return {
      status: 'blocked',
      blockReason: 'integration-unknown',
      blockSummary: `unable to resolve remote integration ref ${remoteRef}: ${errorMessage(error)}`,
    };
  }

  try {
    localTip = resolveBranchTip(input.integrationBranch, input.repoDir, input.shellRunner);
  } catch (error) {
    return {
      status: 'blocked',
      blockReason: 'integration-unknown',
      blockSummary: `unable to resolve local integration ref ${input.integrationBranch}: ${errorMessage(error)}`,
    };
  }

  if (localTip === remoteTip) {
    return {
      status: 'ready',
      state: {
        localRef,
        remoteRef,
        localTip,
        remoteTip,
        status: 'up-to-date',
      },
    };
  }

  const localBehindRemote = isAncestor(localTip, remoteTip, input.repoDir, input.shellRunner);
  const remoteBehindLocal = isAncestor(remoteTip, localTip, input.repoDir, input.shellRunner);

  if (localBehindRemote && !remoteBehindLocal) {
    if (input.dryRun) {
      return {
        status: 'blocked',
        blockReason: 'integration-unknown',
        blockSummary: formatIntegrationBranchNeedsUpdateSummary(
          input.integrationBranch,
          localTip,
          remoteTip,
          true,
        ),
      };
    }

    const currentBranch = resolveCurrentBranch(input.repoDir, input.shellRunner);
    try {
      if (currentBranch === input.integrationBranch) {
        input.shellRunner(
          `git merge --ff-only ${escapeShellArg(remoteRef)}`,
          { encoding: 'utf-8', cwd: input.repoDir },
        );
      } else {
        input.shellRunner(
          `git update-ref ${escapeShellArg(localRef)} ${escapeShellArg(remoteTip)} ${escapeShellArg(localTip)}`,
          { encoding: 'utf-8', cwd: input.repoDir },
        );
      }
    } catch (error) {
      return {
        status: 'blocked',
        blockReason: 'integration-unknown',
        blockSummary: `failed to fast-forward local integration ref ${input.integrationBranch} from ${localTip} to ${remoteTip}: ${errorMessage(error)}`,
      };
    }

    return {
      status: 'ready',
      state: {
        localRef,
        remoteRef,
        localTip: remoteTip,
        remoteTip,
        status: 'fast-forwarded',
      },
    };
  }

  return {
    status: 'blocked',
    blockReason: 'integration-diverged',
    blockSummary: formatIntegrationBranchNeedsUpdateSummary(
      input.integrationBranch,
      localTip,
      remoteTip,
      false,
    ),
  };
}

function isAlreadyPromoted(
  integrationTip: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(integrationTip)} ${escapeShellArg(promotionBranch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return true;
  } catch {
    return false;
  }
}

function isAncestor(
  ancestor: string,
  descendant: string,
  repoDir: string,
  shellRunner: ShellRunner,
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(ancestor)} ${escapeShellArg(descendant)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return true;
  } catch {
    return false;
  }
}

function buildSquashReconciliationPlan(input: {
  integrationBranch: string;
  integrationTip: string;
  promotionTip: string;
  promotionTree: string;
  matchingPromotionTreeCommit: string | null;
  repoDir: string;
  shellRunner: ShellRunner;
}): SquashReconciliationPlan | null {
  const integrationTree = resolveCommitTree(input.integrationTip, input.repoDir, input.shellRunner);
  const matchingIntegrationCommit = input.matchingPromotionTreeCommit;

  if (!matchingIntegrationCommit) {
    return null;
  }

  if (integrationTree === input.promotionTree) {
    return {
      kind: 'reset-to-promotion-tip',
      integrationTip: input.integrationTip,
      promotionTip: input.promotionTip,
    };
  }

  if (matchingIntegrationCommit === input.integrationTip) {
    return null;
  }

  return {
    kind: 'synthetic-commit',
    integrationTip: input.integrationTip,
    promotionTip: input.promotionTip,
    commitMessage: `chore: reconcile ${input.integrationBranch} after squash promotion`,
  };
}

function applyIntegrationReconciliationPlan(input: {
  plan: SquashReconciliationPlan;
  integrationBranch: string;
  expectedRemoteTip: string;
  repoDir: string;
  shellRunner: ShellRunner;
  dryRun?: boolean;
}): string {
  const targetTip = materializeReconciliationTarget(
    input.plan,
    input.repoDir,
    input.shellRunner,
    input.dryRun,
  );

  if (input.dryRun) {
    return targetTip;
  }

  const branchRef = `refs/heads/${input.integrationBranch}`;
  input.shellRunner(
    `git update-ref ${escapeShellArg(branchRef)} ${escapeShellArg(targetTip)} ${escapeShellArg(input.plan.integrationTip)}`,
    { encoding: 'utf-8', cwd: input.repoDir },
  );
  pushBranchRefWithLocalRollback({
    branchRef,
    localTipBeforePush: targetTip,
    restoreTip: input.plan.integrationTip,
    expectedRemoteTip: input.expectedRemoteTip,
    repoDir: input.repoDir,
    shellRunner: input.shellRunner,
    integrationBranch: input.integrationBranch,
  });
  return targetTip;
}

function applyPromotionHeadReconciliationPlan(input: {
  plan: SquashReconciliationPlan;
  promotionHeadBranch: string;
  repoDir: string;
  shellRunner: ShellRunner;
  dryRun?: boolean;
}): string | PromotionResult {
  const targetTip = materializeReconciliationTarget(
    input.plan,
    input.repoDir,
    input.shellRunner,
    input.dryRun,
  );

  if (input.dryRun) {
    return targetTip;
  }

  const branchRef = `refs/heads/${input.promotionHeadBranch}`;
  input.shellRunner(
    `git update-ref ${escapeShellArg(branchRef)} ${escapeShellArg(targetTip)}`,
    { encoding: 'utf-8', cwd: input.repoDir },
  );

  try {
    pushBranchRefNormally(branchRef, input.repoDir, input.shellRunner);
  } catch (error) {
    return buildBlockedPromotionResult({
      blockReason: 'promotion-head-update-failed',
      blockSummary: formatPromotionHeadPushFailure(input.promotionHeadBranch, error),
      headBranch: input.promotionHeadBranch,
    });
  }

  return targetTip;
}

function materializeReconciliationTarget(
  plan: SquashReconciliationPlan,
  repoDir: string,
  shellRunner: ShellRunner,
  dryRun?: boolean,
): string {
  if (plan.kind === 'reset-to-promotion-tip') {
    return plan.promotionTip;
  }

  if (dryRun) {
    return plan.integrationTip;
  }

  return String(shellRunner(
    [
      'git',
      'commit-tree',
      escapeShellArg(`${plan.integrationTip}^{tree}`),
      '-p',
      escapeShellArg(plan.promotionTip),
      '-m',
      escapeShellArg(plan.commitMessage),
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
}

async function handleBaseBehind(input: {
  config: ReturnType<typeof getIntegrationConfig>;
  integrationBranch: string;
  promotionBranch: string;
  promotionBase: PromotionBaseState;
  integrationTip: string;
  repoDir: string;
  shellRunner: ShellRunner;
  currentPr: PromotionPr | null;
  interactive: boolean;
  dryRun?: boolean;
  confirmUpdate: (message: string) => Promise<boolean>;
}): Promise<PromotionResult | null> {
  const prediction = predictPromotionBaseMerge(
    input.integrationBranch,
    input.promotionBase.remoteRef,
    input.repoDir,
    input.shellRunner,
  );

  if (!input.dryRun && prediction.status === 'clean') {
    const shouldUpdate =
      input.config.autoUpdatePromotionBranch ||
      (input.interactive && await input.confirmUpdate(formatBaseBehindPrompt(
        input.integrationBranch,
        input.promotionBase.remoteRef,
      )));

    if (shouldUpdate) {
      try {
        updateIntegrationWithPromotionBase(
          input.integrationBranch,
          input.promotionBranch,
          input.repoDir,
          input.shellRunner,
        );
        return null;
      } catch (error) {
        return buildBlockedPromotionResult({
          blockReason: 'base-unknown',
          blockSummary: formatBaseBehindSummary(
            'base-unknown',
            input.integrationBranch,
            input.promotionBase.remoteRef,
            errorMessage(error),
          ),
          prUrl: input.currentPr?.url,
          checkSummary: input.currentPr
            ? formatCheckSummary(await waitForChecks(
              input.currentPr.number,
              input.repoDir,
              input.shellRunner,
              { timeoutMs: 0, requiredChecks: input.config.requiredChecks },
            ))
            : undefined,
        });
      }
    }
  }

  let blockReason: PromotionBlockReason = 'base-behind';
  if (prediction.status === 'conflicts') {
    blockReason = 'base-behind-conflicts';
  } else if (prediction.status === 'unknown') {
    blockReason = 'base-unknown';
  }

  return buildBlockedPromotionResult({
    blockReason,
    blockSummary: formatBaseBehindSummary(
      blockReason,
      input.integrationBranch,
      input.promotionBase.remoteRef,
      prediction.detail,
    ),
    prUrl: input.currentPr?.url,
    checkSummary: input.currentPr
      ? formatCheckSummary(await waitForChecks(
        input.currentPr.number,
        input.repoDir,
        input.shellRunner,
        { timeoutMs: 0, requiredChecks: input.config.requiredChecks },
      ))
      : undefined,
  });
}

function predictPromotionBaseMerge(
  integrationBranch: string,
  promotionRemoteRef: string,
  repoDir: string,
  shellRunner: ShellRunner,
): MergePrediction {
  try {
    shellRunner(
      `git merge-tree --write-tree ${escapeShellArg(integrationBranch)} ${escapeShellArg(promotionRemoteRef)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return { status: 'clean' };
  } catch (error) {
    const message = errorMessage(error);
    // `git merge-tree --write-tree` exits 1 when the trees conflict, writing the
    // conflicted-file list to stdout rather than stderr. execSync therefore throws
    // an error whose message is only "Command failed: git merge-tree ..." with no
    // "conflict" substring, so we must classify by exit status (1 => conflicts) and
    // keep the string match as a fallback for runners that surface git's text.
    // Any other status (128, command-not-found, ...) is a genuine "unknown" failure.
    if (execExitStatus(error) === 1 || /conflict/i.test(message)) {
      return { status: 'conflicts', detail: message };
    }
    return { status: 'unknown', detail: message };
  }
}

/**
 * Extract the process exit status from a thrown execSync/child_process error,
 * or null when it is not an exec error (e.g. a synthetic Error).
 */
function execExitStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

export function updateBranchWithBase(
  branch: string,
  baseBranch: string,
  repoDir: string,
  shellRunner: ShellRunner = (cmd, opts) => String(execShellCommand(cmd, opts)),
): BranchBaseUpdateResult {
  const dirtyState = String(shellRunner(
    'git status --porcelain --untracked-files=no',
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
  if (dirtyState) {
    return {
      status: 'dirty-worktree',
      detail: `refusing to update ${branch} because the worktree has uncommitted changes`,
    };
  }

  try {
    shellRunner(
      `git fetch --quiet origin ${escapeShellArg(baseBranch)} ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    return {
      status: 'fetch-failed',
      detail: `failed to fetch origin/${baseBranch}: ${errorMessage(error)}`,
    };
  }

  try {
    shellRunner(
      `git switch ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    return {
      status: 'unknown-failed',
      detail: errorMessage(error),
    };
  }

  // Sync the local branch with its remote tip before merging base into it. A
  // stale local branch would otherwise produce a merge built on an old tip
  // (which then fails as non-fast-forward on push) or, worse, silently
  // publish an out-of-date state. When local and origin have diverged, we
  // stop and let the operator resolve it rather than force any move.
  try {
    shellRunner(
      `git rev-parse --verify --quiet ${escapeShellArg(`${remoteBranchRef(branch)}^{commit}`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    try {
      shellRunner(
        `git merge --ff-only ${escapeShellArg(remoteBranchRef(branch))}`,
        { encoding: 'utf-8', cwd: repoDir },
      );
    } catch (ffError) {
      return {
        status: 'unknown-failed',
        detail: `local ${branch} has diverged from ${remoteBranchRef(branch)} and cannot be fast-forwarded: ${errorMessage(ffError)}`,
      };
    }
  } catch {
    // No remote counterpart yet — proceed without syncing.
  }

  try {
    shellRunner(
      `git merge-tree --write-tree ${escapeShellArg(branch)} ${escapeShellArg(remoteBranchRef(baseBranch))}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    shellRunner(
      `git merge --no-edit ${escapeShellArg(remoteBranchRef(baseBranch))}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } catch (error) {
    const detail = errorMessage(error);
    // HOK-3092: capture the unmerged file list before aborting so callers can
    // surface it in the operator-facing attention file. Best-effort — a
    // failing enumerate never masks the original merge failure.
    let conflictingFiles: string[] = [];
    if (/conflict/i.test(detail)) {
      try {
        const raw = String(shellRunner(
          'git diff --name-only --diff-filter=U',
          { encoding: 'utf-8', cwd: repoDir },
        ));
        conflictingFiles = raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      } catch {
        // Best-effort: leave the list empty and rely on `detail`.
      }
    }
    try {
      shellRunner('git merge --abort', { encoding: 'utf-8', cwd: repoDir });
    } catch {
      // Best-effort cleanup if merge started.
    }

    if (/conflict/i.test(detail)) {
      return {
        status: 'conflict',
        detail,
        conflictingFiles,
      };
    }
    return {
      status: 'unknown-failed',
      detail,
    };
  }

  try {
    shellRunner(
      `git push origin ${escapeShellArg(branch)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    return {
      status: 'success',
      detail: `updated ${branch} with origin/${baseBranch} and pushed successfully`,
    };
  } catch (error) {
    return {
      status: 'push-failed',
      detail: errorMessage(error),
    };
  }
}

function updateIntegrationWithPromotionBase(
  integrationBranch: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): void {
  const result = updateBranchWithBase(integrationBranch, promotionBranch, repoDir, shellRunner);
  if (result.status !== 'success') {
    throw new Error(`promote: ${result.detail}`);
  }
}

function resolveCurrentBranch(
  repoDir: string,
  shellRunner: ShellRunner,
): string | null {
  try {
    const branch = String(shellRunner(
      'git symbolic-ref --quiet --short HEAD',
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
    return branch || null;
  } catch {
    return null;
  }
}

function formatBaseBehindPrompt(
  integrationBranch: string,
  promotionRemoteRef: string,
): string {
  return `Promotion is blocked because ${integrationBranch} is behind protected base ${promotionRemoteRef}. Merge and push the latest base now?`;
}

function formatBaseBehindSummary(
  reason: PromotionBlockReason,
  integrationBranch: string,
  promotionRemoteRef: string,
  detail?: string,
): string {
  if (reason === 'base-behind-conflicts') {
    return [
      `${integrationBranch} has diverged from protected base ${promotionRemoteRef}; merging ${promotionRemoteRef} into ${integrationBranch} is expected to conflict`,
      `likely cause: ${promotionRemoteRef} received commits that did not flow through ${integrationBranch} (e.g. a PR merged with base=main), or a squash promotion left no matching tree to auto-reconcile`,
      `remediation: open a PR merging ${promotionRemoteRef} into ${integrationBranch}, resolve the conflicts, merge it, then rerun wavemill promote`,
    ].join('; ');
  }
  if (reason === 'base-unknown') {
    return detail
      ? `unable to verify or update protected base ${promotionRemoteRef}: ${detail}`
      : `unable to verify protected base ${promotionRemoteRef}`;
  }
  return `branch behind protected base; merge ${promotionRemoteRef} into ${integrationBranch} and push before promoting`;
}

function formatIntegrationBranchNeedsUpdateSummary(
  integrationBranch: string,
  localTip: string,
  remoteTip: string,
  needsFastForward: boolean,
): string {
  const remediation = `git fetch origin && git branch -f ${integrationBranch} origin/${integrationBranch}`;
  if (needsFastForward) {
    return [
      `local integration branch ${integrationBranch} is behind origin/${integrationBranch}`,
      `local=${localTip}`,
      `remote=${remoteTip}`,
      `update the local integration ref before promoting: ${remediation}`,
    ].join('; ');
  }
  return [
    `local integration branch ${integrationBranch} diverged from origin/${integrationBranch}`,
    `local=${localTip}`,
    `remote=${remoteTip}`,
    `update or discard the local integration ref before promoting: ${remediation}`,
  ].join('; ');
}

function buildBlockedPromotionResult(input: {
  blockReason: PromotionBlockReason;
  blockSummary: string;
  prUrl?: string;
  checkSummary?: string;
  headBranch?: string;
  squashRecovery?: PromotionResult['squashRecovery'];
}): PromotionResult {
  return {
    status: 'blocked',
    blockReason: input.blockReason,
    blockSummary: input.blockSummary,
    prUrl: input.prUrl,
    checkSummary: input.checkSummary,
    headBranch: input.headBranch,
    squashRecovery: input.squashRecovery,
  };
}

function formatSquashRecoveryDetail(input: {
  matchingPromotionTreeCommit: string | null;
  integrationBranch: string;
}): string {
  if (!input.matchingPromotionTreeCommit) {
    return `no matching promoted snapshot found on ${input.integrationBranch}`;
  }
  return `matched promoted snapshot ${input.matchingPromotionTreeCommit} on ${input.integrationBranch}`;
}

function resolveCommitTree(
  commitish: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string {
  return String(shellRunner(
    `git rev-parse ${escapeShellArg(`${commitish}^{tree}`)}`,
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
}

function findIntegrationCommitWithTree(
  integrationBranch: string,
  tree: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string | null {
  const output = String(shellRunner(
    `git log --format='%H %T' ${escapeShellArg(integrationBranch)}`,
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();

  for (const line of output.split(/\r?\n/)) {
    const [commit, commitTree] = line.trim().split(/\s+/, 2);
    if (commit && commitTree === tree) {
      return commit;
    }
  }
  return null;
}

function pushBranchRef(
  branchRef: string,
  expectedRemoteTip: string,
  repoDir: string,
  shellRunner: ShellRunner,
): void {
  shellRunner(
    [
      'git',
      'push',
      `--force-with-lease=${escapeShellArg(`${branchRef}:${expectedRemoteTip}`)}`,
      'origin',
      escapeShellArg(`${branchRef}:${branchRef}`),
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function pushBranchRefNormally(
  branchRef: string,
  repoDir: string,
  shellRunner: ShellRunner,
): void {
  shellRunner(
    [
      'git',
      'push',
      'origin',
      escapeShellArg(`${branchRef}:${branchRef}`),
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  );
}

function pushBranchRefWithLocalRollback(input: {
  branchRef: string;
  localTipBeforePush: string;
  restoreTip: string;
  expectedRemoteTip: string;
  repoDir: string;
  shellRunner: ShellRunner;
  integrationBranch: string;
}): void {
  try {
    pushBranchRef(input.branchRef, input.expectedRemoteTip, input.repoDir, input.shellRunner);
  } catch (error) {
    try {
      input.shellRunner(
        `git update-ref ${escapeShellArg(input.branchRef)} ${escapeShellArg(input.restoreTip)} ${escapeShellArg(input.localTipBeforePush)}`,
        { encoding: 'utf-8', cwd: input.repoDir },
      );
    } catch (rollbackError) {
      throw new Error(formatProtectedBranchPushFailure(input.integrationBranch, error, rollbackError));
    }
    throw new Error(formatProtectedBranchPushFailure(input.integrationBranch, error));
  }
}

function formatProtectedBranchPushFailure(
  integrationBranch: string,
  pushError: unknown,
  rollbackError?: unknown,
): string {
  const message = errorMessage(pushError);
  const likelyProtectedBranch =
    message.includes('GH006') ||
    message.includes('Protected branch update failed') ||
    message.includes('Cannot force-push');
  const rollbackNote = rollbackError
    ? `\n\nAlso failed to restore the local branch ref: ${errorMessage(rollbackError)}`
    : '\n\nThe local branch ref was restored to its pre-promote tip.';

  if (!likelyProtectedBranch) {
    return `promote: failed to push reconciled integration branch: ${message}${rollbackNote}`;
  }

  return [
    `promote: GitHub rejected the required reconciliation push to protected branch \`${integrationBranch}\`.`,
    '',
    'Why: the promotion branch appears to already contain an earlier squash-merged snapshot, so Wavemill tried to rewrite the integration branch onto the current promotion branch before opening/updating the promotion PR. GitHub branch protection blocked that force push.',
    '',
    'What to do: allow Wavemill/automation to force-push this integration branch, or have an admin temporarily unprotect/reset the integration branch before running `wavemill promote` again.',
    '',
    'Cleanup if your checkout still looks diverged and you have no local commits to keep:',
    `  git fetch origin ${integrationBranch}`,
    `  git switch ${integrationBranch}`,
    `  git reset --hard origin/${integrationBranch}`,
    rollbackNote.trimStart(),
    '',
    `Original push error: ${message}`,
  ].join('\n');
}

function getBranchProtectionStatus(
  branch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): BranchProtectionStatus {
  try {
    const repo = getRepoName(repoDir, shellRunner);
    const output = shellRunner(
      `gh api ${escapeShellArg(`repos/${repo}/branches/${branch}`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
    const parsed = JSON.parse(output) as unknown;

    if (!isRecord(parsed) || typeof parsed.protected !== 'boolean') {
      return {
        state: 'unknown',
        allowsForcePush: false,
        requiresStatusChecks: false,
        restrictsDirectPush: false,
        reasonCode: 'protection-unknown',
      };
    }

    if (!parsed.protected) {
      return {
        state: 'unprotected',
        allowsForcePush: true,
        requiresStatusChecks: false,
        restrictsDirectPush: false,
      };
    }

    const protection = isRecord(parsed.protection) ? parsed.protection : undefined;
    const allowsForcePush = protectionAllowsForcePush(protection);
    const requiresStatusChecks = protectionRequiresStatusChecks(protection);
    const restrictsDirectPush = protectionRestrictsDirectPush(protection);

    return {
      state: 'protected',
      allowsForcePush,
      requiresStatusChecks,
      restrictsDirectPush,
      reasonCode: classifyProtectionReason({
        allowsForcePush,
        requiresStatusChecks,
        restrictsDirectPush,
        protectionDetailsAvailable: protection !== undefined,
      }),
    };
  } catch {
    return {
      state: 'unknown',
      allowsForcePush: false,
      requiresStatusChecks: false,
      restrictsDirectPush: false,
      reasonCode: 'protection-unknown',
    };
  }
}

function protectionAllowsForcePush(protection: Record<string, unknown> | undefined): boolean {
  if (!protection) {
    return false;
  }
  const allowForcePushes = isRecord(protection.allow_force_pushes) ? protection.allow_force_pushes : undefined;
  return allowForcePushes?.enabled === true;
}

function protectionRequiresStatusChecks(protection: Record<string, unknown> | undefined): boolean {
  if (!protection) {
    return false;
  }
  const requiredStatusChecks = protection.required_status_checks;
  return requiredStatusChecks !== null && requiredStatusChecks !== undefined;
}

function protectionRestrictsDirectPush(protection: Record<string, unknown> | undefined): boolean {
  if (!protection) {
    return false;
  }
  const restrictions = isRecord(protection.restrictions) ? protection.restrictions : undefined;
  if (!restrictions) {
    return false;
  }

  const users = Array.isArray(restrictions.users) ? restrictions.users : [];
  const teams = Array.isArray(restrictions.teams) ? restrictions.teams : [];
  const apps = Array.isArray(restrictions.apps) ? restrictions.apps : [];
  return users.length > 0 || teams.length > 0 || apps.length > 0;
}

function classifyProtectionReason(input: {
  allowsForcePush: boolean;
  requiresStatusChecks: boolean;
  restrictsDirectPush: boolean;
  protectionDetailsAvailable: boolean;
}): ProtectedIntegrationReasonCode {
  if (input.requiresStatusChecks) {
    return 'required-status-checks';
  }
  if (input.restrictsDirectPush) {
    return 'restricted-push';
  }
  if (!input.allowsForcePush && input.protectionDetailsAvailable) {
    return 'force-push-disabled';
  }
  return 'protected';
}

function formatProtectedIntegrationBlockSummary(input: {
  integrationBranch: string;
  promotionBranch: string;
  reasonCode: ProtectedIntegrationReasonCode;
  detail?: string;
}): string {
  const reason = describeProtectionReason(input.reasonCode);
  const detail = input.detail ? ` ${input.detail}` : '';
  return [
    `manual/admin reconciliation required before ${input.integrationBranch} can be rewritten for promotion to ${input.promotionBranch}; reason=${input.reasonCode} (${reason}).${detail}`,
    `Use a dedicated promotion head, keep the promotion blocked for explicit manual handling, or have an admin reconcile ${input.integrationBranch} outside wavemill promote.`,
  ].join(' ');
}

function describeProtectionReason(reasonCode: ProtectedIntegrationReasonCode): string {
  switch (reasonCode) {
    case 'force-push-disabled':
      return 'force pushes are not allowed';
    case 'required-status-checks':
      return 'required status checks block direct rewrites';
    case 'restricted-push':
      return 'direct pushes are restricted';
    case 'protection-unknown':
      return 'branch protection could not be verified';
    default:
      return 'branch protection is enabled';
  }
}

function formatPromotionHeadPushFailure(
  promotionHeadBranch: string,
  pushError: unknown,
): string {
  return [
    `unable to update dedicated promotion head ${promotionHeadBranch}: ${errorMessage(pushError)}`,
    `Resolve or delete origin/${promotionHeadBranch} if it diverged, then rerun wavemill promote.`,
  ].join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listRecentMergedWavemillPrs(
  integrationBranch: string,
  allowedPrNumbers: Set<number>,
  repoDir: string,
  shellRunner: ShellRunner,
): MergedPrSummary[] {
  if (allowedPrNumbers.size === 0) {
    return [];
  }

  try {
    const output = shellRunner(
      [
        'gh',
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        escapeShellArg(integrationBranch),
        '--limit',
        String(RECENT_PR_LIMIT),
        '--json',
        'number,title,url,mergedAt,labels',
      ].join(' '),
      { encoding: 'utf-8', cwd: repoDir },
    );
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return (parsed as MergedPrSummary[]).filter((pr) => {
      if (allowedPrNumbers.size > 0 && !allowedPrNumbers.has(pr.number)) {
        return false;
      }
      return Array.isArray(pr.labels) && pr.labels.some((label) => label.name === WM_LABELS.wavemill);
    });
  } catch {
    return [];
  }
}

function listRecentIntegrationCommits(
  comparisonBase: string,
  integrationBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): string[] {
  try {
    const output = String(shellRunner(
      `git log --first-parent --oneline -n ${RECENT_COMMIT_LIMIT} ${escapeShellArg(`${comparisonBase}..${integrationBranch}`)}`,
      { encoding: 'utf-8', cwd: repoDir },
    )).trim();
    return output ? output.split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

function extractPrNumbers(commits: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const commit of commits) {
    for (const match of commit.matchAll(/(?:#|pull request #)(\d+)/gi)) {
      numbers.add(Number(match[1]));
    }
  }
  return numbers;
}

function findExistingPromotionPr(
  headBranch: string,
  promotionBranch: string,
  repoDir: string,
  shellRunner: ShellRunner,
): PromotionPr | null {
  const output = shellRunner(
    [
      'gh',
      'pr',
      'list',
      '--head',
      escapeShellArg(headBranch),
      '--base',
      escapeShellArg(promotionBranch),
      '--state',
      'open',
      '--json',
      'number,url,body',
    ].join(' '),
    { encoding: 'utf-8', cwd: repoDir },
  );
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  return parsed[0] as PromotionPr;
}

function renderPromotionSection(input: {
  integrationBranch: string;
  promotionBranch: string;
  health: IntegrationHealth;
  promotionNote?: string;
  recentPrs: MergedPrSummary[];
  recentCommits: string[];
  survivingChangeWarnings: CrossPrRevertFinding[];
}): string {
  const lines = [
    PROMOTION_SECTION_BEGIN,
    '## Promotion Summary',
    '',
    `*${input.integrationBranch} -> ${input.promotionBranch} · Updated at ${new Date().toISOString()}*`,
    '',
    `Branch health: ${formatHealth(input.health)}`,
    '',
    `> ⚠️ **Merge this PR with a merge commit — do NOT squash or rebase.** A squash creates a new commit that drops \`${input.integrationBranch}\` from \`${input.promotionBranch}\`'s ancestry, which forces a manual reconcile and re-blocks the next \`wavemill promote\`. A merge commit keeps \`${input.integrationBranch}\` an ancestor of \`${input.promotionBranch}\` so future promotions stay clean.`,
    '',
  ];

  if (input.promotionNote) {
    lines.push(`Promotion path: ${input.promotionNote}`);
    lines.push('');
  }

  if (input.recentPrs.length > 0) {
    lines.push('Recently merged Wavemill PRs:');
    for (const pr of input.recentPrs) {
      lines.push(`- PR #${pr.number}: ${pr.title}`);
    }
    lines.push('');
  }

  if (input.recentCommits.length > 0) {
    lines.push('Recent integration commits not yet on promotion branch:');
    for (const commit of input.recentCommits) {
      lines.push(`- ${commit}`);
    }
    lines.push('');
  }

  if (input.survivingChangeWarnings.length > 0) {
    lines.push('Surviving changes warnings:');
    for (const warning of input.survivingChangeWarnings) {
      lines.push(
        `- PR #${warning.prNumber} is in integration history, but added files are absent from promoted tree: ` +
        warning.files.map((file) => file.path).join(', '),
      );
    }
    lines.push('');
  }

  if (
    input.recentPrs.length === 0 &&
    input.recentCommits.length === 0 &&
    input.survivingChangeWarnings.length === 0
  ) {
    lines.push('No recent merged Wavemill PRs detected.');
    lines.push('');
  }

  lines.push(PROMOTION_SECTION_END);
  return lines.join('\n');
}

function formatHealth(health: IntegrationHealth): string {
  if (health.state === 'healthy') {
    return 'healthy';
  }
  return health.reason ? `unhealthy (${health.reason})` : 'unhealthy';
}

function updatePromotionSection(body: string, section: string): string {
  const trimmed = body.trim();
  const sectionPattern = new RegExp(
    `${escapeRegExp(PROMOTION_SECTION_BEGIN)}[\\s\\S]*?${escapeRegExp(PROMOTION_SECTION_END)}`,
    'm',
  );

  if (sectionPattern.test(body)) {
    return body.replace(sectionPattern, section).trim();
  }

  if (!trimmed) {
    return section;
  }

  return `${trimmed}\n\n${section}`;
}

function formatCheckSummary(result: CheckWaitResult): string {
  const state =
    result.outcome === 'pass'
      ? 'passing'
      : result.outcome === 'fail'
        ? 'failing'
        : 'pending';
  return `${state}: ${result.summary}`;
}

function writeBodyToTempFile(
  body: string,
  shellRunner: ShellRunner,
  repoDir: string,
): string {
  const output = String(shellRunner('mktemp', { encoding: 'utf-8', cwd: repoDir })).trim();
  writeFileSync(output, body);
  return output;
}

function updatePromotionPrBody(
  prNumber: number,
  body: string,
  shellRunner: ShellRunner,
  repoDir: string,
): void {
  const repo = getRepoName(repoDir, shellRunner);
  const bodyJsonFile = writeBodyToTempFile(JSON.stringify({ body }), shellRunner, repoDir);
  try {
    shellRunner(
      `gh api --method PATCH ${escapeShellArg(`repos/${repo}/pulls/${prNumber}`)} --input ${escapeShellArg(bodyJsonFile)}`,
      { encoding: 'utf-8', cwd: repoDir },
    );
  } finally {
    shellRunner(`rm -f ${escapeShellArg(bodyJsonFile)}`, { encoding: 'utf-8', cwd: repoDir });
  }
}

function getRepoName(repoDir: string, shellRunner: ShellRunner): string {
  return String(shellRunner(
    'gh repo view --json nameWithOwner --jq .nameWithOwner',
    { encoding: 'utf-8', cwd: repoDir },
  )).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
