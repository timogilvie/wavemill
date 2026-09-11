import type { ChallengeComparison } from './challenge-comparison.ts';
import type { ChallengeReadyEvidence, ChallengeReadyOutcome } from './challenge-ready-evidence.ts';
import { validatePrMetadata, type PrMetadata, type MetadataValidation } from './pr-metadata.ts';
import { WM_LABELS } from './pr-state-labels.ts';
import type { IntegrationReadyPolicyConfig } from './config.ts';
import {
  evaluateCiChecks,
  type NormalizedCheckSummary,
  type RequiredContextsSource,
} from './pr-ci-status.ts';

/**
 * Typed Ready pending reasons (HOK-2963). Additive: untyped pending (CI,
 * dependency, risk-acknowledgement waits) keeps its existing string-only
 * reporting; only challenge orchestration waits are typed so the monitor can
 * route them away from the generic pending-ready retry budget.
 */
export type ReadyPendingReason =
  | 'challenge-eval-pending'
  | 'challenge-comparison-pending';

export interface GuardResult {
  status: 'pass' | 'warn' | 'pending' | 'fail';
  reason?: string;
  labels?: string[];
  commentFragment?: string;
  /** Set only for typed challenge waits; untyped pending leaves it absent. */
  pendingReason?: ReadyPendingReason;
}

/** Challenge diagnostics surfaced additively on the verdict and JSON output. */
export interface ChallengeReadyVerdictDiagnostics {
  pairId: string;
  side: 'primary' | 'challenger';
  outcome: ChallengeReadyOutcome;
  primaryEval: { ok: boolean; evalId?: string; refusalReason?: string };
  challengerEval: { ok: boolean; evalId?: string; refusalReason?: string };
  staleComparisons: number;
}

export interface ReadyVerdict {
  status: 'pass' | 'warn' | 'pending' | 'fail';
  reasons: string[];
  output: { labels: string[]; comment: string };
  /**
   * True when the implementation guards (CI, base branch, metadata,
   * dependencies, migration coupling, risk) aggregate to pass/warn — i.e.
   * the PR is mergeable but for challenge-pair resolution.
   */
  implementationReady?: boolean;
  /** First typed pending reason; set only when implementationReady is true. */
  pendingReason?: ReadyPendingReason;
  /** All typed pending reasons, when any. */
  pendingReasons?: ReadyPendingReason[];
  challenge?: ChallengeReadyVerdictDiagnostics;
}

export type CheckReadErrorType = 'command-failed' | 'timeout' | 'malformed-json' | 'network' | 'unknown';

export type CheckReadResult =
  | {
      ok: true;
      checks: NormalizedCheckSummary[];
      requiredContexts: string[];
      requiredSource: RequiredContextsSource;
      requireChecks?: boolean;
    }
  | { ok: false; reason: string; errorType: CheckReadErrorType };

export interface ReadyEngineContext {
  pr: {
    number: number;
    url: string;
    baseBranch: string;
    body: string;
    labels: string[];
    mergedAt: string | null;
  };
  config: IntegrationReadyPolicyConfig & { integrationBranch: string };
  fetchPrState: (prNumber: number) => Promise<{ state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedAt: string | null } | null>;
  fetchLinearIssueState: (id: string) => Promise<{ completedAt: string | null; canceledAt: string | null } | null>;
  readChallengeComparisons: () => ChallengeComparison[];
  requiredCheckRead?: CheckReadResult;
  /**
   * Optional current-head challenge evidence resolver (HOK-2963). When
   * provided and it returns evidence, the challenge guard reports typed
   * pending for launchable eval/comparison work instead of the legacy
   * fail-closed "no comparison record" verdict. A null return (or a throw)
   * falls back to the legacy record-presence gate, so unresolvable pair
   * identity stays fail-closed.
   */
  resolveChallengeEvidence?: () => Promise<ChallengeReadyEvidence | null>;
}

function aggregateStatus(results: GuardResult[]): ReadyVerdict['status'] {
  if (results.some((result) => result.status === 'fail')) return 'fail';
  if (results.some((result) => result.status === 'pending')) return 'pending';
  if (results.some((result) => result.status === 'warn')) return 'warn';
  return 'pass';
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function toFragment(title: string, lines: string[]): string {
  return [`${title}:`, ...lines.map((line) => `- ${line}`)].join('\n');
}

function getValidationForReady(body: string): MetadataValidation {
  return validatePrMetadata(body);
}

async function getMetadata(ctx: ReadyEngineContext): Promise<PrMetadata> {
  const validation = getValidationForReady(ctx.pr.body);
  if (validation.status === 'absent') {
    throw new Error('Missing `wavemill-meta` block in PR body.');
  }
  if (validation.status === 'invalid') {
    throw new Error(validation.errors.map((e) => e.message).join('; '));
  }
  return validation.metadata;
}

export async function checkBaseBranch(ctx: ReadyEngineContext): Promise<GuardResult> {
  if (ctx.pr.baseBranch === ctx.config.integrationBranch) {
    return { status: 'pass' };
  }

  const reason = `PR targets \`${ctx.pr.baseBranch}\` but ready policy requires \`${ctx.config.integrationBranch}\`.`;
  return {
    status: 'fail',
    reason,
    labels: [WM_LABELS.wrongBase],
    commentFragment: toFragment('Wrong Base Branch', [reason]),
  };
}

export async function checkMetadata(ctx: ReadyEngineContext): Promise<GuardResult> {
  const validation = getValidationForReady(ctx.pr.body);
  if (validation.status === 'valid') {
    return { status: 'pass' };
  }

  if (validation.status === 'absent') {
    const reason = 'Missing `wavemill-meta` block in PR body.';
    return {
      status: 'fail',
      reason,
      labels: [WM_LABELS.metadataInvalid],
      commentFragment: toFragment('Invalid Metadata', [reason]),
    };
  }

  const lines = validation.errors.map((e) => e.message);
  return {
    status: 'fail',
    reason: lines.join(' '),
    labels: [WM_LABELS.metadataInvalid],
    commentFragment: toFragment('Invalid Metadata', lines),
  };
}

export async function checkDependencies(ctx: ReadyEngineContext): Promise<GuardResult> {
  const metadata = await getMetadata(ctx);
  const failures: string[] = [];
  const pendings: string[] = [];

  for (const dependency of metadata.depends_on ?? []) {
    const match = /^PR#(\d+)$/i.exec(dependency.trim());
    if (!match) {
      failures.push(`Dependency \`${dependency}\` is not a valid PR reference. Expected \`PR#123\`.`);
      continue;
    }

    const prNumber = Number(match[1]);
    const state = await ctx.fetchPrState(prNumber);
    if (!state) {
      failures.push(`Dependency \`PR#${prNumber}\` was not found.`);
      continue;
    }
    if (state.state === 'MERGED' || state.mergedAt) {
      continue;
    }
    if (state.state === 'OPEN') {
      pendings.push(`Dependency \`PR#${prNumber}\` is still open.`);
      continue;
    }
    failures.push(`Dependency \`PR#${prNumber}\` is closed without merge.`);
  }

  for (const issueId of metadata.depends_on_linear ?? []) {
    const state = await ctx.fetchLinearIssueState(issueId);
    if (!state) {
      failures.push(`Linear dependency \`${issueId}\` was not found.`);
      continue;
    }
    if (state.canceledAt) {
      failures.push(`Linear dependency \`${issueId}\` was canceled.`);
      continue;
    }
    if (state.completedAt) {
      continue;
    }
    pendings.push(`Linear dependency \`${issueId}\` is not completed.`);
  }

  if (failures.length > 0) {
    return {
      status: 'fail',
      reason: failures.join(' '),
      commentFragment: toFragment('Dependencies Blocked', failures),
    };
  }
  if (pendings.length > 0) {
    return {
      status: 'pending',
      reason: pendings.join(' '),
      commentFragment: toFragment('Dependencies Pending', pendings),
    };
  }
  return { status: 'pass' };
}

export async function checkMigrationCoupling(ctx: ReadyEngineContext): Promise<GuardResult> {
  if (ctx.config.enforceMigrationCoupling === false) {
    return { status: 'pass' };
  }

  const labels = new Set(ctx.pr.labels);
  const hasDbMigration = labels.has('db:migration');
  const hasWmMigration = labels.has(WM_LABELS.migration);

  if (hasDbMigration && !hasWmMigration) {
    const reason = `Label \`db:migration\` requires \`${WM_LABELS.migration}\` for autonomous merge.`;
    return {
      status: 'fail',
      reason,
      labels: [WM_LABELS.migrationRequired],
      commentFragment: toFragment('Migration Label Required', [reason]),
    };
  }

  if (!hasDbMigration && hasWmMigration) {
    const reason = `Label \`${WM_LABELS.migration}\` is present without \`db:migration\`.`;
    return {
      status: 'warn',
      reason,
      commentFragment: toFragment('Migration Label Mismatch', [reason]),
    };
  }

  return { status: 'pass' };
}

export async function checkRiskPolicy(ctx: ReadyEngineContext): Promise<GuardResult> {
  const metadata = await getMetadata(ctx);
  const labels = new Set(ctx.pr.labels);
  const highRisk = metadata.risk === 'high' || labels.has('Risk: High');
  if (!highRisk) {
    return { status: 'pass' };
  }

  const riskPolicy = ctx.config.riskPolicy ?? 'require-label';
  if (riskPolicy === 'block') {
    const reason = 'High-risk PRs are blocked by ready policy.';
    return {
      status: 'fail',
      reason,
      commentFragment: toFragment('High Risk Blocked', [reason]),
    };
  }

  if (riskPolicy === 'require-label') {
    if (labels.has(WM_LABELS.riskAcknowledged)) {
      return { status: 'pass' };
    }
    const reason = `High-risk PR requires \`${WM_LABELS.riskAcknowledged}\` before autonomous merge.`;
    return {
      status: 'pending',
      reason,
      commentFragment: toFragment('High Risk Acknowledgement Needed', [reason]),
    };
  }

  const reason = 'High-risk PR is allowed to proceed automatically by ready policy.';
  return {
    status: 'warn',
    reason,
    commentFragment: toFragment('High Risk Auto-Allowed', [reason]),
  };
}

function challengeDiagnostics(evidence: ChallengeReadyEvidence): ChallengeReadyVerdictDiagnostics {
  return {
    pairId: evidence.pairId,
    side: evidence.side,
    outcome: evidence.outcome,
    primaryEval: {
      ok: evidence.primaryEval.ok,
      ...(evidence.primaryEval.evalId ? { evalId: evidence.primaryEval.evalId } : {}),
      ...(evidence.primaryEval.refusalReason ? { refusalReason: evidence.primaryEval.refusalReason } : {}),
    },
    challengerEval: {
      ok: evidence.challengerEval.ok,
      ...(evidence.challengerEval.evalId ? { evalId: evidence.challengerEval.evalId } : {}),
      ...(evidence.challengerEval.refusalReason ? { refusalReason: evidence.challengerEval.refusalReason } : {}),
    },
    staleComparisons: evidence.staleComparisons,
  };
}

interface ChallengeGuardDetail {
  guard: GuardResult;
  challenge?: ChallengeReadyVerdictDiagnostics;
}

async function checkChallengePairsDetailed(ctx: ReadyEngineContext): Promise<ChallengeGuardDetail> {
  const metadata = await getMetadata(ctx);
  if (metadata.challenge !== true) {
    return { guard: { status: 'pass' } };
  }

  // Current-head evidence path (HOK-2963): typed pending while eval or
  // comparison orchestration can still make progress; pass only for a
  // comparison valid at the live heads or an explicit terminal resolution.
  if (ctx.resolveChallengeEvidence) {
    let evidence: ChallengeReadyEvidence | null = null;
    try {
      evidence = await ctx.resolveChallengeEvidence();
    } catch {
      evidence = null;
    }
    if (evidence) {
      const diagnostics = challengeDiagnostics(evidence);
      if (evidence.outcome === 'comparison-valid' || evidence.outcome === 'terminal-resolution') {
        return { guard: { status: 'pass' }, challenge: diagnostics };
      }
      const reason = evidence.outcome === 'eval-pending'
        ? `Challenge pair ${evidence.pairId} is waiting on current-head eval evidence.`
        : `Challenge pair ${evidence.pairId} has current-head evals but no comparison yet.`;
      return {
        guard: {
          status: 'pending',
          reason,
          pendingReason: evidence.pendingReason,
          commentFragment: toFragment('Challenge Pair Pending', [reason]),
        },
        challenge: diagnostics,
      };
    }
    // Fall through to the legacy fail-closed gate when pair identity or
    // evidence could not be resolved.
  }

  try {
    const comparisons = ctx.readChallengeComparisons();
    const matched = comparisons.find((comparison) =>
      comparison.primaryPrUrl === ctx.pr.url || comparison.challengerPrUrl === ctx.pr.url,
    );

    if (matched) {
      return { guard: { status: 'pass' } };
    }

    const reason = 'Challenge PR is missing a resolved comparison pair.';
    return {
      guard: {
        status: 'fail',
        reason,
        labels: [WM_LABELS.challengeUnresolved],
        commentFragment: toFragment('Challenge Pair Unresolved', [reason]),
      },
    };
  } catch {
    const reason = 'Challenge resolution unavailable.';
    return {
      guard: {
        status: 'fail',
        reason,
        labels: [WM_LABELS.challengeUnresolved],
        commentFragment: toFragment('Challenge Pair Unresolved', [reason]),
      },
    };
  }
}

export async function checkChallengePairs(ctx: ReadyEngineContext): Promise<GuardResult> {
  return (await checkChallengePairsDetailed(ctx)).guard;
}

function formatList(values: string[], limit = 5): string {
  if (values.length <= limit) return values.join(', ');
  return `${values.slice(0, limit).join(', ')}, ...`;
}

export function readRequiredChecks(result: CheckReadResult): GuardResult {
  if (result.ok) {
    const evaluated = evaluateCiChecks(result.checks, result.requiredContexts, {
      requireChecks: result.requireChecks,
      requiredSource: result.requiredSource,
    });
    if (evaluated.conclusion === 'pass' || evaluated.conclusion === 'none') {
      return { status: 'pass' };
    }
    if (evaluated.conclusion === 'fail') {
      const reason = evaluated.failing.length === 1
        ? `Required GitHub check "${evaluated.failing[0]}" is failing.`
        : `Required GitHub checks are failing: ${formatList(evaluated.failing)}.`;
      return {
        status: 'fail',
        reason,
        commentFragment: toFragment('Required Checks Failing', [reason]),
      };
    }

    const blockers = [
      ...evaluated.missingRequired.map((name) => `missing ${name}`),
      ...evaluated.pending.map((name) => `pending ${name}`),
    ];
    const observedOfRequired = evaluated.requiredContexts.length > 0
      ? `observed ${evaluated.observed} of ${evaluated.requiredContexts.length}`
      : `observed ${evaluated.observed}`;
    const reason = blockers.length > 0
      ? `Waiting on ${blockers.length} required/pending check(s) (${observedOfRequired}): ${formatList(blockers)}.`
      : `Waiting for GitHub checks to report (${observedOfRequired}).`;
    return {
      status: 'pending',
      reason,
      commentFragment: toFragment('Required Checks Pending', [reason]),
    };
  }

  const reason = `Required GitHub check status could not be read (${result.errorType}): ${result.reason}`;
  return {
    status: 'pending',
    reason,
    commentFragment: toFragment('Required Checks Unavailable', [reason]),
  };
}

export async function evaluateReady(ctx: ReadyEngineContext): Promise<ReadyVerdict> {
  if (ctx.config.enabled !== true) {
    return {
      status: 'pass',
      reasons: [],
      output: { labels: [], comment: '' },
    };
  }

  // Implementation guards decide "mergeable but for challenge resolution";
  // the challenge guard is evaluated separately so its typed pending reasons
  // can be suppressed while implementation work (e.g. CI) is still pending.
  const implementationGuards = await Promise.all([
    Promise.resolve(ctx.requiredCheckRead ? readRequiredChecks(ctx.requiredCheckRead) : { status: 'pass' as const }),
    checkBaseBranch(ctx),
    checkMetadata(ctx),
    checkDependencies(ctx).catch((error) => ({
      status: 'fail' as const,
      reason: `Dependency evaluation failed: ${(error as Error).message}`,
      commentFragment: toFragment('Dependencies Blocked', [`Dependency evaluation failed: ${(error as Error).message}`]),
    })),
    checkMigrationCoupling(ctx),
    checkRiskPolicy(ctx).catch((error) => ({
      status: 'fail' as const,
      reason: `Risk evaluation failed: ${(error as Error).message}`,
      commentFragment: toFragment('High Risk Blocked', [`Risk evaluation failed: ${(error as Error).message}`]),
    })),
  ]);

  const challengeDetail = await checkChallengePairsDetailed(ctx).catch((error): ChallengeGuardDetail => ({
    guard: {
      status: 'fail' as const,
      reason: `Challenge evaluation failed: ${(error as Error).message}`,
      labels: [WM_LABELS.challengeUnresolved],
      commentFragment: toFragment('Challenge Pair Unresolved', [`Challenge evaluation failed: ${(error as Error).message}`]),
    },
  }));

  const guardResults = [...implementationGuards, challengeDetail.guard];
  const implementationStatus = aggregateStatus(implementationGuards);
  const implementationReady = implementationStatus === 'pass' || implementationStatus === 'warn';
  const status = aggregateStatus(guardResults);
  // Typed pending reasons surface only once the implementation guards are
  // green: a CI wait must keep reporting as CI pending, never as challenge
  // pending (REQ-F2 inverse).
  const pendingReasons = status === 'pending' && implementationReady
    ? dedupe(guardResults.flatMap((result) => result.pendingReason ? [result.pendingReason] : []))
    : [];

  return {
    status,
    reasons: guardResults.flatMap((result) => result.reason ? [result.reason] : []),
    output: {
      labels: dedupe(guardResults.flatMap((result) => result.labels ?? [])),
      comment: guardResults
        .flatMap((result) => result.commentFragment ? [result.commentFragment] : [])
        .join('\n\n'),
    },
    implementationReady,
    ...(pendingReasons.length > 0
      ? { pendingReason: pendingReasons[0] as ReadyPendingReason, pendingReasons: pendingReasons as ReadyPendingReason[] }
      : {}),
    ...(challengeDetail.challenge ? { challenge: challengeDetail.challenge } : {}),
  };
}
