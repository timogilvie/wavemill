import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeLaneStateDir, recordLaneProgress, type LaneProgressEvent } from './merge-queue.ts';
import {
  setWavemillBlocked,
  setWavemillMerged,
  setWavemillMerging,
  setWavemillReady,
  setWavemillSuperseded,
  clearPrStateMarker,
  getPrStateMarkerHandle,
  readPrStateMarker,
  writePrStateMarker,
  WM_LABELS,
} from './pr-state-labels.ts';
import {
  claimReadyHandoff,
  describeClaimRejection,
  publishReadyHandoff,
  readReadyTendHandoff,
  readTendPushedHead,
  rebindTendHandoff,
  recordTendPushedHead,
  type ClaimHandoffOutcome,
} from './ready-tend-handoff.ts';
import { buildStaleMarkerFinding, type MarkerPayload, type MarkerValidation } from './transient-marker.ts';
import { getIntegrationConfig, getIntegrationReadyPolicy, resolveSessionCapabilities } from './config.ts';
import { appendObserverFinding as sharedAppendObserverFinding } from './observer-findings.ts';
import { readChallengeComparisons } from './challenge-comparison.ts';
import { getPullRequest, removeLabelFromPullRequest } from './github.ts';
import { resolveWavemillToolPath } from './native-agent/install-paths.ts';
import { getIssueCompletionState } from './linear.ts';
import { validatePrMetadata, type PrMetadata, type MetadataValidation } from './pr-metadata.ts';
import { evaluateReady } from './ready-engine.ts';
import { runReadyStage } from './ready-stage.ts';
import { escapeShellArg, execArgvCommand, execShellCommand } from './shell-utils.ts';
import {
  applyChallengePairGates,
  evaluateAutoCloseEligibility,
  type ChallengeGateDeps,
  type ChallengeGateOptions,
  type ChallengeLoserCleanupCandidate,
} from './tend-challenge-gate.ts';
import { isTransientErrorText, retryTransient, TransientError } from './transient-retry.ts';
import { classifyFailure, DEFAULT_RETRY_ATTEMPTS, retryBucketFor, type FailureEvidence } from './failure-policy.ts';
import { normalizeTaskLifecycle } from './task-lifecycle.ts';
import { resolveEffectiveTaskConfig } from './effective-task-config.ts';
import {
  clearScratchPrepMarkerBestEffort,
  createProcessGroupPrepRunner,
  isOwnerAlive,
  listScratchPrepMarkers,
  readScratchPrepMarker,
  SAFE_PREP_PHASES,
  writeScratchPrepMarker,
  writeScratchPrepMarkerBestEffort,
  WorktreePrepTimeoutError,
  type ScratchPrepMarker,
  type ScratchPrepPhase,
  type ScratchPrepReconcileOutcome,
  type ScratchPrepRunner,
} from './tend-scratch-prep.ts';

export interface TendCandidate {
  number: number;
  title: string;
  headBranch: string;
  createdAt: string;
  dependencyDepth: number;
  /** Fresh GitHub head and resolved artifact location, supplied by selection. */
  headSha?: string;
  featureDir?: string;
}

export interface BlockedCandidate {
  number: number;
  title: string;
  headBranch: string;
  reason: string;
  /** Current PR labels, for stall-finding attribution (absent on some paths). */
  labels?: string[];
}

export interface WaitingReadyCandidate {
  number: number;
  title: string;
  headBranch: string;
  labels?: string[];
}

export interface AdvisoryCheckFailure {
  name: string;
  conclusion: string;
}

export interface IntegrationHealth {
  state: 'healthy' | 'unhealthy';
  reason?: string;
  /**
   * Failing check runs on the integration tip whose names appear in
   * `integration.advisoryChecks`. Reported when `state === 'healthy'` so the
   * failure stays visible in the status line and backstage-health.json even
   * though it does not halt the merge lane. Omitted (never `[]`) when there
   * are no advisory failures, so existing `{ state: 'healthy' }` assertions
   * stay stable.
   */
  advisoryFailures?: AdvisoryCheckFailure[];
}

export interface TendDecision {
  integrationHealth: IntegrationHealth;
  eligible: TendCandidate[];
  blocked: BlockedCandidate[];
  /** Open Wavemill PRs carrying wm:ready while integration health prevents normal selection. */
  waitingReady?: WaitingReadyCandidate[];
  nextPR: number | null;
}

export interface MergeExecutionResult {
  /**
   * 'retried' means the merge was rejected by strict base protection while the
   * PR remained otherwise eligible (MERGEABLE/BEHIND with green checks); the
   * branch was refreshed in place, CI restarted, and the PR returned to
   * wm:ready for the next pass instead of being terminally blocked.
   */
  status: 'merged' | 'blocked' | 'skipped' | 'halted' | 'retried';
  prNumber: number;
  phase?: string;
  failureExcerpt?: string;
  /** PRs still holding the wm:merging lane lock when phase is 'merge-lane-held'. */
  heldBy?: number[];
  haltLoop: boolean;
}

/** Composed bounded-retry decision for the strict-base refresh path (HOK-2924). */
export type StrictBaseRetryDecision = 'proceed' | 'backoff' | 'exhausted' | 'exhausted-quiet';

/**
 * Bounded-retry operations for the strict-base refresh path. The default
 * implementation shells out to shared/lib/bounded-retry.sh (the HOK-2924
 * invariant helper) keyed by `(merge-lane state dir, strict-base-refresh
 * bucket, rejected head SHA)`; tests may inject fakes.
 */
export interface StrictBaseRetryOps {
  /**
   * `baseSha` (optional, HOK-3103) completes the (head, base) retry key: a new
   * base wipes the budget just like a new head.
   */
  gate: (prNumber: number, headSha: string, repoDir: string, baseSha?: string) => StrictBaseRetryDecision;
  increment: (prNumber: number, headSha: string, repoDir: string, baseSha?: string) => void;
  markExhausted: (prNumber: number, reason: string, repoDir: string) => void;
  clear: (prNumber: number, repoDir: string) => void;
}

export interface MergeExecutionDeps {
  shellRunner: (cmd: string, opts?: { encoding?: string; cwd?: string; timeout?: number }) => string;
  readyChecker: (prNumber: number, repoDir: string) => Promise<{ ready: boolean; reason?: string }>;
  healthChecker: HealthChecker;
  acquireMerging: (prNumber: number) => void;
  releaseToBlocked: (prNumber: number) => void;
  releaseMerged: (prNumber: number) => void;
  restoreReady: (prNumber: number) => void;
  reclaimStaleMerging: (prNumber: number) => void;
  retrySleep: (ms: number) => Promise<void>;
  currentTimeMs: () => number;
  setMergeRetryWindow: (prNumber: number, untilIso: string | null, repoDir: string) => void;
  strictBaseRetry: StrictBaseRetryOps;
  /** Best-effort lane-progress telemetry recorder; must never fail the merge. */
  recordLaneProgress: (prNumber: number, event: LaneProgressEvent, repoDir: string) => Promise<void>;
  /**
   * Strip an untrusted `wm:ready` label off a PR whose Ready → Tend handoff is
   * missing or does not match the current head (HOK-3107). Best-effort — a
   * failure must never halt the tend loop. Defaults to `removeLabelFromPullRequest`.
   */
  stripUntrustedReady: (prNumber: number, repoDir: string) => void;
  /**
   * Scratch-prep bounded-retry ops (HOK-3039). Records recovery attempts per
   * (mergeLaneStateDir, `scratch-prep-recovery` bucket, head SHA) and marks
   * the bucket exhausted after the ceiling — retry-exactly-once matches the
   * issue's "next Tend loop restores a safe state and can retry exactly once"
   * success criterion. Defaults to the bounded-retry.sh helper.
   */
  scratchPrepRetry: StrictBaseRetryOps;
  /**
   * Handoff-rebind bounded-retry ops (HOK-3105). Records deferrals of a
   * post-push handoff rebind when GitHub read-after-write lag keeps returning
   * the pre-push head. Keyed on the pushed head SHA — a fresh push resets the
   * budget. When the budget is exhausted the terminal handoff block path runs
   * (posts the failure comment and moves the PR to wm:blocked).
   */
  handoffRebindRetry: StrictBaseRetryOps;
  /**
   * Handoff-claim bounded-retry ops (HOK-3108). Counts consecutive rejected
   * pre-lane Tend claims for a `wm:ready` PR whose Ready handoff file is
   * missing/not-published/mismatched at the live head. Keyed on the live PR
   * head — a fresh push resets the budget. When the budget is exhausted tend
   * takes the terminal block path (comment + wm:blocked) so the same PR does
   * not starve the lane forever. Backoff base is 0 (no starvation from
   * exponential waits).
   */
  handoffClaimRetry: StrictBaseRetryOps;
  /**
   * Default-retry ops for in-lane failures the HOK-3176 failure policy does
   * not allowlist as terminal or recognise as a code failure (dropped
   * connection during push, a checks wait that timed out, a ready checker that
   * threw). Keyed on (PR head, integration tip): while the budget lasts the PR
   * returns to wm:ready instead of being labelled wm:blocked.
   */
  transientRetry: StrictBaseRetryOps;
  /**
   * Factory for the process-group prep runner used by `withScratchWorktree`.
   * Called once per merge attempt; each attempt gets a fresh shared deadline.
   * Tests inject a fake to simulate timeouts without spawning processes.
   */
  prepRunnerFactory: (repoDir: string, options: { onHeartbeat?: () => void }) => ScratchPrepRunner;
}

export interface ExecuteMergeOptions {
  repoDir: string;
  deps?: Partial<MergeExecutionDeps>;
  /**
   * Optional phase-progress callback. Fires as `withScratchWorktree` advances
   * the scratch-prep phase, and periodically while a long prep command runs
   * (via the runner's heartbeat). Used by the Tend loop to keep the
   * backstage-health.json heartbeat fresh during otherwise-quiet prep steps.
   */
  onPhaseProgress?: (update: {
    prNumber: number;
    phase: ScratchPrepPhase | 'heartbeat';
    at: string;
  }) => Promise<void> | void;
}

export interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
  headRefOid?: string;
  createdAt: string;
  isDraft: boolean;
  labels: { name: string }[];
  body: string;
}

export type HealthChecker = (integrationBranch: string, repoDir: string) => Promise<IntegrationHealth>;
export type PrFetcher = (integrationBranch: string, repoDir: string) => Promise<GhPrListEntry[]>;
export interface CheckWaitResult {
  outcome: 'pass' | 'fail' | 'timeout' | 'head-changed';
  summary: string;
}

export interface SelectNextCandidateOptions {
  repoDir: string;
  prFetcher?: PrFetcher;
  healthChecker?: HealthChecker;
  crossPrGuardChecker?: CrossPrGuardChecker;
  blockedLabelClearer?: BlockedLabelClearer;
  prStateMarkerReader?: PrStateMarkerReader;
  prStateMarkerWriter?: PrStateMarkerWriter;
  blockedPrLiveStateProber?: BlockedPrLiveStateProber;
  loserCleanup?: (candidate: ChallengeLoserCleanupCandidate, repoDir: string) => void;
  challengeGateDeps?: ChallengeGateDeps;
  challengeGateOptions?: ChallengeGateOptions;
}

/**
 * Live GitHub truth for a PR carrying wm:blocked, read before the label is
 * honoured. `available: false` means the probe failed — callers must treat
 * that as "gate unverifiable", never as evidence in either direction.
 */
export interface BlockedPrLiveState {
  available: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  failingChecks?: string[];
  pendingChecks?: string[];
}

export type BlockedPrLiveStateProber = (prNumber: number, repoDir: string) => Promise<BlockedPrLiveState>;

export interface CrossPrGuardCheckResult {
  status: 'pass' | 'blocked' | 'tool-error';
  checkedHeadSha: string;
  detail?: string;
}

export type CrossPrGuardChecker = (input: {
  pr: GhPrListEntry;
  integrationBranch: string;
  repoDir: string;
}) => Promise<CrossPrGuardCheckResult>;

export type BlockedLabelClearer = (prNumber: number, repoDir: string) => void;
export type PrStateMarkerReader = (
  prNumber: number,
  args: { currentHead: string; markerRoot: string; deriveCondition: (payload: MarkerPayload) => Promise<boolean> | boolean },
) => Promise<MarkerValidation<boolean>>;
export type PrStateMarkerWriter = typeof writePrStateMarker;

interface EligibleWorkItem {
  pr: GhPrListEntry;
  metadata: PrMetadata;
}

interface IntegrationBranchResolution {
  sha: string;
  source: 'remote' | 'local';
}

const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const PR_DEPENDENCY_PATTERN = /^PR#(\d+)$/i;
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILING_CHECK_BUCKETS = new Set(['fail', 'cancel']);
const PASSING_CHECK_BUCKETS = new Set(['pass', 'skipping']);
const CHECK_POLL_INTERVAL_MS = 30_000;
// Consecutive polls the PR head may differ from the expected head before
// waitForChecks concludes the head was genuinely superseded ('head-changed')
// rather than GitHub read-after-write lag, which self-heals within a poll or
// two of the force-push.
const HEAD_MISMATCH_MAX_POLLS = 3;
const TRANSIENT_REQUIRED_CHECKS_EXPECTED = 'required status checks are expected';
const MERGE_RETRY_MAX_ATTEMPTS = 8;
const MERGE_RETRY_BACKOFF_MS = 30_000;
const MERGE_RETRY_WINDOW_MS = 5 * 60 * 1000;
const GH_COMMAND_TIMEOUT_MS = 120_000;
const GIT_COMMAND_TIMEOUT_MS = 180_000;
const GIT_MUTATION_TIMEOUT_MS = 300_000;
const MERGE_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_EXTERNAL_COMMAND_TIMEOUT_MS = 120_000;
const CROSS_PR_GUARD_TOOL_TIMEOUT_MS = 180_000;
const CROSS_PR_GUARD_PROVENANCE_TEXT = [
  'Cross-PR revert guard',
  'removes files from',
  'without explicit acknowledgement',
];

export interface PrMergeDiagnostics {
  mergeStateStatus?: string;
  mergeable?: string;
  statusCheckRollup?: unknown;
  headRefOid?: string;
  baseRefOid?: string;
  unavailableReason?: string;
}

interface ReadyResultSnapshot {
  status?: string;
  artifacts?: Record<string, unknown>;
  crossPrDiagnostic?: unknown;
  attention?: string;
}

interface CrossPrGuardEvidence {
  provenance: boolean;
  checkedHeadSha?: string;
  status?: string;
  detail?: string;
}

export function createPrFetcher(deps: {
  exec?: typeof execShellCommand;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
} = {}): PrFetcher {
  const exec = deps.exec ?? execShellCommand;
  return async (integrationBranch: string, repoDir: string): Promise<GhPrListEntry[]> => {
    validateIntegrationBranch(integrationBranch);

    return retryTransient(
      () => {
        const output = String(exec(
          [
            'gh',
            'pr',
            'list',
            '--base',
            escapeShellArg(integrationBranch),
            '--state',
            'open',
            '--json',
            'number,title,headRefName,headRefOid,createdAt,isDraft,labels,body',
          ].join(' '),
          { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
        ));
        const parsed = JSON.parse(output) as unknown;

        if (!Array.isArray(parsed)) {
          throw new Error('tend: gh pr list returned non-array JSON');
        }

        return parsed as GhPrListEntry[];
      },
      { label: 'gh pr list', sleep: deps.sleep, random: deps.random },
    );
  };
}

export const defaultPrFetcher: PrFetcher = createPrFetcher();

export async function defaultHealthChecker(integrationBranch: string, repoDir: string): Promise<IntegrationHealth> {
  try {
    validateIntegrationBranch(integrationBranch);

    const refreshError = refreshIntegrationBranchRef(integrationBranch, repoDir);
    let resolution: IntegrationBranchResolution;
    try {
      resolution = resolveIntegrationBranchSha(integrationBranch, repoDir);
    } catch (error) {
      if (refreshError) {
        return {
          state: 'unhealthy',
          reason: `health-check-refresh-failed: ${truncateReason(refreshError, 160)}; ${truncateReason(errorMessage(error), 160)}`,
        };
      }
      throw error;
    }
    const repo = resolveOwnerRepoFromRemote(repoDir);

    if (!repo) {
      return { state: 'unhealthy', reason: 'health-check-error: unable to resolve origin repo' };
    }

    let checkRuns: Array<{ name?: string; conclusion?: string | null }>;
    try {
      checkRuns = await readCheckRuns(repo, resolution.sha, repoDir);
    } catch (error) {
      const remoteResolution = resolveRemoteIntegrationBranchSha(integrationBranch, repoDir);
      if (
        resolution.source !== 'local' ||
        !isMissingCommitCheckRunsError(error) ||
        !remoteResolution ||
        remoteResolution.sha === resolution.sha
      ) {
        throw error;
      }
      checkRuns = await readCheckRuns(repo, remoteResolution.sha, repoDir);
    }

    const advisorySet = new Set(getIntegrationConfig(repoDir).advisoryChecks);
    const advisoryFailures: AdvisoryCheckFailure[] = [];
    const seenAdvisoryNames = new Set<string>();

    for (const checkRun of checkRuns) {
      const conclusion = checkRun.conclusion ?? '';
      if (!FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
        continue;
      }
      const name = checkRun.name || 'check';
      if (advisorySet.has(name)) {
        // Dedupe by name — re-runs can produce multiple check-run entries
        // with the same name. Keep the first failing conclusion observed.
        if (!seenAdvisoryNames.has(name)) {
          seenAdvisoryNames.add(name);
          advisoryFailures.push({ name, conclusion });
        }
        continue;
      }
      return { state: 'unhealthy', reason: `${name}: ${conclusion}` };
    }

    if (refreshError) {
      return {
        state: 'unhealthy',
        reason: `health-check-refresh-failed: ${truncateReason(refreshError, 200)}`,
      };
    }

    if (advisoryFailures.length > 0) {
      return { state: 'healthy', advisoryFailures };
    }
    return { state: 'healthy' };
  } catch (error) {
    return { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }
}

function refreshIntegrationBranchRef(integrationBranch: string, repoDir: string): string | null {
  try {
    execShellCommand(
      `git fetch origin ${escapeShellArg(integrationBranch)} 2>&1`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GIT_COMMAND_TIMEOUT_MS },
    );
    return null;
  } catch (error) {
    return outputFromError(error);
  }
}

async function readCheckRuns(
  repo: string,
  sha: string,
  repoDir: string,
): Promise<Array<{ name?: string; conclusion?: string | null }>> {
  return retryTransient(
    () => {
      const raw = String(execShellCommand(
        `gh api ${escapeShellArg(`repos/${repo}/commits/${sha}/check-runs`)}`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      ));
      const parsed = JSON.parse(raw) as { check_runs?: Array<{ name?: string; conclusion?: string | null }> };
      return Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
    },
    { label: 'gh check-runs' },
  );
}

function isMissingCommitCheckRunsError(error: unknown): boolean {
  const output = outputFromError(error);
  return output.includes('No commit found for SHA') && output.includes('HTTP 422');
}

function resolveIntegrationBranchSha(integrationBranch: string, repoDir: string): IntegrationBranchResolution {
  const remoteResolution = resolveRemoteIntegrationBranchSha(integrationBranch, repoDir);
  if (remoteResolution) {
    return remoteResolution;
  }

  const localSha = resolveRefSha(integrationBranch, repoDir);
  if (localSha) {
    return { sha: localSha, source: 'local' };
  }

  const remoteTrackingRef = integrationRemoteTrackingRef(integrationBranch);

  throw new Error(
    `unable to resolve integration branch ${escapeShellArg(integrationBranch)} locally or as ${remoteTrackingRef}`,
  );
}

function resolveRemoteIntegrationBranchSha(
  integrationBranch: string,
  repoDir: string,
): IntegrationBranchResolution | null {
  const remoteTrackingRef = integrationRemoteTrackingRef(integrationBranch);
  const remoteSha = resolveRefSha(remoteTrackingRef, repoDir);
  if (!remoteSha) {
    return null;
  }

  return { sha: remoteSha, source: 'remote' };
}

function integrationRemoteTrackingRef(integrationBranch: string): string {
  return `refs/remotes/origin/${integrationBranch}`;
}

function resolveRefSha(ref: string, repoDir: string): string | null {
  try {
    const sha = String(execShellCommand(
      `git rev-parse ${escapeShellArg(ref)} 2>/dev/null`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GIT_COMMAND_TIMEOUT_MS },
    )).trim();
    return sha ? sha : null;
  } catch {
    return null;
  }
}

export async function selectNextCandidate(options: SelectNextCandidateOptions): Promise<TendDecision> {
  const integrationBranch = getConfiguredIntegrationBranch(options.repoDir);
  const healthChecker = options.healthChecker ?? defaultHealthChecker;
  const prFetcher = options.prFetcher ?? defaultPrFetcher;

  const integrationHealth = await healthChecker(integrationBranch, options.repoDir);
  const allPrs = await prFetcher(integrationBranch, options.repoDir);
  const wavemillPrs = allPrs.filter(isWavemillPr);

  // HOK-3181: Reconcile merge labels before decisioning
  const { reconcileMergeLabels } = await import('./merge-labels.ts');
  await reconcileMergeLabels(wavemillPrs, options.repoDir);

  if (integrationHealth.state === 'unhealthy') {
    return {
      integrationHealth,
      eligible: [],
      blocked: [],
      waitingReady: wavemillPrs.filter(isReadyPr).map(toWaitingReadyCandidate),
      nextPR: null,
    };
  }

  const openPrNumbers = new Set(wavemillPrs.map((pr) => pr.number));
  const blocked: BlockedCandidate[] = [];
  let eligibleWorkItems: EligibleWorkItem[] = [];
  const crossPrGuardChecker = options.crossPrGuardChecker ?? defaultCrossPrGuardChecker;
  const blockedLabelClearer = options.blockedLabelClearer ?? defaultBlockedLabelClearer;
  const prStateMarkerReader = options.prStateMarkerReader ?? readPrStateMarker;
  const prStateMarkerWriter = options.prStateMarkerWriter ?? writePrStateMarker;
  const blockedPrLiveStateProber = options.blockedPrLiveStateProber ?? defaultBlockedPrLiveStateProber;
  const workItemByNumber = new Map<number, { pr: GhPrListEntry; metadata: PrMetadata | null }>();

  for (const pr of wavemillPrs) {
    const metadataResult = getValidMetadata(pr.body);
    workItemByNumber.set(pr.number, { pr, metadata: metadataResult.metadata });
    const reason = await getInitialBlockReason(
      pr,
      metadataResult.metadata,
      metadataResult.validation,
      openPrNumbers,
      {
        repoDir: options.repoDir,
        integrationBranch,
        crossPrGuardChecker,
        blockedLabelClearer,
        prStateMarkerReader,
        prStateMarkerWriter,
        blockedPrLiveStateProber,
      },
    );

    if (reason) {
      blocked.push(toBlockedCandidate(pr, reason));
      continue;
    }

    eligibleWorkItems.push({ pr, metadata: metadataResult.metadata });
  }

  const dependencyBlocked = removeCandidatesWithBlockedDependencies(eligibleWorkItems);
  blocked.push(...dependencyBlocked.blocked);
  eligibleWorkItems = dependencyBlocked.eligible;

  const cycleResult = computeDependencyDepths(eligibleWorkItems);
  blocked.push(...cycleResult.cycleBlocked);

  const challengeResult = await applyChallengePairGates(
    cycleResult.eligible,
    blocked,
    options.repoDir,
    { ...options.challengeGateOptions, ...options.challengeGateDeps },
  );
  blocked.length = 0;
  blocked.push(...challengeResult.blocked);

  const cleanupLoser = options.loserCleanup ?? defaultLoserCleanup;
  for (const candidate of challengeResult.loserCleanupCandidates) {
    try {
      cleanupLoser(candidate, options.repoDir);
    } catch {
      // Cleanup failure is non-fatal; the loser remains blocked for manual review.
    }
  }

  const eligible = challengeResult.eligible
    .map((item) => ({
      number: item.pr.number,
      title: item.pr.title,
      headBranch: item.pr.headRefName,
      createdAt: item.pr.createdAt,
      dependencyDepth: item.dependencyDepth,
      headSha: item.pr.headRefOid,
      featureDir: resolveReadyStateDir(options.repoDir, item.pr, item.metadata) ?? undefined,
    }))
    .sort((a, b) => a.dependencyDepth - b.dependencyDepth || a.createdAt.localeCompare(b.createdAt));

  // REQ-F5 (HOK-2919): when the mill's merge queue calls a PR a merge
  // candidate while tend blocks it, the two subsystems hold contradictory
  // views. Surface the disagreement instead of silently resolving it in
  // favour of the block.
  for (const blockedCandidate of blocked) {
    const workItem = workItemByNumber.get(blockedCandidate.number);
    if (!workItem) {
      continue;
    }
    if (blockedCandidate.labels === undefined) {
      blockedCandidate.labels = [...labelSet(workItem.pr)];
    }
    emitMillTendDisagreementFinding(options.repoDir, workItem.pr, workItem.metadata, blockedCandidate);
  }

  return {
    integrationHealth,
    eligible,
    blocked,
    nextPR: eligible[0]?.number ?? null,
  };
}

export function formatStatusLine(
  decision: TendDecision,
  opts: {
    action?: string;
    lastPR?: number | null;
    iteration?: number;
    pollStartedAt?: string;
    pollCompletedAt?: string | null;
  } = {},
): string {
  const health = decision.integrationHealth.state === 'healthy' ? 'ok' : 'unhealthy';
  const last = typeof opts.lastPR === 'number' ? `#${opts.lastPR}` : 'none';
  const action = opts.action ?? 'idle';

  const advisory = decision.integrationHealth.state === 'healthy'
    && decision.integrationHealth.advisoryFailures
    && decision.integrationHealth.advisoryFailures.length > 0
    ? decision.integrationHealth.advisoryFailures
        .map((f) => `${f.name}: ${f.conclusion}`)
        .join(', ')
    : null;

  const parts = [
    typeof opts.iteration === 'number' ? `iter=${opts.iteration}` : null,
    opts.pollStartedAt ? `poll_started=${opts.pollStartedAt}` : null,
    opts.pollCompletedAt ? `poll_completed=${opts.pollCompletedAt}` : null,
    `eligible=${decision.eligible.length}`,
    `blocked=${decision.blocked.length}`,
    `health=${health}`,
    decision.integrationHealth.state === 'unhealthy' && decision.integrationHealth.reason
      ? `reason=${quoteStatusValue(decision.integrationHealth.reason)}`
      : null,
    advisory ? `advisory=${quoteStatusValue(advisory)}` : null,
    `last=${last}`,
    `action=${action}`,
  ];

  return parts.filter((part): part is string => part !== null).join(' ');
}

function quoteStatusValue(value: string): string {
  return JSON.stringify(truncateReason(value.replace(/\s+/g, ' ').trim(), 200));
}

export async function executeMerge(
  candidate: TendCandidate,
  options: ExecuteMergeOptions,
): Promise<MergeExecutionResult> {
  const deps = mergeExecutionDeps(options.deps, options.repoDir);
  const integrationConfig = getIntegrationConfig(options.repoDir);
  const integrationBranch = getConfiguredIntegrationBranch(options.repoDir);

  validateBranchName(candidate.headBranch, 'PR branch');

  let activeMerges: number[];
  try {
    activeMerges = await listMergingPrs(options.repoDir, deps);
  } catch (error) {
    console.warn(`tend: merge-lane probe failed for PR #${candidate.number}: ${errorMessage(error)}`);
    return {
      status: 'skipped',
      prNumber: candidate.number,
      phase: 'merge-lane-probe',
      failureExcerpt: truncateOutput(outputFromError(error)),
      haltLoop: false,
    };
  }
  if (activeMerges.length > 0) {
    const remaining = await reclaimStaleMergeLocks(
      activeMerges,
      integrationConfig.mergeLockTimeoutMinutes,
      options.repoDir,
      deps,
    );
    if (remaining.length > 0) {
      return {
        status: 'skipped',
        prNumber: candidate.number,
        phase: 'merge-lane-held',
        heldBy: remaining,
        haltLoop: false,
      };
    }
    // Every holder's lock was stale and reclaimed — the lane is free, proceed.
  }

  // The block closure is hoisted above the handoff check (HOK-3108) so the
  // handoff-claim rejection path can drive `wm:blocked` when the budget is
  // exhausted. It depends only on `candidate`, `options`, and `deps`, so
  // moving it above `acquireMerging` is safe: `releaseToBlocked` (which is
  // `setWavemillBlocked`) removes both wm:ready and wm:merging, so a block
  // before wm:merging is applied is valid.
  const block = async (phase: string, output: string): Promise<MergeExecutionResult> => {
    const failureExcerpt = truncateOutput(output);
    try {
      postFailureComment(candidate.number, buildFailureComment(phase, failureExcerpt), options.repoDir, deps.shellRunner);
    } catch {
      // Comment posting failure is non-fatal; always release the PR from merging state.
    }
    try {
      await retryTransient(() => deps.releaseToBlocked(candidate.number), {
        label: 'set blocked label',
        sleep: deps.retrySleep,
      });
    } catch (error) {
      // Non-fatal, but never silent: a failed release leaves wm:merging applied,
      // deadlocking the lane until the stale-lock timeout reclaims it.
      console.warn(
        `tend: failed to release PR #${candidate.number} from merging to blocked; `
        + `wm:merging may be leaked until the stale-lock timeout reclaims it: ${errorMessage(error)}`,
      );
    }
    return { status: 'blocked', prNumber: candidate.number, phase, failureExcerpt, haltLoop: false };
  };

  // HOK-3176: label wm:blocked only for a failure the policy allowlists as
  // terminal or recognises as a code failure. Anything else — a dropped
  // connection, an unrecognised error — retries under the bounded
  // tend-transient-recovery budget first.
  const blockUnlessRetryable = async (
    worktreePath: string,
    phase: string,
    output: string,
    evidence: Partial<FailureEvidence> = {},
  ): Promise<MergeExecutionResult> => {
    const decision = classifyFailure({ ...evidence, stage: 'tend', detail: output });
    if (decision.class !== 'retryable') {
      return block(phase, output);
    }
    return deferRetryableTendFailure({
      candidate,
      repoDir: options.repoDir,
      phase,
      output,
      rationale: decision.rationale,
      baseSha: readRemoteBranchShaBestEffort(worktreePath, integrationBranch, deps.shellRunner),
      deps,
      block,
    });
  };

  // Ready → Tend handoff is required before merge. In production, selection
  // always attaches `headSha` from GitHub's live headRefOid; when it is present
  // but `featureDir` is missing (PR #1513 shape) the PR carries an agent-applied
  // `wm:ready` that the mill never validated, so treat the label as untrusted
  // and strip it (HOK-3107). The `!candidate.headSha` branch remains a legacy
  // test-only tolerance where selection did not attach live head metadata.
  if (candidate.headSha) {
    if (!candidate.featureDir) {
      try {
        deps.stripUntrustedReady(candidate.number, options.repoDir);
      } catch {
        // stripUntrustedReady is best-effort; a failure must never halt tend.
      }
      return {
        status: 'skipped',
        prNumber: candidate.number,
        phase: 'handoff',
        failureExcerpt: 'PR carried wm:ready without a resolvable feature dir; label stripped as untrusted (no Ready → Tend handoff was ever published for this PR).',
        haltLoop: false,
      };
    }
    // Selection may have happened seconds ago. Re-read GitHub before claiming
    // so a force-push cannot inherit the old Ready token.
    const liveHead = readPrMergeDiagnostics(candidate.number, options.repoDir, deps.shellRunner).headRefOid;
    if (!liveHead || liveHead !== candidate.headSha) {
      // Head-changed skip stays unbudgeted (transient by definition — the next
      // poll re-reads GitHub). HOK-3108: expose both SHAs so the loop's log
      // line names the mismatch instead of a generic message.
      return {
        status: 'skipped',
        prNumber: candidate.number,
        phase: 'handoff',
        failureExcerpt: `GitHub PR head changed or could not be verified before Tend ownership claim `
          + `(selected=${candidate.headSha}, live=${liveHead || '(unavailable)'})`,
        haltLoop: false,
      };
    }
    const handoff = await claimReadyHandoff(candidate.featureDir, candidate.number, liveHead);
    if (handoff.outcome !== 'claimed' && handoff.outcome !== 'already-claimed') {
      try {
        deps.stripUntrustedReady(candidate.number, options.repoDir);
      } catch {
        // stripUntrustedReady is best-effort; a failure must never halt tend.
      }
      return handleHandoffClaimRejection({
        candidate,
        liveHead,
        claim: handoff,
        repoDir: options.repoDir,
        deps,
        block,
      });
    }
    // Successful (or already-claimed) claim: clear the handoff-claim budget.
    // A relabel wm:ready at the same head after a self-heal or a legitimate
    // re-publish then starts a fresh budget. New heads reset automatically.
    try {
      deps.handoffClaimRetry.clear(candidate.number, options.repoDir);
    } catch (error) {
      console.warn(`tend: failed to clear handoff-claim retry budget for PR #${candidate.number}: ${errorMessage(error)}`);
    }
  }

  try {
    await retryTransient(() => deps.acquireMerging(candidate.number), {
      label: 'set merging label',
      sleep: deps.retrySleep,
    });
  } catch (error) {
    try {
      await retryTransient(() => deps.restoreReady(candidate.number), {
        label: 'restore ready label',
        sleep: deps.retrySleep,
      });
    } catch (restoreError) {
      // Preserve the acquisition failure in the result, but never silently: a
      // failed restore can leave wm:merging applied, deadlocking the lane
      // until the stale-lock timeout reclaims it.
      console.warn(
        `tend: failed to restore wm:ready on PR #${candidate.number} after merging-label acquisition failed; `
        + `wm:merging may be leaked until the stale-lock timeout reclaims it: ${errorMessage(restoreError)}`,
      );
    }
    return {
      status: 'skipped',
      prNumber: candidate.number,
      phase: 'label',
      failureExcerpt: truncateOutput(outputFromError(error)),
      haltLoop: false,
    };
  }

  const emitPhaseProgress = async (phase: ScratchPrepPhase | 'heartbeat'): Promise<void> => {
    if (!options.onPhaseProgress) return;
    try {
      await options.onPhaseProgress({
        prNumber: candidate.number,
        phase,
        at: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        `tend: onPhaseProgress callback failed for PR #${candidate.number} phase=${phase}: ${errorMessage(error)}`,
      );
    }
  };

  const prepRunner = deps.prepRunnerFactory(options.repoDir, {
    onHeartbeat: () => {
      // A best-effort tick — the callback is fire-and-forget from the runner.
      void emitPhaseProgress('heartbeat');
    },
  });

  let worktreeResult: MergeExecutionResult | null;
  try {
    worktreeResult = await withScratchWorktree(
      {
        prNumber: candidate.number,
        prBranch: candidate.headBranch,
        repoDir: options.repoDir,
        candidate,
        shellRunner: deps.shellRunner,
        prepRunner,
        emitProgress: emitPhaseProgress,
      },
      async (worktreePath) => {
        await recordLaneProgressSafe(deps, candidate.number, 'merge-attempt', options.repoDir);

        let pushedHeadSha: string | undefined;
        try {
          const rebaseResult = await rebaseAndPush(worktreePath, candidate.headBranch, integrationBranch, deps.shellRunner, {
            onBeforePush: async (preSha, newSha) => {
              // HOK-3039: fail-closed marker write BEFORE the push. If we
              // cannot record that a mutation is starting, we must abort to
              // the block path rather than push untracked. Every other prep
              // marker is best-effort.
              await writeScratchPrepMarker(options.repoDir, {
                prNumber: candidate.number,
                headBranch: candidate.headBranch,
                headSha: candidate.headSha,
                featureDir: candidate.featureDir,
                phase: 'push',
                worktreePath,
                prePushSha: preSha,
                rebasedHeadSha: newSha,
              });
            },
            onAfterPush: async () => {
              await writeScratchPrepMarkerBestEffort(options.repoDir, {
                prNumber: candidate.number,
                headBranch: candidate.headBranch,
                headSha: candidate.headSha,
                featureDir: candidate.featureDir,
                phase: 'pushed',
                worktreePath,
              });
            },
          });
          pushedHeadSha = rebaseResult.headSha || undefined;
          if (rebaseResult.rebased) {
            try {
              await rebindPushedTendHead(candidate.number, candidate.featureDir, candidate.headSha, rebaseResult.headSha, options.repoDir, deps);
            } catch (error) {
              const handoffOutcome = await handleHandoffRebindFailure({
                candidate,
                repoDir: options.repoDir,
                pushedHeadSha: rebaseResult.headSha,
                error,
                deps,
                block,
              });
              return handoffOutcome;
            }
            await recordLaneProgressSafe(deps, candidate.number, 'rebase', options.repoDir);
            await recordLaneProgressSafe(deps, candidate.number, 'ci-restart', options.repoDir);
          }
        } catch (error) {
          return blockUnlessRetryable(worktreePath, 'rebase', outputFromError(error));
        }

        const checks = await waitForChecks(
          candidate.number,
          options.repoDir,
          deps.shellRunner,
          {
            requiredChecks: integrationConfig.requiredChecks,
            retrySleep: deps.retrySleep,
            expectedHeadSha: pushedHeadSha,
          },
        );
        if (checks.outcome !== 'pass') {
          // A red check is a recognised code failure (blocked for
          // remediation) unless its output is runner/network noise; a wait
          // that timed out or lost the head is retried.
          return blockUnlessRetryable(worktreePath, 'checks', checks.summary, {
            failureKind: checks.outcome === 'fail' ? 'checks-failed' : `checks-${checks.outcome}`,
          });
        }

        try {
          const ready = await deps.readyChecker(candidate.number, options.repoDir);
          if (!ready.ready) {
            // A typed not-ready verdict is the ready gate doing its job.
            return block('ready', ready.reason || 'ready check failed');
          }
        } catch (error) {
          return blockUnlessRetryable(worktreePath, 'ready', outputFromError(error));
        }

        try {
          await writeScratchPrepMarkerBestEffort(options.repoDir, {
            prNumber: candidate.number,
            headBranch: candidate.headBranch,
            headSha: candidate.headSha,
            featureDir: candidate.featureDir,
            phase: 'merge',
            worktreePath,
          });
          await mergeWithTransientRetry(
            candidate.number,
            integrationConfig.mergeMethod,
            integrationConfig.requiredChecks,
            options.repoDir,
            deps,
          );
        } catch (error) {
          const recovery = await attemptStrictBaseRecovery({
            candidate,
            worktreePath,
            integrationBranch,
            repoDir: options.repoDir,
            deps,
            mergeErrorOutput: outputFromError(error),
          });
          if (recovery.result) {
            return recovery.result;
          }
          return block('merge', recovery.blockDetail ?? outputFromError(error));
        }

        await recordLaneProgressSafe(deps, candidate.number, 'merged', options.repoDir);
        try {
          deps.strictBaseRetry.clear(candidate.number, options.repoDir);
        } catch (error) {
          console.warn(`tend: failed to clear strict-base retry budget for PR #${candidate.number}: ${errorMessage(error)}`);
        }
        try {
          deps.scratchPrepRetry.clear(candidate.number, options.repoDir);
        } catch (error) {
          console.warn(`tend: failed to clear scratch-prep-recovery budget for PR #${candidate.number}: ${errorMessage(error)}`);
        }
        try {
          deps.handoffRebindRetry.clear(candidate.number, options.repoDir);
        } catch (error) {
          console.warn(`tend: failed to clear handoff-rebind retry budget for PR #${candidate.number}: ${errorMessage(error)}`);
        }
        try {
          deps.transientRetry.clear(candidate.number, options.repoDir);
        } catch (error) {
          console.warn(`tend: failed to clear ${TEND_TRANSIENT_RECOVERY_BUCKET} budget for PR #${candidate.number}: ${errorMessage(error)}`);
        }
        clearTendHandoffBlockSentinel(options.repoDir, candidate.number);
        clearTendHandoffContradictionObserved(options.repoDir, candidate.number);

        if (integrationConfig.deleteBranchAfterMerge && taskStateAuthorizesRemoteBranchDeletion(options.repoDir, candidate.headBranch)) {
          try {
            deps.shellRunner(
              `git push origin --delete ${escapeShellArg(candidate.headBranch)}`,
              { encoding: 'utf-8', cwd: options.repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
            );
          } catch (error) {
            console.warn(
              `tend: post-merge remote branch cleanup failed for PR #${candidate.number} (${candidate.headBranch}): ${errorMessage(error)}`,
            );
          }
        }

        try {
          await retryTransient(() => deps.releaseMerged(candidate.number), {
            label: 'set merged label',
            sleep: deps.retrySleep,
          });
        } catch (error) {
          console.warn(`tend: failed to mark PR #${candidate.number} merged after merge completed: ${errorMessage(error)}`);
        }
        return null;
      },
    );
  } catch (error) {
    if (error instanceof WorktreePrepTimeoutError) {
      const timeoutResult = await handleWorktreePrepTimeout({
        candidate,
        repoDir: options.repoDir,
        deps,
        error,
        block,
      });
      // Marker cleared inside handleWorktreePrepTimeout on all safe paths.
      return timeoutResult;
    }
    clearScratchPrepMarkerBestEffort(options.repoDir, candidate.number);
    return block('worktree', outputFromError(error));
  }

  // Every path below is post-worktree; the marker (if any) is safe to clear:
  // either the merge succeeded, or a `block` was returned from inside the
  // withScratchWorktree callback (in which case the marker also no longer
  // reflects an active mutation).
  clearScratchPrepMarkerBestEffort(options.repoDir, candidate.number);

  if (worktreeResult) {
    return worktreeResult;
  }

  let health: IntegrationHealth;
  try {
    health = await deps.healthChecker(integrationBranch, options.repoDir);
  } catch (error) {
    health = { state: 'unhealthy', reason: `health-check-error: ${errorMessage(error)}` };
  }

  if (health.state === 'unhealthy') {
    const reason = health.reason || 'integration branch is unhealthy after merge';
    try {
      postFailureComment(
        candidate.number,
        buildFailureComment('integration', `Integration branch \`${integrationBranch}\` is unhealthy after merge: ${reason}`),
        options.repoDir,
        deps.shellRunner,
      );
    } catch (error) {
      console.warn(`tend: failed to post integration halt comment for PR #${candidate.number}: ${errorMessage(error)}`);
    }
    return {
      status: 'halted',
      prNumber: candidate.number,
      phase: 'integration',
      failureExcerpt: truncateOutput(reason),
      haltLoop: true,
    };
  }

  return { status: 'merged', prNumber: candidate.number, haltLoop: false };
}

export function truncateOutput(output: string, maxLines = 30): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return output.trim();
  }

  return ['... (truncated)', ...lines.slice(-maxLines)].join('\n').trim();
}

export function buildFailureComment(phase: string, excerpt: string): string {
  const title = phase.charAt(0).toUpperCase() + phase.slice(1);
  const escaped = (excerpt || '(no output)').replace(/```/g, '`  `');
  return [
    `### Wavemill ${title} failed`,
    '',
    '```text',
    escaped,
    '```',
  ].join('\n');
}

interface WithScratchWorktreeOptions {
  prNumber: number;
  prBranch: string;
  repoDir: string;
  candidate: TendCandidate;
  shellRunner: MergeExecutionDeps['shellRunner'];
  prepRunner: ScratchPrepRunner;
  emitProgress: (phase: ScratchPrepPhase | 'heartbeat') => Promise<void>;
}

async function withScratchWorktree<T>(
  options: WithScratchWorktreeOptions,
  fn: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const { prNumber, prBranch, repoDir, candidate, shellRunner, prepRunner, emitProgress } = options;
  validateBranchName(prBranch, 'PR branch');

  const commonGitDir = String(shellRunner('git rev-parse --git-common-dir', {
    encoding: 'utf-8',
    cwd: repoDir,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();
  // `--git-common-dir` may be relative to repoDir (e.g. `.git`); resolve it
  // so the scratch path never depends on the process cwd.
  const tendWorktreeDir = join(resolve(repoDir, commonGitDir), 'wavemill-tend');
  const worktreePath = join(tendWorktreeDir, String(prNumber));

  const markerBase = {
    prNumber,
    headBranch: prBranch,
    headSha: candidate.headSha,
    featureDir: candidate.featureDir,
    worktreePath,
  };

  // reap phase: safe. No remote mutation possible during reap/fetch/add.
  await writeScratchPrepMarkerBestEffort(repoDir, { ...markerBase, phase: 'reap' });
  await emitProgress('reap');
  await reapStaleTendWorktrees(tendWorktreeDir, repoDir, prepRunner);

  // fetch phase.
  await writeScratchPrepMarkerBestEffort(repoDir, { ...markerBase, phase: 'fetch' });
  await emitProgress('fetch');
  await prepRunner.run(
    `git fetch origin ${escapeShellArg(prBranch)} 2>&1`,
    { cwd: repoDir, phase: 'fetch', perCommandDeadlineMs: GIT_MUTATION_TIMEOUT_MS },
  );

  // add phase: use --detach so the worktree gets a detached HEAD at the
  // PR's remote tip rather than the branch by name (mill's task worktree
  // already holds prBranch checked out).
  await writeScratchPrepMarkerBestEffort(repoDir, { ...markerBase, phase: 'add' });
  await emitProgress('add');
  await prepRunner.run(
    `git worktree add --detach ${escapeShellArg(worktreePath)} ${escapeShellArg(`origin/${prBranch}`)}`,
    { cwd: repoDir, phase: 'add', perCommandDeadlineMs: GIT_MUTATION_TIMEOUT_MS },
  );

  // ready phase: worktree prepared, no remote mutation yet.
  await writeScratchPrepMarkerBestEffort(repoDir, { ...markerBase, phase: 'ready' });
  await emitProgress('ready');

  try {
    return await fn(worktreePath);
  } finally {
    try {
      shellRunner(
        `git worktree remove --force ${escapeShellArg(worktreePath)}`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
      );
    } catch {
      // A cleanup failure should not change the PR's merge outcome.
    }
  }
}

/**
 * Best-effort removal of leftover tend scratch worktrees from interrupted
 * runs. `git worktree remove` handles registered worktrees; the follow-up
 * rmSync covers directories whose registration was already pruned (worktree
 * remove fails on those, but `git worktree add` would still refuse the
 * non-empty directory). A final `git worktree prune` drops any registration
 * whose directory is now gone.
 *
 * Runs through the shared prep runner (HOK-3039) so the shared end-to-end
 * deadline covers reap → fetch → add, and the process-group kill covers any
 * git descendants (hooks, git-remote-*) an interrupted run left behind.
 */
async function reapStaleTendWorktrees(
  tendWorktreeDir: string,
  repoDir: string,
  prepRunner: ScratchPrepRunner,
): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(tendWorktreeDir);
  } catch {
    return; // Missing directory means nothing to reap.
  }
  if (entries.length === 0) {
    return;
  }

  for (const entry of entries) {
    const stalePath = join(tendWorktreeDir, entry);
    try {
      await prepRunner.run(
        `git worktree remove --force ${escapeShellArg(stalePath)}`,
        { cwd: repoDir, phase: 'reap', perCommandDeadlineMs: GIT_MUTATION_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof WorktreePrepTimeoutError) {
        throw error; // propagate — the enclosing withScratchWorktree turns it into a typed timeout result
      }
      // Registration may already be pruned; the directory removal below still applies.
    }
    try {
      if (existsSync(stalePath)) {
        rmSync(stalePath, { recursive: true, force: true });
      }
    } catch (error) {
      console.warn(`tend: failed to delete stale tend worktree directory ${stalePath}: ${errorMessage(error)}`);
      continue;
    }
    console.warn(`tend: reaped stale tend worktree ${stalePath}`);
  }

  try {
    await prepRunner.run(
      'git worktree prune',
      { cwd: repoDir, phase: 'reap', perCommandDeadlineMs: GIT_MUTATION_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof WorktreePrepTimeoutError) {
      throw error;
    }
    console.warn(`tend: git worktree prune failed after reaping stale tend worktrees: ${errorMessage(error)}`);
  }
}

/**
 * Evaluate every current wm:merging holder against the stale-lock timeout and
 * reclaim locks that are provably stale. Returns the holders still considered
 * live (the lane stays closed while this list is non-empty).
 *
 * Fail-safe bias: any uncertainty — timeout disabled, events query failed, no
 * labeled event found, reclaim label call failed — treats the holder as NOT
 * stale. A wrongly-held skip self-resolves on a later poll once the lock ages
 * past the threshold; a wrongly-reclaimed lock could double-run the merge lane.
 */
async function reclaimStaleMergeLocks(
  activeMerges: number[],
  mergeLockTimeoutMinutes: number,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<number[]> {
  const timeoutMs = mergeLockTimeoutMinutes * 60_000;
  const remaining: number[] = [];

  for (const holder of activeMerges) {
    // HOK-3039: consult the scratch-prep marker before the label-age reclaim.
    // A marker in an uncertain phase (push/merge) means the previous run may
    // have started remote mutation — even past the generic stale-lock
    // timeout, we must not reclaim without deterministic evidence that the
    // push did not land. Fail closed: keep the holder marked live.
    const marker = readScratchPrepMarker(repoDir, holder);
    if (marker && !SAFE_PREP_PHASES.has(marker.phase) && !isOwnerAlive(marker.pid)) {
      // Owner is dead and the marker phase is uncertain: only remote-state
      // check can resolve this, and that is `reconcileScratchPrepState`'s
      // responsibility. From reclaim's perspective, the holder stays live.
      remaining.push(holder);
      continue;
    }
    if (marker && isOwnerAlive(marker.pid)) {
      // Owner is alive: another Tend run is actively holding the lane; do
      // not reclaim even if the GitHub label timestamp says the lock is old.
      remaining.push(holder);
      continue;
    }

    const appliedAtMs = timeoutMs > 0 ? await readMergingLabelAppliedAt(holder, repoDir, deps) : null;
    if (appliedAtMs === null || deps.currentTimeMs() - appliedAtMs <= timeoutMs) {
      remaining.push(holder);
      continue;
    }

    const heldMinutes = Math.round((deps.currentTimeMs() - appliedAtMs) / 60_000);
    try {
      await retryTransient(() => deps.reclaimStaleMerging(holder), {
        label: 'reclaim stale merging label',
        sleep: deps.retrySleep,
      });
    } catch (error) {
      console.warn(
        `tend: failed to reclaim stale wm:merging lock from PR #${holder} (held ~${heldMinutes}m): ${errorMessage(error)}`,
      );
      remaining.push(holder);
      continue;
    }

    // Reclaim succeeded: clear any lingering scratch-prep marker so the next
    // execution starts with a clean state.
    clearScratchPrepMarkerBestEffort(repoDir, holder);

    console.warn(
      `tend: reclaimed stale wm:merging lock from PR #${holder} (held ~${heldMinutes}m > ${mergeLockTimeoutMinutes}m timeout)`,
    );
    try {
      postFailureComment(
        holder,
        [
          '### Wavemill merge-lane lock reclaimed',
          '',
          `This PR held \`${WM_LABELS.merging}\` for ~${heldMinutes} minutes without merging `
          + `(timeout: ${mergeLockTimeoutMinutes} minutes), blocking the merge lane. `
          + `The lock was reclaimed and the PR returned to \`${WM_LABELS.ready}\`; `
          + 'it will be re-evaluated on a future tend poll.',
        ].join('\n'),
        repoDir,
        deps.shellRunner,
      );
    } catch {
      // The audit comment is best-effort; the reclaim itself already succeeded.
    }
  }

  return remaining;
}

/**
 * Read the epoch-ms timestamp of the most recent `labeled` event applying
 * wm:merging to a PR, from the GitHub issue-events API. GitHub is the
 * authoritative cross-process record of lock age — the label may have been
 * applied by a process on another machine or one that has since died, so a
 * local marker would be lost with it.
 *
 * Returns null (treated as "not provably stale") when the query fails, the
 * repo cannot be resolved, or no matching event exists.
 */
async function readMergingLabelAppliedAt(
  prNumber: number,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<number | null> {
  let repo: string | null;
  try {
    const remoteUrl = String(deps.shellRunner('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: repoDir,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })).trim();
    repo = parseOwnerRepoFromRemoteUrl(remoteUrl);
  } catch {
    repo = null;
  }
  if (!repo) {
    console.warn(`tend: cannot resolve origin repo for wm:merging staleness check on PR #${prNumber}`);
    return null;
  }

  let output: string;
  try {
    // --jq runs per page under --paginate, emitting NDJSON lines — this
    // sidesteps --paginate's concatenated-arrays JSON output.
    output = await retryTransient(
      () => String(deps.shellRunner(
        `gh api ${escapeShellArg(`repos/${repo}/issues/${prNumber}/events`)} --paginate `
        + `--jq ${escapeShellArg('.[] | select(.event == "labeled") | {name: .label.name, at: .created_at}')}`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      )),
      { label: 'gh issue label events', sleep: deps.retrySleep },
    );
  } catch (error) {
    console.warn(`tend: failed to read label events for PR #${prNumber}: ${errorMessage(error)}`);
    return null;
  }

  let latestMs: number | null = null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.name !== WM_LABELS.merging || typeof event.at !== 'string') {
      continue;
    }
    const appliedAtMs = Date.parse(event.at);
    if (Number.isFinite(appliedAtMs) && (latestMs === null || appliedAtMs > latestMs)) {
      latestMs = appliedAtMs;
    }
  }

  return latestMs;
}

/**
 * Startup reconciliation for scratch-prep markers (HOK-3039).
 *
 * Scans every per-PR merge-lane directory for a `scratch-prep.json`. For
 * each nonterminal marker whose owning process is dead:
 *
 * - Safe phases (`reap`/`fetch`/`add`/`ready`): clean the scratch dir, drop
 *   the wm:merging label back to wm:ready, delete the marker, record one
 *   attempt in the scratch-prep-recovery bounded-retry bucket keyed on
 *   `(mergeLaneStateDir, bucket, headSha)` — this restores the safe state
 *   on the next Tend loop start, not after 45 minutes of stale-lock wait.
 *
 * - `push` phase: deterministic remote-state check. If origin/<branch> is
 *   still the pre-push SHA, the push never landed → treat as safe. If it
 *   matches the rebased head we intended to push, the push landed → clean
 *   scratch, restore ready, delete marker. Anything else or fetch failure
 *   → uncertain: fail closed, keep wm:merging, retain scratch with reason,
 *   surface a bounded diagnostic, leave the marker so the check re-runs.
 *
 * - `merge` phase: `gh pr view` → merged → run merged finalization; open
 *   with unchanged head → safe; query fails → uncertain.
 *
 * Live-owner markers (dead in normal recovery) return `active-run` — the
 * duplicate-mutation guard. Combined with `acquireTendLock`, this ensures
 * a watchdog respawn cannot start a second merge while the first may still
 * be pushing.
 */
export async function reconcileScratchPrepState(
  repoDir: string,
  overrides: Partial<MergeExecutionDeps> = {},
): Promise<ScratchPrepReconcileOutcome[]> {
  const deps = mergeExecutionDeps(overrides, repoDir);
  const outcomes: ScratchPrepReconcileOutcome[] = [];
  const markers = listScratchPrepMarkers(repoDir);
  for (const marker of markers) {
    try {
      outcomes.push(await reconcileOneScratchPrepMarker(marker, repoDir, deps));
    } catch (error) {
      console.warn(
        `tend: scratch-prep reconciliation failed for PR #${marker.prNumber}: ${errorMessage(error)}`,
      );
      outcomes.push({
        kind: 'recovery-uncertain',
        prNumber: marker.prNumber,
        phase: marker.phase,
        detail: `reconciliation threw: ${errorMessage(error)}`,
      });
    }
  }
  return outcomes;
}

async function reconcileOneScratchPrepMarker(
  marker: ScratchPrepMarker,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<ScratchPrepReconcileOutcome> {
  if (isOwnerAlive(marker.pid)) {
    return { kind: 'active-run', prNumber: marker.prNumber, pid: marker.pid, phase: marker.phase };
  }

  if (SAFE_PREP_PHASES.has(marker.phase)) {
    return await recoverSafePhaseMarker(marker, repoDir, deps);
  }

  if (marker.phase === 'push' || marker.phase === 'pushed') {
    return await reconcilePushMarker(marker, repoDir, deps);
  }

  if (marker.phase === 'merge') {
    return await reconcileMergeMarker(marker, repoDir, deps);
  }

  return { kind: 'none' };
}

async function recoverSafePhaseMarker(
  marker: ScratchPrepMarker,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<ScratchPrepReconcileOutcome> {
  // Bounded-retry key on the head Tend claimed at handoff. When headSha is
  // absent (legacy pre-handoff candidates), key on the head branch so the
  // helper still resets on a new branch tip.
  const headSha = marker.headSha ?? marker.headBranch;
  const retry = consultTendRetryBudget({
    ops: deps.scratchPrepRetry,
    bucket: SCRATCH_PREP_RECOVERY_BUCKET,
    prNumber: marker.prNumber,
    headSha,
    repoDir,
    exhaustedReason: () => `scratch-prep-recovery exhausted at head=${headSha}`,
  });
  if (!retry.defer && retry.gateError) {
    return {
      kind: 'recovery-uncertain',
      prNumber: marker.prNumber,
      phase: marker.phase,
      detail: `bounded-retry gate failed: ${retry.gateError}`,
    };
  }
  if (!retry.defer) {
    try {
      await retryTransient(() => deps.releaseToBlocked(marker.prNumber), {
        label: 'set blocked label after scratch-prep-recovery exhaustion',
        sleep: deps.retrySleep,
      });
    } catch (error) {
      console.warn(
        `tend: failed to set blocked label for PR #${marker.prNumber} after scratch-prep-recovery exhaustion: ${errorMessage(error)}`,
      );
    }
    clearScratchPrepMarkerBestEffort(repoDir, marker.prNumber);
    return { kind: 'exhausted', prNumber: marker.prNumber };
  }
  await cleanScratchWorktreeBestEffort(marker.prNumber, repoDir, deps);
  try {
    await retryTransient(() => deps.restoreReady(marker.prNumber), {
      label: 'restore ready label during scratch-prep reconciliation',
      sleep: deps.retrySleep,
    });
  } catch (error) {
    console.warn(
      `tend: failed to restore wm:ready on PR #${marker.prNumber} during scratch-prep reconciliation: ${errorMessage(error)}`,
    );
  }
  clearScratchPrepMarkerBestEffort(repoDir, marker.prNumber);
  return { kind: 'recovered-retryable', prNumber: marker.prNumber, phase: marker.phase };
}

async function reconcilePushMarker(
  marker: ScratchPrepMarker,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<ScratchPrepReconcileOutcome> {
  // Deterministic remote-state check: fetch origin/<branch> and compare.
  try {
    deps.shellRunner(`git fetch origin ${escapeShellArg(marker.headBranch)} 2>&1`, {
      encoding: 'utf-8',
      cwd: repoDir,
      timeout: GIT_MUTATION_TIMEOUT_MS,
    });
  } catch (error) {
    return recordPushUncertain(marker, repoDir, deps, `fetch failed: ${errorMessage(error)}`);
  }

  let originSha: string;
  try {
    originSha = String(deps.shellRunner(
      `git rev-parse ${escapeShellArg(`origin/${marker.headBranch}`)}`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GIT_COMMAND_TIMEOUT_MS },
    )).trim();
  } catch (error) {
    return recordPushUncertain(marker, repoDir, deps, `rev-parse failed: ${errorMessage(error)}`);
  }

  if (marker.prePushSha && originSha === marker.prePushSha) {
    // Origin has not moved from the pre-push tip → the push never landed.
    // Treat as a safe-phase recovery.
    return await recoverSafePhaseMarker({ ...marker, phase: 'ready' }, repoDir, deps);
  }
  if (marker.rebasedHeadSha && originSha === marker.rebasedHeadSha) {
    // The rebased head is what origin has → the push landed deterministically.
    // Carry Tend's claim to the confirmed pushed head before returning to Ready.
    try {
      await rebindPushedTendHead(marker.prNumber, marker.featureDir, marker.prePushSha, originSha, repoDir, deps);
    } catch (error) {
      return recordPushUncertain(marker, repoDir, deps, `handoff rebind failed: ${errorMessage(error)}`);
    }
    await cleanScratchWorktreeBestEffort(marker.prNumber, repoDir, deps);
    try {
      await retryTransient(() => deps.restoreReady(marker.prNumber), {
        label: 'restore ready label after recovered push',
        sleep: deps.retrySleep,
      });
    } catch (error) {
      console.warn(
        `tend: failed to restore wm:ready on PR #${marker.prNumber} after recovered push: ${errorMessage(error)}`,
      );
    }
    clearScratchPrepMarkerBestEffort(repoDir, marker.prNumber);
    return { kind: 'recovered-pushed', prNumber: marker.prNumber };
  }

  return recordPushUncertain(
    marker,
    repoDir,
    deps,
    `origin=${originSha} does not match prePushSha=${marker.prePushSha ?? '(missing)'} `
    + `or rebasedHeadSha=${marker.rebasedHeadSha ?? '(missing)'}`,
  );
}

async function recordPushUncertain(
  marker: ScratchPrepMarker,
  repoDir: string,
  deps: MergeExecutionDeps,
  detail: string,
): Promise<ScratchPrepReconcileOutcome> {
  // Fail closed: keep the marker (with an updated timestamp), keep the
  // scratch dir with a retained reason, and leave labels untouched so the
  // lane stays closed. reclaimStaleMergeLocks will refuse this holder as
  // long as the marker exists in an uncertain phase.
  const bounded = truncateReason(detail, 400);
  try {
    await writeScratchPrepMarker(repoDir, {
      prNumber: marker.prNumber,
      headBranch: marker.headBranch,
      headSha: marker.headSha,
      featureDir: marker.featureDir,
      phase: marker.phase,
      worktreePath: marker.worktreePath,
      prePushSha: marker.prePushSha,
      rebasedHeadSha: marker.rebasedHeadSha,
      retained: { reason: `push-recovery-uncertain: ${bounded}` },
    });
  } catch (error) {
    console.warn(
      `tend: failed to update scratch-prep marker during push-recovery-uncertain: ${errorMessage(error)}`,
    );
  }
  // Best-effort observer/warning signal so the operator has bounded diagnostics.
  console.warn(
    `tend: scratch-prep recovery uncertain for PR #${marker.prNumber} (${marker.phase}): ${bounded}`,
  );
  // Suppress unused deps warning; deps intentionally reserved for future observer hook.
  void deps;
  return { kind: 'recovery-uncertain', prNumber: marker.prNumber, phase: marker.phase, detail: bounded };
}

async function reconcileMergeMarker(
  marker: ScratchPrepMarker,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<ScratchPrepReconcileOutcome> {
  let diagnostics: PrMergeDiagnostics;
  try {
    diagnostics = readPrMergeDiagnostics(marker.prNumber, repoDir, deps.shellRunner);
  } catch (error) {
    return recordPushUncertain(marker, repoDir, deps, `gh pr view failed: ${errorMessage(error)}`);
  }
  if (diagnostics.unavailableReason) {
    return recordPushUncertain(marker, repoDir, deps, `gh pr view unavailable: ${diagnostics.unavailableReason}`);
  }

  // Compare against the mergeStateStatus and headRefOid to distinguish merged
  // vs still-open. A missing mergeStateStatus is treated as uncertain (fail
  // closed) — we never derive "merged" from absence.
  const mergeStateStatus = (diagnostics.mergeStateStatus ?? '').toUpperCase();
  const observedHead = diagnostics.headRefOid ?? '';
  if (mergeStateStatus === 'MERGED' || /^merged$/i.test(mergeStateStatus)) {
    // Finalize: mark merged, clean the scratch dir, clear the marker.
    try {
      await retryTransient(() => deps.releaseMerged(marker.prNumber), {
        label: 'set merged label after recovered merge',
        sleep: deps.retrySleep,
      });
    } catch (error) {
      console.warn(
        `tend: failed to mark PR #${marker.prNumber} merged during scratch-prep reconciliation: ${errorMessage(error)}`,
      );
    }
    await cleanScratchWorktreeBestEffort(marker.prNumber, repoDir, deps);
    clearScratchPrepMarkerBestEffort(repoDir, marker.prNumber);
    return { kind: 'finalized-merge', prNumber: marker.prNumber };
  }

  if (marker.rebasedHeadSha && observedHead && observedHead === marker.rebasedHeadSha) {
    // PR still open at the same head we intended to merge — safe retry.
    try {
      await rebindPushedTendHead(marker.prNumber, marker.featureDir, marker.prePushSha, observedHead, repoDir, deps);
    } catch (error) {
      return recordPushUncertain(marker, repoDir, deps, `handoff rebind failed: ${errorMessage(error)}`);
    }
    return await recoverSafePhaseMarker({ ...marker, phase: 'ready' }, repoDir, deps);
  }

  return recordPushUncertain(
    marker,
    repoDir,
    deps,
    `mergeStateStatus=${mergeStateStatus || '(missing)'} head=${observedHead || '(missing)'} `
    + `expected=${marker.rebasedHeadSha ?? '(missing)'}`,
  );
}

async function listMergingPrs(repoDir: string, deps: MergeExecutionDeps): Promise<number[]> {
  return retryTransient(
    () => {
      const output = deps.shellRunner(
        `gh pr list --label ${escapeShellArg(WM_LABELS.merging)} --state open --json number`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      );
      const parsed = JSON.parse(String(output)) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('tend: gh pr list returned non-array JSON');
      }
      return parsed
        .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { number?: unknown }).number : null))
        .filter((number): number is number => typeof number === 'number');
    },
    { label: 'gh pr list merging', sleep: deps.retrySleep },
  );
}

/**
 * Backoff schedule (ms) for the read-after-push convergence poll (HOK-3105).
 * The first read has no sleep — GitHub often returns the pushed head on the
 * first attempt. If it does not, we sleep for the schedule entries in order,
 * then re-read. Total wall time ~15s in the worst case.
 */
const HANDOFF_HEAD_POLL_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * Outcome of the read-after-push convergence poll (HOK-3105). The caller
 * distinguishes 'timeout' (GitHub lag — safe to retry on the next Tend cycle)
 * from 'third-head' (a competing push landed — unrecoverable, refuse now).
 */
export type HandoffRebindRefusalKind = 'timeout' | 'third-head';

export class HandoffRebindRefusalError extends Error {
  readonly kind: HandoffRebindRefusalKind;
  readonly prNumber: number;
  readonly pushedHeadSha: string;
  readonly observedHead: string;
  constructor(args: {
    kind: HandoffRebindRefusalKind;
    prNumber: number;
    pushedHeadSha: string;
    observedHead: string;
    message: string;
  }) {
    super(args.message);
    this.name = 'HandoffRebindRefusalError';
    this.kind = args.kind;
    this.prNumber = args.prNumber;
    this.pushedHeadSha = args.pushedHeadSha;
    this.observedHead = args.observedHead;
  }
}

async function pollForPushedHeadConvergence(
  prNumber: number,
  previousHeadSha: string,
  pushedHeadSha: string,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<{ outcome: 'converged'; observedHead: string }
  | { outcome: 'third-head'; observedHead: string }
  | { outcome: 'timeout'; observedHead: string; totalMs: number }> {
  let observedHead = '';
  let totalMs = 0;
  // One immediate read + one read per backoff entry.
  for (let attempt = 0; attempt <= HANDOFF_HEAD_POLL_BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      const sleepMs = HANDOFF_HEAD_POLL_BACKOFF_MS[attempt - 1];
      totalMs += sleepMs;
      await deps.retrySleep(sleepMs);
    }
    const liveHead = readPrMergeDiagnostics(prNumber, repoDir, deps.shellRunner).headRefOid ?? '';
    observedHead = liveHead;
    if (liveHead && liveHead === pushedHeadSha) {
      return { outcome: 'converged', observedHead };
    }
    if (liveHead && liveHead !== pushedHeadSha && liveHead !== previousHeadSha) {
      // A third party pushed — unrecoverable.
      return { outcome: 'third-head', observedHead };
    }
    // Otherwise the lag is still showing the pre-push head (or the read
    // returned nothing); back off and try again.
  }
  return { outcome: 'timeout', observedHead, totalMs };
}

async function rebindPushedTendHead(
  prNumber: number,
  featureDir: string | undefined,
  previousHeadSha: string | undefined,
  pushedHeadSha: string,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<void> {
  if (!featureDir) return; // Legacy Ready artifacts have no handoff.
  if (!previousHeadSha || !pushedHeadSha) throw new Error('Tend handoff cannot be rebound without both head SHAs');
  // HOK-3112: the push already happened, so the task worktree is now behind
  // the PR head whether or not the rebind below succeeds. Mark it stale first
  // so the monitor resyncs it before any Ready re-run — otherwise that re-run
  // republishes the handoff at the stale checkout HEAD and Tend can never
  // claim it again.
  await recordTendPushedHeadBestEffort(featureDir, prNumber, previousHeadSha, pushedHeadSha);
  const convergence = await pollForPushedHeadConvergence(prNumber, previousHeadSha, pushedHeadSha, repoDir, deps);
  if (convergence.outcome === 'third-head') {
    throw new HandoffRebindRefusalError({
      kind: 'third-head',
      prNumber,
      pushedHeadSha,
      observedHead: convergence.observedHead,
      message: `Tend handoff rebind refused: PR #${prNumber} head diverged `
        + `(observed=${convergence.observedHead || '(missing)'}, pushed=${pushedHeadSha})`,
    });
  }
  if (convergence.outcome === 'timeout') {
    throw new HandoffRebindRefusalError({
      kind: 'timeout',
      prNumber,
      pushedHeadSha,
      observedHead: convergence.observedHead,
      message: `Tend handoff rebind refused: PR #${prNumber} live head still `
        + `${convergence.observedHead || '(missing)'} after ${convergence.totalMs}ms poll for pushed ${pushedHeadSha}`,
    });
  }
  const result = await rebindTendHandoff(featureDir, prNumber, previousHeadSha, pushedHeadSha);
  if (result.outcome !== 'claimed' && result.outcome !== 'already-claimed') {
    throw new Error(`Tend handoff rebind refused: PR #${prNumber} has no matching Tend claim`);
  }
}

async function recordTendPushedHeadBestEffort(
  featureDir: string,
  prNumber: number,
  previousHeadSha: string,
  pushedHeadSha: string,
): Promise<void> {
  try {
    await recordTendPushedHead(featureDir, prNumber, previousHeadSha, pushedHeadSha);
  } catch (error) {
    console.warn(
      `tend: failed to mark task worktree stale after push on PR #${prNumber} `
      + `(${previousHeadSha} -> ${pushedHeadSha}): ${errorMessage(error)}`,
    );
  }
}

/**
 * Optional bracketing hooks for rebaseAndPush (HOK-3039).
 *
 * `onBeforePush` runs after the rebase computes both the pre-push SHA and
 * the rebased head we're about to push, but before the actual push executes.
 * The scratch-prep marker is written here (fail-closed) so a crash during
 * the push leaves an authoritative record of what was intended vs pushed.
 *
 * `onAfterPush` runs immediately after a successful push, advancing the
 * marker to `pushed` (best-effort).
 */
interface RebaseAndPushHooks {
  onBeforePush?: (prePushSha: string, rebasedHeadSha: string) => Promise<void> | void;
  onAfterPush?: (rebasedHeadSha: string) => Promise<void> | void;
}

async function rebaseAndPush(
  worktreePath: string,
  prBranch: string,
  integrationBranch: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  hooks: RebaseAndPushHooks = {},
): Promise<{ output: string; headSha: string; rebased: boolean }> {
  validateBranchName(prBranch, 'PR branch');
  validateBranchName(integrationBranch, 'integration branch');

  const output: string[] = [];

  output.push(String(shellRunner(
    `git fetch origin ${escapeShellArg(integrationBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
  )));

  // Capture the PR branch SHA before rebase for SHA-keyed force-with-lease
  const prRemoteRef = `origin/${prBranch}`;
  const prBranchSha = String(shellRunner(`git rev-parse ${escapeShellArg(prRemoteRef)}`, {
    encoding: 'utf-8',
    cwd: worktreePath,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();

  const integrationRemoteRef = `origin/${integrationBranch}`;
  if (isRemoteIntegrationAncestorOfPrHead(integrationRemoteRef, prBranchSha, worktreePath, shellRunner)) {
    output.push(`tend: skipping pre-merge rebase because ${integrationRemoteRef} is already an ancestor of ${prBranchSha}`);
    // Ancestor early return: no push happened, so we deliberately skip the
    // push hooks. The scratch-prep marker stays at 'ready'.
    return { output: output.join('\n'), headSha: prBranchSha, rebased: false };
  }

  try {
    output.push(String(shellRunner(
      `git rebase ${escapeShellArg(integrationRemoteRef)} 2>&1`,
      { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
    )));
  } catch (error) {
    // Explicitly abort rebase on failure
    try {
      shellRunner('git rebase --abort 2>&1', {
        encoding: 'utf-8',
        cwd: worktreePath,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      });
    } catch {
      // Rebase abort failure is best-effort
    }
    throw error;
  }

  // The rebased head is the PR head the subsequent check wait must validate
  // against — checks belonging to the pre-rebase head are superseded.
  const rebasedHeadSha = String(shellRunner('git rev-parse HEAD', {
    encoding: 'utf-8',
    cwd: worktreePath,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();

  if (hooks.onBeforePush) {
    // Fail-closed: if the caller's marker write throws, we do NOT push. That
    // keeps startup reconciliation deterministic — a `push` marker either
    // exists (mutation may have begun) or does not (mutation did not begin).
    await hooks.onBeforePush(prBranchSha, rebasedHeadSha);
  }

  // Push the rebased commits back to origin's <prBranch>. We use HEAD:<branch>
  // syntax because withScratchWorktree intentionally checks out a detached
  // HEAD (so it doesn't fight mill's task worktree for branch ownership).
  // --force-with-lease still keys on origin's pre-rebase SHA — that doesn't
  // depend on local branch ownership.
  output.push(String(shellRunner(
    `git push --force-with-lease=${escapeShellArg(prBranch)}:${escapeShellArg(prBranchSha)} origin HEAD:${escapeShellArg(prBranch)} 2>&1`,
    { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_MUTATION_TIMEOUT_MS },
  )));

  if (hooks.onAfterPush) {
    try {
      await hooks.onAfterPush(rebasedHeadSha);
    } catch (error) {
      // Best-effort: pushed-phase marker write is not load-bearing for
      // recovery correctness — reconciliation re-derives from origin's tip.
      console.warn(`tend: onAfterPush hook failed after push: ${errorMessage(error)}`);
    }
  }

  return { output: output.join('\n'), headSha: rebasedHeadSha, rebased: true };
}

function isRemoteIntegrationAncestorOfPrHead(
  integrationRemoteRef: string,
  prBranchSha: string,
  worktreePath: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): boolean {
  try {
    shellRunner(
      `git merge-base --is-ancestor ${escapeShellArg(integrationRemoteRef)} ${escapeShellArg(prBranchSha)}`,
      { encoding: 'utf-8', cwd: worktreePath, timeout: GIT_COMMAND_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    if (shouldWarnOnAncestryCheckFailure(error)) {
      console.warn(
        `tend: pre-merge ancestry check failed for ${integrationRemoteRef} at ${prBranchSha}; falling back to rebase: ${errorMessage(error)}`,
      );
    }
    return false;
  }
}

function shouldWarnOnAncestryCheckFailure(error: unknown): boolean {
  // git merge-base --is-ancestor exits with code 1 (no output) when not an ancestor.
  // execSync throws with no "not ancestor" text — detect via exit status instead.
  const status = (error as Record<string, unknown>)?.status;
  return status !== 1;
}

export async function waitForChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  options: {
    timeoutMs?: number;
    requiredChecks?: string[];
    retrySleep?: (ms: number) => Promise<void>;
    /**
     * Head SHA the caller expects the PR to be at (e.g. the head it just
     * pushed). When set, checks are only evaluated on polls where the PR head
     * matches — checks from a different head are never mixed in (HOK-2938).
     * A mismatch that persists for HEAD_MISMATCH_MAX_POLLS consecutive polls
     * returns 'head-changed': the head was genuinely superseded by another
     * actor, so this wait's verdict can never apply.
     */
    expectedHeadSha?: string;
    /** Poll interval override for tests; production uses CHECK_POLL_INTERVAL_MS. */
    pollIntervalMs?: number;
  } = {},
): Promise<CheckWaitResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const requiredChecks = options.requiredChecks ?? [];
  const expectedHeadSha = options.expectedHeadSha?.trim() || undefined;
  const pollIntervalMs = options.pollIntervalMs ?? CHECK_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let consecutiveHeadMismatches = 0;

  while (true) {
    // Head-provenance guard: right after a force-push GitHub may briefly serve
    // the superseded head's checks — once superseded runs are cancelled
    // (HOK-2938 concurrency policy), those read as CANCELLED and would block
    // the PR for a failure that belongs to another head. Skipped polls
    // self-heal within a poll or two of read-after-write lag.
    let waitSummary: string | null = null;
    if (expectedHeadSha) {
      const observedHeadSha = await readPrHeadSha(prNumber, repoDir, shellRunner, options.retrySleep ?? sleep);
      if (observedHeadSha === expectedHeadSha) {
        consecutiveHeadMismatches = 0;
      } else if (observedHeadSha === null) {
        // Provenance unverifiable (API failure or malformed output): never
        // derive a verdict from checks whose head is unknown. Keep waiting —
        // the deadline still bounds the loop, so a persistent read failure
        // surfaces as a conservative timeout, not a false verdict.
        waitSummary = `Could not verify PR head (expected ${expectedHeadSha}); not evaluating checks without head provenance.`;
      } else {
        consecutiveHeadMismatches += 1;
        if (consecutiveHeadMismatches >= HEAD_MISMATCH_MAX_POLLS) {
          return {
            outcome: 'head-changed',
            summary: `PR head changed while waiting for checks: expected ${expectedHeadSha}, observed ${observedHeadSha} `
              + `for ${consecutiveHeadMismatches} consecutive polls. The expected head was superseded; this wait's verdict cannot apply.`,
          };
        }
        waitSummary = `PR head is ${observedHeadSha}, expected ${expectedHeadSha}; not evaluating checks from a different head.`;
      }
    }

    if (waitSummary === null) {
      const output = await readPrChecks(prNumber, repoDir, shellRunner, options.retrySleep ?? sleep);
      const checks = parseCheckRuns(output);
      const failed = checks.find((check) => isFailingCheck(check));
      if (failed) {
        return { outcome: 'fail', summary: summarizeChecks(checks) };
      }

      const missingRequired = findMissingRequiredChecks(checks, requiredChecks);

      if (checks.length > 0 && missingRequired.length === 0 && checks.every((check) => isPassingCheck(check))) {
        return { outcome: 'pass', summary: summarizeChecks(checks, requiredChecks) };
      }

      waitSummary = summarizeChecks(checks, requiredChecks);
    }

    if (Date.now() >= deadline) {
      return { outcome: 'timeout', summary: waitSummary };
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Reads the PR's current head SHA for check-provenance validation. Returns
 * null when the head cannot be determined (command failure surviving the
 * transient retry, malformed JSON, or a missing headRefOid) — callers must
 * treat null as "unverifiable", never as a match.
 */
async function readPrHeadSha(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  retrySleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  let output: string;
  try {
    output = await retryTransient(
      () => {
        const raw = String(shellRunner(
          `gh pr view ${prNumber} --json headRefOid 2>&1 || true`,
          { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
        ));
        try {
          JSON.parse(raw);
        } catch (error) {
          if (isTransientErrorText(raw)) {
            throw new TransientError(raw, { cause: error });
          }
        }
        return raw;
      },
      { label: 'gh pr view headRefOid', sleep: retrySleep },
    );
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const head = typeof parsed === 'object' && parsed !== null
    ? (parsed as { headRefOid?: unknown }).headRefOid
    : undefined;
  return typeof head === 'string' && head.trim() ? head.trim() : null;
}

async function readPrChecks(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
  retrySleep: (ms: number) => Promise<void>,
): Promise<string> {
  return retryTransient(
    () => {
      const output = String(shellRunner(
        `gh pr checks ${prNumber} --json name,state,bucket 2>&1 || true`,
        { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
      ));
      if (output.includes('no checks reported')) {
        return '[]';
      }
      try {
        JSON.parse(output);
      } catch (error) {
        if (isTransientErrorText(output)) {
          throw new TransientError(output, { cause: error });
        }
      }
      return output;
    },
    { label: 'gh pr checks', sleep: retrySleep },
  );
}

async function defaultRunReadyCheck(
  prNumber: number,
  repoDir: string,
): Promise<{ ready: boolean; reason?: string }> {
  const readyPolicy = getIntegrationReadyPolicy(repoDir);

  if (!readyPolicy.enabled) {
    const result = await runReadyStage({ prNumber, repoDir });
    return { ready: result.verdict === 'pass', reason: result.summary };
  }

  const pr = getPullRequest(prNumber);
  const effectiveBaseBranch = resolveEffectiveBaseBranchForPr(repoDir, prNumber, pr.headRefName, pr.baseRefName);
  const verdict = await evaluateReady({
    pr: {
      number: pr.number,
      url: pr.url,
      baseBranch: effectiveBaseBranch,
      body: pr.body || '',
      labels: pr.labels.map((label) => label.name),
      mergedAt: pr.mergedAt,
    },
    config: {
      ...readyPolicy,
      integrationBranch: readyPolicy.integrationBranch || getConfiguredIntegrationBranch(repoDir),
    },
    async fetchPrState(dependencyPrNumber) {
      try {
        const dependencyPr = getPullRequest(dependencyPrNumber);
        const state = dependencyPr.mergedAt ? 'MERGED' : dependencyPr.state === 'OPEN' ? 'OPEN' : 'CLOSED';
        return { state, mergedAt: dependencyPr.mergedAt };
      } catch (error) {
        if ((error as Error).message.includes('not found')) {
          return null;
        }
        throw error;
      }
    },
    async fetchLinearIssueState(identifier) {
      try {
        const issue = await getIssueCompletionState(identifier);
        return { completedAt: issue.completedAt ?? null, canceledAt: issue.canceledAt ?? null };
      } catch (error) {
        if ((error as Error).message.includes('Issue not found')) {
          return null;
        }
        throw error;
      }
    },
    readChallengeComparisons,
  });

  return {
    ready: verdict.status === 'pass',
    reason: verdict.reasons.join('; '),
  };
}

function postFailureComment(
  prNumber: number,
  body: string,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): void {
  shellRunner(
    `gh pr comment ${prNumber} --body ${escapeShellArg(body)}`,
    { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
  );
}

async function mergeWithTransientRetry(
  prNumber: number,
  mergeMethod: string,
  requiredChecks: string[],
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<void> {
  const mergeFlag = `--${mergeMethod}`;
  const command = `gh pr merge ${prNumber} ${mergeFlag}`;
  const deadlineMs = deps.currentTimeMs() + MERGE_RETRY_WINDOW_MS;
  let lastTransientError = '';
  let lastDiagnostics: PrMergeDiagnostics | null = null;
  let retryWindowMarked = false;

  try {
    for (let attempt = 1; attempt <= MERGE_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        deps.shellRunner(command, { encoding: 'utf-8', cwd: repoDir, timeout: MERGE_COMMAND_TIMEOUT_MS });
        return;
      } catch (error) {
        const output = outputFromError(error);
        if (isAlreadyMergedOutput(output)) {
          return;
        }
        if (!isRequiredChecksExpectedMergeError(output) && !isTransientErrorText(output)) {
          throw error;
        }

        lastTransientError = output;
        lastDiagnostics = readPrMergeDiagnostics(prNumber, repoDir, deps.shellRunner);

        if (attempt >= MERGE_RETRY_MAX_ATTEMPTS || deps.currentTimeMs() + MERGE_RETRY_BACKOFF_MS > deadlineMs) {
          throw new Error(buildTransientMergeFailureDiagnostics(lastTransientError, lastDiagnostics, requiredChecks));
        }

        // Signal the local merge queue (a separate process) that this candidate is
        // in an active transient-retry window so it is not demoted as "stuck" and
        // re-promoted while tend keeps retrying. See isCandidateStuck in merge-queue.ts.
        if (!retryWindowMarked) {
          deps.setMergeRetryWindow(prNumber, new Date(deadlineMs).toISOString(), repoDir);
          retryWindowMarked = true;
        }

        await deps.retrySleep(MERGE_RETRY_BACKOFF_MS);
      }
    }

    throw new Error(buildTransientMergeFailureDiagnostics(lastTransientError, lastDiagnostics, requiredChecks));
  } finally {
    if (retryWindowMarked) {
      deps.setMergeRetryWindow(prNumber, null, repoDir);
    }
  }
}

export function isRequiredChecksExpectedMergeError(output: string): boolean {
  return output.toLowerCase().includes(TRANSIENT_REQUIRED_CHECKS_EXPECTED);
}

function isAlreadyMergedOutput(output: string): boolean {
  return /\balready merged\b|pull request .* was merged/i.test(output);
}

const BASE_POLICY_MERGE_ERROR_PATTERN = /base branch policy prohibits the merge/i;

/**
 * GitHub's strict-mode rejection text. On a serially drained lane every merge
 * makes every queued PR stale, so this exact message is expected churn — but
 * only the live PR state can distinguish staleness from a genuine policy
 * failure (failing required checks, conflicts, missing approvals).
 */
export function isBasePolicyMergeError(output: string): boolean {
  return BASE_POLICY_MERGE_ERROR_PATTERN.test(output);
}

export type BasePolicyRejectionClass = 'stale-base' | 'policy-failure';

export interface BasePolicyRejectionClassification {
  classification: BasePolicyRejectionClass;
  detail: string;
}

/**
 * Classify a base-policy merge rejection from fresh post-rejection diagnostics
 * (REQ-F1/REQ-F2). 'stale-base' — the transient strict-mode case — requires
 * ALL of: mergeable MERGEABLE, mergeStateStatus BEHIND, and no failing check
 * in the status rollup. Anything else (including unreadable diagnostics) is a
 * 'policy-failure' and keeps the terminal blocking path — an unreadable
 * current state is never enough to retry.
 */
export function classifyBasePolicyRejection(diagnostics: PrMergeDiagnostics): BasePolicyRejectionClassification {
  if (diagnostics.unavailableReason) {
    return {
      classification: 'policy-failure',
      detail: `post-rejection PR state unavailable: ${truncateReason(diagnostics.unavailableReason, 200)}`,
    };
  }

  const mergeable = (diagnostics.mergeable ?? '').toUpperCase();
  const mergeStateStatus = (diagnostics.mergeStateStatus ?? '').toUpperCase();
  const failingChecks = failingRollupCheckNames(diagnostics.statusCheckRollup);
  const stateSummary = `mergeable=${mergeable || '(missing)'} mergeStateStatus=${mergeStateStatus || '(missing)'}`
    + `${failingChecks.length > 0 ? ` failingChecks=${failingChecks.join(',')}` : ''}`;

  if (mergeable === 'MERGEABLE' && mergeStateStatus === 'BEHIND' && failingChecks.length === 0) {
    return {
      classification: 'stale-base',
      detail: `strict base protection rejected a stale head (${stateSummary}); refresh and retry`,
    };
  }

  return {
    classification: 'policy-failure',
    detail: `base-policy rejection is not stale-base churn (${stateSummary})`,
  };
}

function failingRollupCheckNames(rollup: unknown): string[] {
  return extractStatusCheckRollupEntries(rollup)
    .filter((entry) => {
      const conclusion = (stringField(entry, 'conclusion') ?? '').toLowerCase();
      const state = (stringField(entry, 'state') ?? '').toLowerCase();
      return FAILING_CHECK_CONCLUSIONS.has(conclusion) || FAILING_CHECK_CONCLUSIONS.has(state);
    })
    .map((entry) => stringField(entry, 'name') ?? stringField(entry, 'context') ?? 'check');
}

const STRICT_BASE_REFRESH_BUCKET = 'strict-base-refresh';
const STRICT_BASE_REFRESH_MAX_ATTEMPTS = 4;
const SCRATCH_PREP_RECOVERY_BUCKET = 'scratch-prep-recovery';
const SCRATCH_PREP_RECOVERY_MAX_ATTEMPTS = 1;
const HANDOFF_REBIND_BUCKET = 'handoff-rebind';
const HANDOFF_REBIND_MAX_ATTEMPTS = 3;
// HOK-3108. New bucket name — check that no existing bucket is a prefix of it
// and vice versa (see bounded-retry.sh:11).
// - handoff-claim  vs handoff-rebind    (no prefix relationship)
// - handoff-claim  vs strict-base-refresh, scratch-prep-recovery (no relationship)
const HANDOFF_CLAIM_BUCKET = 'handoff-claim';
const HANDOFF_CLAIM_MAX_ATTEMPTS = 3;
// HOK-3176 default retry for in-lane failures. No prefix relationship with
// any bucket above.
const TEND_TRANSIENT_RECOVERY_BUCKET = retryBucketFor('tend');
const SCRATCH_PREP_PROGRESS_HEARTBEAT_MS = 30_000;
const BOUNDED_RETRY_HELPER_TIMEOUT_MS = 30_000;
const BOUNDED_RETRY_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'bounded-retry.sh');
const STRICT_BASE_RETRY_DECISIONS = new Set<StrictBaseRetryDecision>(['proceed', 'backoff', 'exhausted', 'exhausted-quiet']);

function runBoundedRetryHelper(repoDir: string, invocation: string): string {
  const result = execArgvCommand(
    'bash',
    ['-c', `source ${escapeShellArg(BOUNDED_RETRY_HELPER_PATH)} && ${invocation}`],
    { cwd: repoDir, encoding: 'utf-8', timeout: BOUNDED_RETRY_HELPER_TIMEOUT_MS },
  );
  if (result.failed) {
    throw new Error(`bounded-retry helper unavailable: ${truncateReason(result.stderr || 'bash not found', 200)}`);
  }
  return result.stdout.trim();
}

function sanitizeHeadShaForRetryKey(headSha: string): string {
  return /^[0-9a-fA-F]{4,64}$/.test(headSha) ? headSha : '';
}

/**
 * Default HOK-2924 bounded-retry wiring for strict-base refreshes. Never adds
 * a private counter: all state lives in the shared helper's files under
 * `.wavemill/merge-lane/<pr>/` with the `strict-base-refresh` bucket, so the
 * budget is head-keyed, backed off, terminalized at a ceiling with a
 * greppable `.retry-strict-base-refresh-exhausted` sentinel, and reset by a
 * new head or a successful merge.
 */
export const defaultStrictBaseRetryOps: StrictBaseRetryOps = createBoundedRetryOps(
  STRICT_BASE_REFRESH_BUCKET,
  STRICT_BASE_REFRESH_MAX_ATTEMPTS,
);

/**
 * Default HOK-3039 bounded-retry wiring for scratch-prep recovery. Same
 * bounded-retry.sh helper as strict-base, keyed on the head SHA Tend saw at
 * handoff. Limit is 1 (retry exactly once per head, per the success
 * criterion); the shared helper terminalizes with a greppable sentinel and
 * resets when the head changes.
 */
export const defaultScratchPrepRetryOps: StrictBaseRetryOps = createBoundedRetryOps(
  SCRATCH_PREP_RECOVERY_BUCKET,
  SCRATCH_PREP_RECOVERY_MAX_ATTEMPTS,
);

/**
 * Default HOK-3105 bounded-retry wiring for handoff rebind lag deferrals. The
 * budget is keyed on the pushed head SHA, so a fresh push resets counting.
 * The helper terminalizes at the ceiling with a greppable
 * `.retry-handoff-rebind-exhausted` sentinel and clears on a successful merge.
 *
 * Related buckets:
 *   - `handoff-claim` (HOK-3108): pre-lane claim rejections when a `wm:ready`
 *     PR has no published Ready handoff at its live head.
 *   - `strict-base-refresh` (HOK-2924): stale-base rejection recovery.
 *   - `scratch-prep-recovery` (HOK-3039): worktree-prep timeout recovery.
 */
export const defaultHandoffRebindRetryOps: StrictBaseRetryOps = createBoundedRetryOps(
  HANDOFF_REBIND_BUCKET,
  HANDOFF_REBIND_MAX_ATTEMPTS,
);

/**
 * Default HOK-3108 bounded-retry wiring for pre-lane handoff-claim rejections
 * (agent-applied wm:ready without a published Ready handoff, and similar). The
 * budget is keyed on the live PR head, so a fresh push resets the counter and
 * clears the `.retry-handoff-claim-exhausted` sentinel. Backoff base is 0:
 * Ready publishes the handoff before it labels wm:ready, so there is no race
 * for backoff to wait out, and the same PR sitting first in `eligible` would
 * otherwise starve every other eligible PR for the duration of the wait.
 */
export const defaultHandoffClaimRetryOps: StrictBaseRetryOps = createBoundedRetryOps(
  HANDOFF_CLAIM_BUCKET,
  HANDOFF_CLAIM_MAX_ATTEMPTS,
  { baseSeconds: 0 },
);

/**
 * Default HOK-3176 wiring for the tend-transient-recovery bucket: the
 * failure policy's default retry for in-lane failures it does not allowlist.
 * Keyed on (PR head, integration tip) so a fresh push or a new base refills
 * the budget; exhaustion takes the terminal block path with the evidence.
 */
export const defaultTransientRetryOps: StrictBaseRetryOps = createBoundedRetryOps(
  TEND_TRANSIENT_RECOVERY_BUCKET,
  DEFAULT_RETRY_ATTEMPTS,
);

function createBoundedRetryOps(
  bucket: string,
  maxAttempts: number,
  backoff?: { baseSeconds?: number; capSeconds?: number },
): StrictBaseRetryOps {
  const backoffArgs = `${escapeShellArg(String(backoff?.baseSeconds ?? ''))} ${escapeShellArg(String(backoff?.capSeconds ?? ''))}`;
  return {
    gate: (prNumber, headSha, repoDir, baseSha = '') => {
      const stateDir = mergeLaneStateDir(prNumber, repoDir);
      const decision = runBoundedRetryHelper(
        repoDir,
        `bounded_retry_gate ${escapeShellArg(stateDir)} ${escapeShellArg(bucket)} `
        + `${escapeShellArg(sanitizeHeadShaForRetryKey(headSha))} ${maxAttempts} ${backoffArgs} `
        + `${escapeShellArg(sanitizeHeadShaForRetryKey(baseSha))}`,
      );
      if (!STRICT_BASE_RETRY_DECISIONS.has(decision as StrictBaseRetryDecision)) {
        throw new Error(`bounded_retry_gate returned unexpected decision: ${truncateReason(decision || '(empty)', 100)}`);
      }
      return decision as StrictBaseRetryDecision;
    },
    increment: (prNumber, headSha, repoDir, baseSha = '') => {
      const stateDir = mergeLaneStateDir(prNumber, repoDir);
      runBoundedRetryHelper(
        repoDir,
        `bounded_retry_increment ${escapeShellArg(stateDir)} ${escapeShellArg(bucket)} `
        + `${escapeShellArg(sanitizeHeadShaForRetryKey(headSha))} ${escapeShellArg(sanitizeHeadShaForRetryKey(baseSha))}`,
      );
    },
    markExhausted: (prNumber, reason, repoDir) => {
      const stateDir = mergeLaneStateDir(prNumber, repoDir);
      runBoundedRetryHelper(
        repoDir,
        `bounded_retry_mark_exhausted ${escapeShellArg(stateDir)} ${escapeShellArg(bucket)} `
        + `${escapeShellArg(reason)} || true`,
      );
    },
    clear: (prNumber, repoDir) => {
      const stateDir = mergeLaneStateDir(prNumber, repoDir);
      runBoundedRetryHelper(
        repoDir,
        `bounded_retry_clear ${escapeShellArg(stateDir)} ${escapeShellArg(bucket)}`,
      );
    },
  };
}

/**
 * Handle a `WorktreePrepTimeoutError` from `withScratchWorktree`. Cleans the
 * scratch directory and worktree registration best-effort, consults the
 * scratch-prep-recovery bounded-retry bucket keyed on the candidate's head
 * SHA, and either returns to `wm:ready` for immediate retry (budget
 * available) or blocks (budget exhausted). Never let a marker leak — on
 * every terminal path the marker is cleared.
 */
async function handleWorktreePrepTimeout(args: {
  candidate: TendCandidate;
  repoDir: string;
  deps: MergeExecutionDeps;
  error: WorktreePrepTimeoutError;
  block: (phase: string, output: string) => Promise<MergeExecutionResult>;
}): Promise<MergeExecutionResult> {
  const { candidate, repoDir, deps, error, block } = args;
  const headSha = candidate.headSha ?? '';
  const diagnostic = `worktree-prep-timeout phase=${error.phase} elapsedMs=${error.elapsedMs}`;

  // Best-effort scoped cleanup: try to remove the specific scratch worktree
  // for THIS PR (registration + directory) so a later attempt does not fail
  // with "already exists".
  await cleanScratchWorktreeBestEffort(candidate.number, repoDir, deps);

  clearScratchPrepMarkerBestEffort(repoDir, candidate.number);

  const verdict = consultTendRetryBudget({
    ops: deps.scratchPrepRetry,
    bucket: SCRATCH_PREP_RECOVERY_BUCKET,
    prNumber: candidate.number,
    headSha,
    repoDir,
    exhaustedReason: () => `${diagnostic}; head=${headSha || '(unknown)'}`,
  });
  if (!verdict.defer) {
    // Fail-closed: an unusable gate keeps the terminal blocking path.
    return block('worktree-timeout', verdict.gateError
      ? `${diagnostic}: retry gate unusable — ${verdict.gateError}\n${error.output}`
      : `${diagnostic} — scratch-prep-recovery budget exhausted\n${error.output}`);
  }

  await restoreReadyAfterDefer(candidate, deps, 'worktree-prep timeout');
  if (verdict.decision === 'backoff') {
    // Bounded-retry says "not yet" — the PR is back on wm:ready with the
    // scratch-prep marker cleared. The next Tend loop poll will retry.
    console.warn(
      `tend: worktree-prep timeout on PR #${candidate.number} phase=${error.phase} — backoff active, PR returned to wm:ready`,
    );
    return {
      status: 'skipped',
      prNumber: candidate.number,
      phase: 'worktree-timeout',
      failureExcerpt: truncateOutput(`${diagnostic}\nawaiting bounded-retry backoff\n${error.output}`),
      haltLoop: false,
    };
  }

  console.warn(
    `tend: worktree-prep timeout on PR #${candidate.number} phase=${error.phase} — cleaned scratch and returned to wm:ready for immediate retry (HOK-3039)`,
  );
  return {
    status: 'skipped',
    prNumber: candidate.number,
    phase: 'worktree-timeout',
    failureExcerpt: truncateOutput(`${diagnostic}\nscratch cleaned, wm:ready restored\n${error.output}`),
    haltLoop: false,
  };
}

/**
 * Handle a `HandoffRebindRefusalError` from `rebindPushedTendHead` (HOK-3105).
 *
 * A `third-head` refusal is unrecoverable — someone else pushed on top of us,
 * so we take the terminal block path (comment + wm:blocked) and record the
 * handoff sentinel so `resolveBlockedLabelReason` can self-heal later if the
 * live state contradicts.
 *
 * A `timeout` refusal (GitHub read-after-write lag) consults the handoff
 * rebind bounded-retry budget keyed on (pr, pushedHead). While the budget has
 * room, tend defers: it restores `wm:ready` in place and returns `skipped`
 * without posting the failure comment, so the next tend cycle re-enters the
 * merge-lane and the fresh `gh pr view` almost always converges on the
 * pushed head. If the budget is exhausted we fall back to the terminal block
 * path — the operator sees exactly the same evidence they see today.
 *
 * A non-refusal error (e.g. `rebindTendHandoff` returned no matching claim)
 * always takes the terminal block path.
 */
async function handleHandoffRebindFailure(args: {
  candidate: TendCandidate;
  repoDir: string;
  pushedHeadSha: string;
  error: unknown;
  deps: MergeExecutionDeps;
  block: (phase: string, output: string) => Promise<MergeExecutionResult>;
}): Promise<MergeExecutionResult> {
  const { candidate, repoDir, pushedHeadSha, error, deps, block } = args;

  const terminalBlock = async (output: string): Promise<MergeExecutionResult> => {
    writeTendHandoffBlockSentinel(repoDir, candidate.number, pushedHeadSha, {
      previousHeadSha: candidate.headSha,
      featureDir: candidate.featureDir,
    });
    return block('handoff', output);
  };

  if (!(error instanceof HandoffRebindRefusalError)) {
    // The rebindTendHandoff call itself refused (e.g. no matching claim). No
    // recovery path — take the terminal block path as we did before HOK-3105.
    return terminalBlock(outputFromError(error));
  }

  if (error.kind === 'third-head') {
    return terminalBlock(error.message);
  }

  // error.kind === 'timeout': consult the handoff-rebind retry budget.
  const verdict = consultTendRetryBudget({
    ops: deps.handoffRebindRetry,
    bucket: HANDOFF_REBIND_BUCKET,
    prNumber: candidate.number,
    headSha: pushedHeadSha,
    repoDir,
    exhaustedReason: () => `handoff-rebind budget exhausted after ${HANDOFF_REBIND_MAX_ATTEMPTS} attempts at head ${pushedHeadSha}`,
  });
  if (!verdict.defer) {
    return terminalBlock(verdict.gateError
      ? `${error.message}\n\nhandoff-rebind retry gate failed (fail-closed): ${verdict.gateError}`
      : `${error.message}\n\nhandoff-rebind budget exhausted after ${HANDOFF_REBIND_MAX_ATTEMPTS} attempts at ${pushedHeadSha}`);
  }

  await restoreReadyAfterDefer(candidate, deps, 'handoff-rebind defer');
  console.warn(
    `tend: handoff-rebind lag on PR #${candidate.number} pushed=${pushedHeadSha} observed=${error.observedHead || '(missing)'} — `
    + 'deferred to next tend cycle (no wm:blocked, no failure comment)',
  );
  return {
    status: 'skipped',
    prNumber: candidate.number,
    phase: 'handoff-rebind-deferred',
    failureExcerpt: truncateOutput(
      `${error.message}\ndeferred by handoff-rebind bounded-retry; PR returned to wm:ready`,
    ),
    haltLoop: false,
  };
}

/**
 * Handle a rejected pre-lane Tend claim on the Ready handoff (HOK-3108).
 *
 * Called when `claimReadyHandoff` rejected the claim at the live PR head
 * (missing / unreadable / head-mismatch / not-published / terminal /
 * foreign-claim). Consults the `handoff-claim` bounded-retry bucket keyed on
 * (`mergeLaneStateDir(pr)`, `handoff-claim`, live head):
 *
 *  - `proceed`  → increment the counter, return `skipped` with a rich
 *                 `failureExcerpt` naming the reason. The loop logs and
 *                 stall-tracks it.
 *  - `backoff`  → return the same skip without incrementing. With base 0
 *                 this cannot fire, but the case is handled for completeness.
 *  - `exhausted`      → mark the sentinel with a recorded reason and block.
 *  - `exhausted-quiet` → block without re-marking (someone re-applied
 *                        `wm:ready` at the same head after the block cleared).
 *
 * The block excerpt carries the literal phrase
 *   `wm:ready without a published Ready handoff for head <fullSha>`
 * so it is greppable across logs, and includes the rejection detail, the
 * rejected-claim count, and a remedy line pointing to Ready re-run or a
 * fresh push.
 *
 * Crucially, this path does NOT write the `tend-handoff-block` sentinel. If
 * it did, the HOK-3105 self-heal would clear `wm:blocked` two polls later on
 * a green PR, the PR would get `wm:ready` again, and the loop would come
 * back. Without the sentinel, the block follows HOK-2883 semantics: it
 * stays put and surfaces as `blocked-label:contradicted-by-live-state`
 * with the operator's contradiction finding until Ready re-runs or a new
 * head is pushed.
 *
 * A gate that throws is fail-closed: we block with the gate error appended,
 * matching the scratch-prep and handoff-rebind conventions.
 */
async function handleHandoffClaimRejection(args: {
  candidate: TendCandidate;
  liveHead: string;
  claim: ClaimHandoffOutcome;
  repoDir: string;
  deps: MergeExecutionDeps;
  block: (phase: string, output: string) => Promise<MergeExecutionResult>;
}): Promise<MergeExecutionResult> {
  const { candidate, liveHead, claim, repoDir, deps, block } = args;
  const detail = describeClaimRejection(claim, candidate.number, liveHead);

  const verdict = consultTendRetryBudget({
    ops: deps.handoffClaimRetry,
    bucket: HANDOFF_CLAIM_BUCKET,
    prNumber: candidate.number,
    headSha: liveHead,
    repoDir,
    exhaustedReason: () => `handoff-claim rejected ${HANDOFF_CLAIM_MAX_ATTEMPTS} times at head ${liveHead}: ${detail}`,
  });
  if (!verdict.defer && verdict.gateError) {
    return block(
      'handoff',
      `wm:ready without a published Ready handoff for head ${liveHead}\n${detail}\n\n`
      + `handoff-claim retry gate failed (fail-closed): ${verdict.gateError}`,
    );
  }
  if (!verdict.defer) {
    const blockOutput = [
      `wm:ready without a published Ready handoff for head ${liveHead}`,
      detail,
      `handoff-claim rejected ${HANDOFF_CLAIM_MAX_ATTEMPTS} consecutive times at this head.`,
      '',
      'Remedy: re-run Ready for this head so it publishes the handoff (it will relabel wm:ready), or push a new head.',
    ].join('\n');
    return block('handoff', blockOutput);
  }

  // `backoff` (only reachable with a nonzero base) did not increment — the
  // next poll re-runs the gate.
  const attempt = verdict.decision === 'proceed'
    ? (currentHandoffClaimCount(candidate.number, liveHead, repoDir) || 1)
    : 0;
  const attemptLabel = verdict.decision === 'proceed'
    ? `Tend claim rejected (${attempt}/${HANDOFF_CLAIM_MAX_ATTEMPTS}) for head ${liveHead.slice(0, 7)}: ${detail}`
    : `Tend claim deferred by handoff-claim backoff for head ${liveHead.slice(0, 7)}: ${detail}`;

  return {
    status: 'skipped',
    prNumber: candidate.number,
    phase: 'handoff',
    failureExcerpt: truncateOutput(attemptLabel),
    haltLoop: false,
  };
}

/**
 * Read the current handoff-claim attempt count directly from the bucket's
 * counter file, without shelling out. Best-effort — used only to render a
 * "1/3" style hint into `failureExcerpt`. A missing/unreadable file returns 0.
 *
 * Format mirrors `bounded-retry.sh` storage (`.retry-<bucket>-count`) so a
 * fresh test that injects a fake `handoffClaimRetry` still reads 0 here (no
 * counter file exists on disk), rather than throwing.
 */
function currentHandoffClaimCount(
  prNumber: number,
  _headSha: string,
  repoDir: string,
): number {
  try {
    const path = join(mergeLaneStateDir(prNumber, repoDir), `.retry-${HANDOFF_CLAIM_BUCKET}-count`);
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf-8').trim();
    return /^[0-9]+$/.test(raw) ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * Defer a retryable in-lane failure (HOK-3176) instead of labelling
 * wm:blocked. Consults the tend-transient-recovery budget keyed on (PR head,
 * integration tip): while it has room the PR returns to wm:ready without a
 * failure comment, so the next tend cycle retries; once exhausted, tend takes
 * the terminal block path with the failure evidence and the recorded reason.
 * A gate that cannot run fails closed to the block path, matching the other
 * tend budgets.
 */
async function deferRetryableTendFailure(args: {
  candidate: TendCandidate;
  repoDir: string;
  phase: string;
  output: string;
  rationale: string;
  baseSha: string;
  deps: MergeExecutionDeps;
  block: (phase: string, output: string) => Promise<MergeExecutionResult>;
}): Promise<MergeExecutionResult> {
  const { candidate, repoDir, phase, output, rationale, baseSha, deps, block } = args;
  const headSha = candidate.headSha ?? '';

  const summary = `${phase} failure kept recurring after ${DEFAULT_RETRY_ATTEMPTS} deferred retries `
    + `at head ${headSha || '(unknown)'} / base ${baseSha || '(unknown)'} (${rationale})`;
  const verdict = consultTendRetryBudget({
    ops: deps.transientRetry,
    bucket: TEND_TRANSIENT_RECOVERY_BUCKET,
    prNumber: candidate.number,
    headSha,
    baseSha,
    repoDir,
    exhaustedReason: () => `${summary}: ${truncateReason(output, 400)}`,
  });
  if (!verdict.defer) {
    return block(phase, verdict.gateError
      ? `${output}\n\n${TEND_TRANSIENT_RECOVERY_BUCKET} gate failed (fail-closed): ${verdict.gateError}`
      : `${output}\n\n${summary}`);
  }

  // `backoff` defers too, without spending budget.
  await restoreReadyAfterDefer(candidate, deps, `retryable ${phase} failure`);
  console.warn(`tend: retryable ${phase} failure on PR #${candidate.number} (${rationale}) — returned to wm:ready, no wm:blocked`);
  return {
    status: 'skipped',
    prNumber: candidate.number,
    phase: `${phase}-retry-deferred`,
    failureExcerpt: truncateOutput(`${output}\n${rationale}; deferred by ${TEND_TRANSIENT_RECOVERY_BUCKET}, PR returned to wm:ready`),
    haltLoop: false,
  };
}

/** `origin/<branch>` SHA in a scratch worktree, or '' — never throws. */
function readRemoteBranchShaBestEffort(
  worktreePath: string,
  branch: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): string {
  try {
    return String(shellRunner(`git rev-parse ${escapeShellArg(`origin/${branch}`)}`, {
      encoding: 'utf-8',
      cwd: worktreePath,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })).trim();
  } catch {
    return '';
  }
}

interface TendRetryVerdict {
  /** true: return the PR to wm:ready; false: take the block path. */
  defer: boolean;
  /** Set when `defer` is true. */
  decision?: 'proceed' | 'backoff';
  /** Set when the gate could not run (fail-closed). */
  gateError?: string;
}

/**
 * The bounded-retry consult every tend deferral path shares (scratch-prep,
 * handoff-rebind, handoff-claim, tend-transient-recovery): gate the budget,
 * record an attempt on `proceed`, record the terminal reason once on
 * `exhausted`. `defer: false` means take the block path; a gate that cannot
 * run is fail-closed and carries `gateError`. Bookkeeping failures after the
 * gate are logged, never fatal.
 */
function consultTendRetryBudget(args: {
  ops: StrictBaseRetryOps;
  bucket: string;
  prNumber: number;
  headSha: string;
  baseSha?: string;
  repoDir: string;
  exhaustedReason: () => string;
}): TendRetryVerdict {
  const { ops, bucket, prNumber, headSha, baseSha, repoDir } = args;
  let decision: StrictBaseRetryDecision;
  try {
    decision = ops.gate(prNumber, headSha, repoDir, baseSha);
  } catch (gateError) {
    console.warn(`tend: ${bucket} retry gate failed for PR #${prNumber}: ${errorMessage(gateError)}`);
    return { defer: false, gateError: errorMessage(gateError) };
  }
  if (decision === 'exhausted') {
    try {
      ops.markExhausted(prNumber, args.exhaustedReason(), repoDir);
    } catch (markError) {
      console.warn(`tend: failed to record ${bucket} exhaustion for PR #${prNumber}: ${errorMessage(markError)}`);
    }
  }
  if (decision === 'exhausted' || decision === 'exhausted-quiet') {
    return { defer: false };
  }
  if (decision === 'proceed') {
    try {
      ops.increment(prNumber, headSha, repoDir, baseSha);
    } catch (incError) {
      console.warn(`tend: failed to record ${bucket} attempt for PR #${prNumber}: ${errorMessage(incError)}`);
    }
  }
  return { defer: true, decision };
}

/** Return a deferred PR to wm:ready. Never throws: a failed restore is logged. */
async function restoreReadyAfterDefer(candidate: TendCandidate, deps: MergeExecutionDeps, reason: string): Promise<void> {
  try {
    await retryTransient(() => deps.restoreReady(candidate.number), {
      label: `restore ready label after ${reason}`,
      sleep: deps.retrySleep,
    });
  } catch (error) {
    console.warn(
      `tend: failed to restore wm:ready on PR #${candidate.number} after ${reason}; `
      + `wm:merging may be leaked until the stale-lock timeout reclaims it: ${errorMessage(error)}`,
    );
  }
}

/**
 * Best-effort cleanup of the scratch worktree registration and directory for
 * one PR. Uses sync shell calls with short timeouts (no shared deadline —
 * the caller has already timed out).
 */
async function cleanScratchWorktreeBestEffort(
  prNumber: number,
  repoDir: string,
  deps: MergeExecutionDeps,
): Promise<{ removed: boolean; retained?: string }> {
  let commonGitDir: string;
  try {
    commonGitDir = String(deps.shellRunner('git rev-parse --git-common-dir', {
      encoding: 'utf-8',
      cwd: repoDir,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })).trim();
  } catch (error) {
    return { removed: false, retained: `git-common-dir failed: ${errorMessage(error)}` };
  }
  // `--git-common-dir` may be relative to repoDir (e.g. `.git`); resolve it
  // so the scratch path never depends on the process cwd.
  const tendWorktreeDir = join(resolve(repoDir, commonGitDir), 'wavemill-tend');
  const worktreePath = join(tendWorktreeDir, String(prNumber));

  let registrationOk = true;
  try {
    deps.shellRunner(
      `git worktree remove --force ${escapeShellArg(worktreePath)}`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GIT_MUTATION_TIMEOUT_MS },
    );
  } catch {
    registrationOk = false; // Registration may already be pruned; the dir removal below covers it.
  }

  let dirOk = true;
  try {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  } catch (error) {
    dirOk = false;
    console.warn(`tend: failed to delete scratch worktree ${worktreePath}: ${errorMessage(error)}`);
  }

  try {
    deps.shellRunner('git worktree prune', {
      encoding: 'utf-8',
      cwd: repoDir,
      timeout: GIT_MUTATION_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn(`tend: git worktree prune failed after scratch cleanup: ${errorMessage(error)}`);
  }

  if (!dirOk) {
    return { removed: false, retained: `directory removal failed for ${worktreePath}` };
  }
  return { removed: registrationOk };
}

interface StrictBaseRecoveryOutcome {
  /** Set when the rejection was recovered as transient; caller returns it. */
  result?: MergeExecutionResult;
  /** Detail to append to the terminal block when recovery does not apply. */
  blockDetail?: string;
}

/**
 * Attempt the REQ-F1 refresh-and-retry recovery after a base-policy merge
 * rejection. Fail-closed on every uncertainty: unreadable diagnostics, a
 * missing head, a failing helper, or a failed refresh push all fall back to
 * the terminal blocking path with the classifier verdict recorded.
 */
async function attemptStrictBaseRecovery(args: {
  candidate: TendCandidate;
  worktreePath: string;
  integrationBranch: string;
  repoDir: string;
  deps: MergeExecutionDeps;
  mergeErrorOutput: string;
}): Promise<StrictBaseRecoveryOutcome> {
  const { candidate, deps } = args;

  if (!isBasePolicyMergeError(args.mergeErrorOutput)) {
    return {};
  }

  const diagnostics = readPrMergeDiagnostics(candidate.number, args.repoDir, deps.shellRunner);
  const verdict = classifyBasePolicyRejection(diagnostics);
  const classifierLine = `strict-base classifier: ${verdict.classification} — ${verdict.detail}`;

  if (verdict.classification === 'policy-failure') {
    return { blockDetail: `${args.mergeErrorOutput}\n\n${classifierLine}` };
  }

  const rejectedHead = diagnostics.headRefOid ?? '';
  if (!rejectedHead) {
    return {
      blockDetail: `${args.mergeErrorOutput}\n\nstrict-base classifier: policy-failure — `
        + 'stale-base state observed but the rejected head SHA is unknown; cannot key a bounded retry',
    };
  }

  const reason = `strict-base-refresh budget exhausted after ${STRICT_BASE_REFRESH_MAX_ATTEMPTS} attempts at head ${rejectedHead}`;
  const retry = consultTendRetryBudget({
    ops: deps.strictBaseRetry,
    bucket: STRICT_BASE_REFRESH_BUCKET,
    prNumber: candidate.number,
    headSha: rejectedHead,
    repoDir: args.repoDir,
    exhaustedReason: () => reason,
  });
  if (!retry.defer) {
    return {
      blockDetail: retry.gateError
        ? `${args.mergeErrorOutput}\n\n${classifierLine}\nstrict-base retry gate failed (fail-closed): ${retry.gateError}`
        : `${args.mergeErrorOutput}\n\n${classifierLine}\n${reason}`,
    };
  }

  if (retry.decision === 'backoff') {
    await restoreReadyAfterDefer(candidate, deps, 'strict-base retry');
    console.warn(
      `tend: strict-base staleness on PR #${candidate.number} at ${rejectedHead}; `
      + 'refresh backoff window active — PR returned to wm:ready for a later pass',
    );
    return {
      result: {
        status: 'retried',
        prNumber: candidate.number,
        phase: 'stale-base-backoff',
        failureExcerpt: truncateOutput(`${classifierLine}\nrefresh deferred by bounded-retry backoff`),
        haltLoop: false,
      },
    };
  }

  let refreshedHead: string;
  try {
    const refresh = await rebaseAndPush(args.worktreePath, candidate.headBranch, args.integrationBranch, deps.shellRunner, {
      onBeforePush: async (preSha, newSha) => {
        // Bracket the strict-base refresh push exactly like the primary
        // push so a crash during the refresh has the same deterministic
        // recovery guarantees (HOK-3039).
        await writeScratchPrepMarker(args.repoDir, {
          prNumber: candidate.number,
          headBranch: candidate.headBranch,
          headSha: candidate.headSha,
          featureDir: candidate.featureDir,
          phase: 'push',
          worktreePath: args.worktreePath,
          prePushSha: preSha,
          rebasedHeadSha: newSha,
        });
      },
      onAfterPush: async () => {
        await writeScratchPrepMarkerBestEffort(args.repoDir, {
          prNumber: candidate.number,
          headBranch: candidate.headBranch,
          headSha: candidate.headSha,
          featureDir: candidate.featureDir,
          phase: 'pushed',
          worktreePath: args.worktreePath,
        });
      },
    });
    refreshedHead = refresh.headSha;
    if (refresh.rebased) {
      await rebindPushedTendHead(candidate.number, candidate.featureDir, rejectedHead, refreshedHead, args.repoDir, deps);
    }
  } catch (error) {
    return {
      blockDetail: `${args.mergeErrorOutput}\n\n${classifierLine}\n`
        + `strict-base refresh failed (fail-closed): ${truncateOutput(outputFromError(error))}`,
    };
  }

  await recordLaneProgressSafe(deps, candidate.number, 'stale-base-refresh', args.repoDir);
  await restoreReadyAfterDefer(candidate, deps, 'strict-base refresh');
  console.warn(
    `tend: strict-base staleness on PR #${candidate.number}: refreshed ${rejectedHead} → ${refreshedHead}, `
    + 'CI restarted, PR returned to wm:ready for retry on a later pass',
  );

  return {
    result: {
      status: 'retried',
      prNumber: candidate.number,
      phase: 'stale-base-refresh',
      failureExcerpt: truncateOutput(`${classifierLine}\nrefreshed ${rejectedHead} → ${refreshedHead}; CI restarted`),
      haltLoop: false,
    },
  };
}

async function recordLaneProgressSafe(
  deps: MergeExecutionDeps,
  prNumber: number,
  event: LaneProgressEvent,
  repoDir: string,
): Promise<void> {
  try {
    await deps.recordLaneProgress(prNumber, event, repoDir);
  } catch (error) {
    console.warn(`tend: failed to record lane progress '${event}' for PR #${prNumber}: ${errorMessage(error)}`);
  }
}

function readPrMergeDiagnostics(
  prNumber: number,
  repoDir: string,
  shellRunner: MergeExecutionDeps['shellRunner'],
): PrMergeDiagnostics {
  try {
    const output = shellRunner(
      `gh pr view ${prNumber} --json mergeStateStatus,mergeable,statusCheckRollup,headRefOid,baseRefOid`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    );
    const parsed = JSON.parse(String(output)) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { unavailableReason: 'gh pr view returned non-object JSON' };
    }
    const value = parsed as {
      mergeStateStatus?: unknown;
      mergeable?: unknown;
      statusCheckRollup?: unknown;
      headRefOid?: unknown;
      baseRefOid?: unknown;
    };
    return {
      mergeStateStatus: typeof value.mergeStateStatus === 'string' ? value.mergeStateStatus : undefined,
      mergeable: typeof value.mergeable === 'string' ? value.mergeable : undefined,
      statusCheckRollup: value.statusCheckRollup,
      headRefOid: typeof value.headRefOid === 'string' ? value.headRefOid : undefined,
      baseRefOid: typeof value.baseRefOid === 'string' ? value.baseRefOid : undefined,
    };
  } catch (error) {
    return { unavailableReason: outputFromError(error) };
  }
}

function buildTransientMergeFailureDiagnostics(
  githubError: string,
  diagnostics: PrMergeDiagnostics | null,
  requiredChecks: string[],
): string {
  const lines = [
    isRequiredChecksExpectedMergeError(githubError)
      ? 'GitHub continued to report a transient required-checks protection error after Wavemill checks passed.'
      : 'GitHub continued to report a transient merge error after Wavemill checks passed.',
    '',
    'Exact GitHub error:',
    githubError || '(no output)',
    '',
    `Required checks: ${requiredChecks.length > 0 ? requiredChecks.join(', ') : '(none configured)'}`,
  ];

  if (!diagnostics) {
    lines.push('Final PR state: unavailable');
    return lines.join('\n');
  }

  if (diagnostics.unavailableReason) {
    lines.push(`Final PR state unavailable: ${diagnostics.unavailableReason}`);
    return lines.join('\n');
  }

  lines.push(`Final mergeStateStatus: ${diagnostics.mergeStateStatus || '(missing)'}`);
  lines.push(`PR head SHA: ${diagnostics.headRefOid || '(missing)'}`);
  lines.push(`Base SHA: ${diagnostics.baseRefOid || '(missing)'}`);
  lines.push('Final check rollup:');
  lines.push(formatStatusCheckRollup(diagnostics.statusCheckRollup));
  return lines.join('\n');
}

function formatStatusCheckRollup(rollup: unknown): string {
  const entries = extractStatusCheckRollupEntries(rollup);
  if (entries.length === 0) {
    return '(no check-rollup entries reported)';
  }
  return entries.map((entry) => {
    const name = stringField(entry, 'name') || stringField(entry, 'context') || 'check';
    const status = stringField(entry, 'status') || stringField(entry, 'state') || stringField(entry, 'conclusion') || 'unknown';
    const conclusion = stringField(entry, 'conclusion');
    return conclusion && conclusion !== status ? `${name}: ${status}/${conclusion}` : `${name}: ${status}`;
  }).join('\n');
}

function extractStatusCheckRollupEntries(rollup: unknown): Record<string, unknown>[] {
  if (Array.isArray(rollup)) {
    return rollup.filter(isRecord);
  }
  if (!isRecord(rollup)) {
    return [];
  }
  if (Array.isArray(rollup.nodes)) {
    return rollup.nodes.filter(isRecord);
  }
  if (Array.isArray(rollup.contexts)) {
    return rollup.contexts.filter(isRecord);
  }
  if (isRecord(rollup.nodes) && Array.isArray(rollup.nodes.nodes)) {
    return rollup.nodes.nodes.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function mergeExecutionDeps(deps: Partial<MergeExecutionDeps> | undefined, markerRoot: string): MergeExecutionDeps {
  return {
    shellRunner: (cmd, opts) => String(execShellCommand(cmd, {
      ...opts,
      timeout: opts?.timeout ?? DEFAULT_EXTERNAL_COMMAND_TIMEOUT_MS,
    })),
    readyChecker: defaultRunReadyCheck,
    healthChecker: defaultHealthChecker,
    acquireMerging: (prNumber) => {
      setWavemillMerging(prNumber, { markerRoot });
    },
    releaseToBlocked: (prNumber) => {
      setWavemillBlocked(prNumber, { markerRoot });
    },
    releaseMerged: (prNumber) => {
      setWavemillMerged(prNumber, { markerRoot });
    },
    restoreReady: (prNumber) => {
      setWavemillReady(prNumber, { markerRoot });
    },
    reclaimStaleMerging: (prNumber) => {
      // setWavemillReady clears both wm:merging and wm:blocked — the holder held
      // wm:ready before acquireMerging swapped it, and the in-lane ready gate
      // re-validates before any reclaimed PR can actually merge.
      setWavemillReady(prNumber, { markerRoot });
    },
    retrySleep: sleep,
    currentTimeMs: () => Date.now(),
    setMergeRetryWindow: (prNumber, untilIso, repoDir) => {
      writeMergeRetryMarker(prNumber, untilIso, repoDir);
    },
    strictBaseRetry: defaultStrictBaseRetryOps,
    scratchPrepRetry: defaultScratchPrepRetryOps,
    handoffRebindRetry: defaultHandoffRebindRetryOps,
    handoffClaimRetry: defaultHandoffClaimRetryOps,
    transientRetry: defaultTransientRetryOps,
    prepRunnerFactory: (_repoDir, factoryOptions) => createProcessGroupPrepRunner({
      deadlineMs: getIntegrationConfig(_repoDir).worktreePrepTimeoutMinutes * 60_000,
      heartbeatIntervalMs: SCRATCH_PREP_PROGRESS_HEARTBEAT_MS,
      onHeartbeat: factoryOptions.onHeartbeat,
    }),
    recordLaneProgress: async (prNumber, event, repoDir) => {
      await recordLaneProgress(prNumber, repoDir, event);
    },
    stripUntrustedReady: defaultUntrustedReadyLabelStripper,
    ...deps,
  };
}

/**
 * Absolute path to the cross-process marker that records an active transient
 * merge-retry window for a PR. Written by the tend process (which knows the PR
 * number and repo dir) and read by the shell mill loop's merge-queue tick, which
 * lives in a separate process and cannot otherwise observe that tend is mid-retry.
 */
export function mergeRetryMarkerPath(prNumber: number, repoDir: string): string {
  return join(repoDir, '.wavemill', 'merge-retry', `${prNumber}.json`);
}

/**
 * Persist (or clear) the transient merge-retry window marker for a PR. Failures
 * are swallowed: the marker is a best-effort anti-churn hint, and losing it must
 * never abort or crash an in-flight merge attempt.
 */
function writeMergeRetryMarker(prNumber: number, untilIso: string | null, repoDir: string): void {
  const markerPath = mergeRetryMarkerPath(prNumber, repoDir);
  try {
    if (untilIso === null) {
      rmSync(markerPath, { force: true });
      return;
    }
    mkdirSync(join(repoDir, '.wavemill', 'merge-retry'), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ prNumber, until: untilIso })}\n`, 'utf-8');
  } catch {
    // Best-effort only; stuck detection falls back to timestamp-based demotion.
  }
}

function defaultLoserCleanup(candidate: ChallengeLoserCleanupCandidate, repoDir: string): void {
  // Re-validate eligibility at cleanup time to be doubly sure
  const eligibility = evaluateAutoCloseEligibility({
    loserPr: candidate.loserPr,
    winnerPr: candidate.winnerPr,
    comparisonOutcome: 'decisive', // Already validated in gate
    evidenceId: candidate.evidenceId,
  });

  if (!eligibility.eligible) {
    console.warn(
      `[tend-controller] Cleanup candidate PR #${candidate.loserPr} failed re-validation: ${eligibility.refusal}; skipping cleanup`,
    );
    return;
  }

  // Check current PR state to avoid duplicate mutations
  try {
    const prState = getPullRequest(candidate.loserPr, repoDir);
    if (!prState) {
      console.warn(`[tend-controller] Could not find PR #${candidate.loserPr} for cleanup; skipping`);
      return;
    }

    if (prState.state === 'closed') {
      // Already closed; check if label is already present
      const hasSuperseded = prState.labels.some((label) => label.name === WM_LABELS.superseded);
      if (hasSuperseded) {
        // Already handled
        return;
      }
    }
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to check PR #${candidate.loserPr} state: ${errorMessage(error)}; proceeding with cleanup`,
    );
  }

  try {
    setWavemillSuperseded(candidate.loserPr);
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to apply wm:superseded label to PR #${candidate.loserPr}: ${errorMessage(error)}`,
    );
  }

  try {
    execShellCommand(
      `gh pr close ${candidate.loserPr} --comment ${escapeShellArg(
        `Closed: lost challenge comparison.\nWinner: #${candidate.winnerPr}\nEvidence: ${candidate.evidenceId}`,
      )}`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    );
  } catch (error) {
    console.warn(
      `[tend-controller] Failed to close loser PR #${candidate.loserPr}: ${errorMessage(error)}`,
    );
  }
}

async function defaultCrossPrGuardChecker(input: {
  pr: GhPrListEntry;
  integrationBranch: string;
  repoDir: string;
}): Promise<CrossPrGuardCheckResult> {
  if (!input.pr.headRefOid) {
    return {
      status: 'tool-error',
      checkedHeadSha: '',
      detail: 'missing PR head SHA',
    };
  }

  const fetchResult = execArgvCommand(
    'git',
    ['fetch', 'origin', input.pr.headRefName],
    { cwd: input.repoDir, encoding: 'utf-8', timeout: GIT_MUTATION_TIMEOUT_MS },
  );
  if (fetchResult.exitCode !== 0) {
    return {
      status: 'tool-error',
      checkedHeadSha: input.pr.headRefOid,
      detail: `git fetch failed: ${truncateReason(fetchResult.stderr || fetchResult.stdout || 'unknown error')}`,
    };
  }

  const result = execArgvCommand(
    'npx',
    [
      'tsx',
      resolveWavemillToolPath('check-cross-pr-reverts.ts'),
      '--repo-dir',
      input.repoDir,
      '--head-ref',
      input.pr.headRefOid,
      '--integration-ref',
      input.integrationBranch,
    ],
    { cwd: input.repoDir, encoding: 'utf-8', timeout: CROSS_PR_GUARD_TOOL_TIMEOUT_MS },
  );
  const parsed = parseCrossPrGuardToolOutput(result.stdout);

  if (parsed.toolError) {
    return {
      status: 'tool-error',
      checkedHeadSha: input.pr.headRefOid,
      detail: summarizeCrossPrGuardToolError(parsed.toolError),
    };
  }

  if (result.exitCode === 0 && parsed.blocked === false) {
    return { status: 'pass', checkedHeadSha: input.pr.headRefOid };
  }

  if (result.exitCode === 1 || parsed.blocked === true) {
    return { status: 'blocked', checkedHeadSha: input.pr.headRefOid };
  }

  return {
    status: 'tool-error',
    checkedHeadSha: input.pr.headRefOid,
    detail: truncateReason(result.stderr || result.stdout || `exit ${result.exitCode}`),
  };
}

function defaultBlockedLabelClearer(prNumber: number, repoDir: string): void {
  let repo: string | undefined;
  try {
    repo = resolveOwnerRepoFromRemote(repoDir) ?? undefined;
  } catch {
    repo = undefined;
  }
  removeLabelFromPullRequest(prNumber, WM_LABELS.blocked, repo ? { repo } : {});
}

/**
 * Best-effort strip of an untrusted `wm:ready` label (HOK-3107). Failure is
 * swallowed with a warning so tend never halts the loop when GitHub returns a
 * transient error while removing an agent-applied label.
 */
function defaultUntrustedReadyLabelStripper(prNumber: number, repoDir: string): void {
  let repo: string | undefined;
  try {
    repo = resolveOwnerRepoFromRemote(repoDir) ?? undefined;
  } catch {
    repo = undefined;
  }
  try {
    removeLabelFromPullRequest(prNumber, WM_LABELS.ready, repo ? { repo } : {});
  } catch (error) {
    console.warn(
      `tend: failed to strip untrusted wm:ready from PR #${prNumber} `
      + `(no ready-published handoff for live head): ${errorMessage(error)}`,
    );
  }
}

function parseCrossPrGuardToolOutput(output: string): {
  blocked?: boolean;
  toolError?: Record<string, unknown>;
} {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      blocked: typeof parsed.blocked === 'boolean' ? parsed.blocked : undefined,
      toolError: isRecord(parsed.toolError) ? parsed.toolError : undefined,
    };
  } catch {
    return {};
  }
}

function summarizeCrossPrGuardToolError(toolError: Record<string, unknown>): string {
  const commandClass = stringField(toolError, 'commandClass') ?? 'tool';
  const ref = stringField(toolError, 'ref') ?? 'unknown ref';
  return `${commandClass} failed on ${ref}`;
}

interface PrCheckRun {
  name?: string;
  state?: string | null;
  conclusion?: string | null;
  bucket?: string | null;
}

function parseCheckRuns(output: string): PrCheckRun[] {
  const parsed = JSON.parse(String(output)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('tend: gh pr checks returned non-array JSON');
  }
  return parsed as PrCheckRun[];
}

function isFailingCheck(check: PrCheckRun): boolean {
  const conclusion = (check.conclusion || '').toLowerCase();
  const bucket = (check.bucket || '').toLowerCase();
  const state = (check.state || '').toUpperCase();
  return (
    FAILING_CHECK_CONCLUSIONS.has(conclusion)
    || FAILING_CHECK_BUCKETS.has(bucket)
    || FAILING_CHECK_CONCLUSIONS.has(state.toLowerCase())
  );
}

function isPassingCheck(check: PrCheckRun): boolean {
  const conclusion = (check.conclusion || '').toLowerCase();
  const bucket = (check.bucket || '').toLowerCase();
  return PASSING_CHECK_CONCLUSIONS.has(conclusion) || PASSING_CHECK_BUCKETS.has(bucket);
}

function findMissingRequiredChecks(checks: PrCheckRun[], requiredChecks: string[]): string[] {
  if (requiredChecks.length === 0) {
    return [];
  }
  const reported = new Set(checks.map((check) => check.name).filter(Boolean));
  return requiredChecks.filter((name) => !reported.has(name));
}

function summarizeChecks(checks: PrCheckRun[], requiredChecks: string[] = []): string {
  const missingRequired = findMissingRequiredChecks(checks, requiredChecks);
  if (checks.length === 0) {
    return missingRequired.length > 0
      ? `No PR checks reported.\nMissing required checks: ${missingRequired.join(', ')}`
      : 'No PR checks reported.';
  }
  const summary = checks
    .map((check) => `${check.name || 'check'}: ${check.conclusion || check.bucket || check.state || 'pending'}`)
    .join('\n');
  return missingRequired.length > 0
    ? `${summary}\nMissing required checks: ${missingRequired.join(', ')}`
    : summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConfiguredIntegrationBranch(repoDir: string): string {
  const integrationBranch = getIntegrationConfig(repoDir).integrationBranch;

  if (!integrationBranch) {
    throw new Error('tend: integration branch not configured');
  }

  validateIntegrationBranch(integrationBranch);
  return integrationBranch;
}

function validateIntegrationBranch(integrationBranch: string): void {
  validateBranchName(integrationBranch, 'integration branch');
}

function validateBranchName(integrationBranch: string, label: string): void {
  if (!BRANCH_NAME_PATTERN.test(integrationBranch)) {
    throw new Error(`tend: invalid ${label} name`);
  }
}

function isWavemillPr(pr: GhPrListEntry): boolean {
  return labelSet(pr).has(WM_LABELS.wavemill) || validatePrMetadata(pr.body).status === 'valid';
}

function isReadyPr(pr: GhPrListEntry): boolean {
  return labelSet(pr).has(WM_LABELS.ready);
}

function getMetadataValidation(body: string): MetadataValidation {
  return validatePrMetadata(body);
}

function getValidMetadata(body: string): { metadata: PrMetadata | null; validation: MetadataValidation } {
  const validation = getMetadataValidation(body);
  if (validation.status === 'valid') {
    return { metadata: validation.metadata, validation };
  }
  return { metadata: null, validation };
}

async function getInitialBlockReason(
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  validation: MetadataValidation,
  openPrNumbers: Set<number>,
  options: {
    repoDir: string;
    integrationBranch: string;
    crossPrGuardChecker: CrossPrGuardChecker;
    blockedLabelClearer: BlockedLabelClearer;
    prStateMarkerReader: PrStateMarkerReader;
    prStateMarkerWriter: PrStateMarkerWriter;
    blockedPrLiveStateProber: BlockedPrLiveStateProber;
  },
): Promise<string | null> {
  const labels = labelSet(pr);

  if (pr.isDraft) {
    return 'draft';
  }

  if (labels.has(WM_LABELS.blocked)) {
    const blockedReason = await resolveBlockedLabelReason(pr, metadata, labels, options);
    if (blockedReason) {
      return blockedReason;
    }
  }

  if (!metadata) {
    if (validation.status === 'invalid') {
      const fieldNames = validation.errors.map((e) => e.field).join(',');
      return `metadata-invalid:${fieldNames}`;
    }
    return 'missing-metadata';
  }

  if (!labels.has(WM_LABELS.ready)) {
    return 'ready-failed:not-ready';
  }

  if ((metadata.depends_on_linear?.length ?? 0) > 0) {
    return 'deps-unresolved';
  }

  for (const dependency of metadata.depends_on ?? []) {
    const dependencyPrNumber = parseDependencyPrNumber(dependency);
    if (dependencyPrNumber !== null && !openPrNumbers.has(dependencyPrNumber)) {
      return 'deps-unresolved';
    }
  }

  if (metadata.challenge === true && labels.has(WM_LABELS.challengeUnresolved)) {
    return 'challenges-unresolved';
  }

  return null;
}

async function resolveBlockedLabelReason(
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  labels: Set<string>,
  options: {
    repoDir: string;
    integrationBranch: string;
    crossPrGuardChecker: CrossPrGuardChecker;
    blockedLabelClearer: BlockedLabelClearer;
    prStateMarkerReader: PrStateMarkerReader;
    prStateMarkerWriter: PrStateMarkerWriter;
    blockedPrLiveStateProber: BlockedPrLiveStateProber;
  },
): Promise<string | null> {
  const readyResult = readReadyResultSnapshot(options.repoDir, pr, metadata);
  const currentHeadSha = pr.headRefOid ?? '';
  if (!currentHeadSha) {
    return 'blocked-label:cross-pr-guard-missing-head';
  }

  let markerNeedsReconciliation = false;
  try {
    const markerValidation = await options.prStateMarkerReader(pr.number, {
      currentHead: currentHeadSha,
      markerRoot: options.repoDir,
      deriveCondition: (payload) => {
        const activeLabels = payload.detail?.activeLabels;
        return Array.isArray(activeLabels)
          && activeLabels.includes(WM_LABELS.blocked)
          && labels.has(WM_LABELS.blocked);
      },
    });
    markerNeedsReconciliation = markerValidation.status !== 'valid';
    emitPrStateMarkerFinding(options.repoDir, pr.number, markerValidation);
  } catch (error) {
    return `blocked-label:marker-read-error:${truncateReason(errorMessage(error))}`;
  }

  if (metadata && currentHeadSha && labels.has(WM_LABELS.ready) && readyResultIsCurrentPass(readyResult, currentHeadSha)) {
    return clearGuardBlockedLabel(pr, labels, currentHeadSha, options, 'blocked-label:clear-failed');
  }

  const evidence = extractCrossPrGuardEvidence(readyResult);
  if (!evidence.provenance) {
    let liveState: BlockedPrLiveState;
    try {
      liveState = await options.blockedPrLiveStateProber(pr.number, options.repoDir);
    } catch {
      liveState = { available: false };
    }

    if (markerNeedsReconciliation) {
      // REQ-F3: the marker no longer validates (head changed, marker absent,
      // or condition contradicted). Only a positively confirmed gate at the
      // current head may re-establish the block; otherwise the stale label is
      // cleared in this same selection cycle (REQ-F4).
      const confirmedGate = confirmedLiveBlockingGate(liveState);
      if (confirmedGate) {
        const markerWriteError = refreshPrStateMarker(pr, labels, currentHeadSha, options);
        if (markerWriteError) {
          return markerWriteError;
        }
        return `blocked-label:${confirmedGate}`;
      }
      return clearGuardBlockedLabel(pr, labels, currentHeadSha, options, 'blocked-label:clear-failed');
    }

    // The marker validates at the current head, so the block was written
    // against exactly this state. Still re-derive before honouring it: a
    // MERGEABLE/CLEAN PR with green required checks contradicts every
    // GitHub-visible gate. A wavemill-internal gate (e.g. a failed in-lane
    // ready re-check) may legitimately remain, so the block stays fail-closed
    // — but the contradiction is surfaced instead of silently held (REQ-F5).
    if (isLiveStateCleanGreen(liveState)) {
      // HOK-3105: if tend itself set this wm:blocked via a handoff-rebind
      // refusal AND the same-head live state confirms the block is a lie for
      // two consecutive polls, tend clears its own label in-band. Guard-set
      // blocks (cross-PR revert guard, review) are on a different branch of
      // this function, so HOK-2883 semantics remain intact.
      const selfHealed = await attemptTendHandoffSelfHeal(pr, metadata, labels, currentHeadSha, options);
      if (selfHealed) {
        return null;
      }
      emitBlockedLabelContradictionFinding(options.repoDir, pr, currentHeadSha, liveState);
      return 'blocked-label:contradicted-by-live-state';
    }
    const gate = describeLiveBlockedGate(liveState);
    return gate ? `blocked-label:${gate}` : 'blocked-label';
  }

  if (
    evidence.checkedHeadSha === currentHeadSha
    && (evidence.status === 'blocked' || evidence.status === 'tool-error')
  ) {
    if (markerNeedsReconciliation && evidence.status === 'blocked') {
      const markerWriteError = refreshPrStateMarker(pr, labels, currentHeadSha, options);
      if (markerWriteError) {
        return markerWriteError;
      }
    }
    return evidence.status === 'tool-error'
      ? 'blocked-label:cross-pr-guard-tool-error'
      : 'blocked-label:cross-pr-guard';
  }

  let recheck: CrossPrGuardCheckResult;
  try {
    recheck = await options.crossPrGuardChecker({
      pr,
      integrationBranch: options.integrationBranch,
      repoDir: options.repoDir,
    });
  } catch (error) {
    return `blocked-label:cross-pr-guard-recheck-error:${truncateReason(errorMessage(error))}`;
  }

  if (recheck.status === 'blocked') {
    const markerWriteError = refreshPrStateMarker(pr, labels, currentHeadSha, options);
    if (markerWriteError) {
      return markerWriteError;
    }
    return 'blocked-label:cross-pr-guard';
  }
  if (recheck.status === 'tool-error') {
    return 'blocked-label:cross-pr-guard-tool-error';
  }

  return clearGuardBlockedLabel(pr, labels, currentHeadSha, options, 'blocked-label:clear-failed');
}

/**
 * Attempt HOK-3105 self-heal: clear a wm:blocked label that tend itself set
 * via a handoff-rebind refusal, once two consecutive polls confirm the live
 * PR state contradicts the block at the same head.
 *
 * Returns true when the label was cleared; false when the block should stay.
 * Only fires when the tend-handoff-block sentinel matches `currentHeadSha`;
 * blocks set by any other subsystem (cross-PR revert guard, review, missing
 * sentinel from an old block) are never touched, preserving HOK-2883.
 *
 * HOK-3112: restoring wm:ready alone is not enough. After a refused rebind the
 * `.ready-tend-handoff.json` record is still at the pre-push head, so the next
 * claim at the live head is rejected and tend skips the PR every poll. Before
 * the label is cleared, the handoff record is moved to the live head (which
 * must be tend's own push) and the task worktree is marked stale so the next
 * Ready re-run does not overwrite the record at the old checkout HEAD.
 */
async function attemptTendHandoffSelfHeal(
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  labels: Set<string>,
  currentHeadSha: string,
  options: {
    repoDir: string;
    blockedLabelClearer: BlockedLabelClearer;
    prStateMarkerWriter: PrStateMarkerWriter;
  },
): Promise<boolean> {
  const sentinel = readTendHandoffBlockSentinel(options.repoDir, pr.number);
  if (!sentinel || sentinel.headSha !== currentHeadSha) {
    // Block was not attributed to tend's handoff refusal at this head. Keep
    // HOK-2883 semantics: no self-heal.
    return false;
  }

  // HOK-3112: the sentinel records the head tend pushed; the stale-worktree
  // marker (written by the same push) must agree when present. Any other head
  // is a third-party push and tend must not republish the handoff for it.
  const featureDir = sentinel.featureDir ?? resolveReadyStateDir(options.repoDir, pr, metadata) ?? undefined;
  const pushedMarker = featureDir ? readTendPushedHead(featureDir) : null;
  if (pushedMarker && (pushedMarker.prNumber !== pr.number || pushedMarker.pushedHeadSha !== currentHeadSha)) {
    return false;
  }

  const observed = readTendHandoffContradictionObserved(options.repoDir, pr.number);
  if (!observed || observed.headSha !== currentHeadSha) {
    // First same-head observation: record it and keep the block for one more
    // poll before self-healing.
    writeTendHandoffContradictionObserved(options.repoDir, pr.number, {
      headSha: currentHeadSha,
      count: 1,
      firstObservedAt: new Date().toISOString(),
    });
    return false;
  }

  // observed.count >= 1 and head matches: this is the second consecutive
  // same-head observation. Make the handoff claimable at the live head first
  // so wm:ready is never restored without a record tend can claim. Legacy
  // Ready artifacts (no featureDir) have no handoff claim check.
  if (featureDir) {
    const republished = await republishHandoffAtTendHead(
      featureDir,
      pr.number,
      sentinel.previousHeadSha ?? pushedMarker?.previousHeadSha,
      currentHeadSha,
    );
    if (!republished) {
      // Keep the block and sidecars; the next poll retries.
      return false;
    }
  }

  const clearResult = clearGuardBlockedLabel(pr, labels, currentHeadSha, options, 'blocked-label:clear-failed');
  if (clearResult !== null) {
    // Clear failed — leave sidecars in place so the next poll retries.
    return false;
  }
  clearTendHandoffBlockSentinel(options.repoDir, pr.number);
  clearTendHandoffContradictionObserved(options.repoDir, pr.number);
  emitTendHandoffSelfHealFinding(options.repoDir, pr, currentHeadSha);
  return true;
}

/**
 * Move the Ready→Tend handoff to `liveHeadSha`, a head tend itself pushed
 * (HOK-3112). Prefers carrying tend's existing claim across with
 * `rebindTendHandoff`; if the record is no longer tend's claim at the previous
 * head (e.g. a Ready re-run republished it at the stale checkout HEAD), it
 * publishes a fresh handoff at the live head for the next poll to claim.
 *
 * Also (re)marks the task worktree stale so the monitor syncs it to the live
 * head before its next Ready run. Returns false when the record could not be
 * made claimable (terminal record, or an I/O failure).
 */
async function republishHandoffAtTendHead(
  featureDir: string,
  prNumber: number,
  previousHeadSha: string | undefined,
  liveHeadSha: string,
): Promise<boolean> {
  try {
    let claimable = false;
    if (previousHeadSha && previousHeadSha !== liveHeadSha) {
      const rebound = await rebindTendHandoff(featureDir, prNumber, previousHeadSha, liveHeadSha);
      claimable = rebound.outcome === 'claimed' || rebound.outcome === 'already-claimed';
    }
    if (!claimable) {
      const published = await publishReadyHandoff(featureDir, prNumber, liveHeadSha);
      claimable = published.outcome !== 'rejected';
    }
    if (!claimable) {
      console.warn(
        `tend: self-heal cannot republish handoff for PR #${prNumber} at ${liveHeadSha}: `
        + `record is ${readReadyTendHandoff(featureDir)?.state ?? 'missing'}`,
      );
      return false;
    }
    const marker = readTendPushedHead(featureDir);
    if (!marker || marker.prNumber !== prNumber || marker.pushedHeadSha !== liveHeadSha) {
      await recordTendPushedHead(featureDir, prNumber, previousHeadSha ?? '', liveHeadSha);
    }
    return true;
  } catch (error) {
    console.warn(
      `tend: self-heal failed to republish handoff for PR #${prNumber} at ${liveHeadSha}: ${errorMessage(error)}`,
    );
    return false;
  }
}

function clearGuardBlockedLabel(
  pr: GhPrListEntry,
  labels: Set<string>,
  currentHeadSha: string,
  options: {
    repoDir: string;
    blockedLabelClearer: BlockedLabelClearer;
    prStateMarkerWriter: PrStateMarkerWriter;
  },
  failureReason: string,
): string | null {
  try {
    options.blockedLabelClearer(pr.number, options.repoDir);
    const remainingActiveLabels = [WM_LABELS.ready, WM_LABELS.merging]
      .filter((label) => labels.has(label));
    if (remainingActiveLabels.length > 0) {
      options.prStateMarkerWriter(pr.number, {
        headSha: currentHeadSha,
        activeLabels: remainingActiveLabels,
        reason: 'wm:blocked cleared after marker revalidation',
        markerRoot: options.repoDir,
      });
    } else {
      clearPrStateMarker(pr.number, options.repoDir);
    }
    return null;
  } catch (error) {
    return `${failureReason}:${truncateReason(errorMessage(error))}`;
  }
}

function refreshPrStateMarker(
  pr: GhPrListEntry,
  labels: Set<string>,
  currentHeadSha: string,
  options: { repoDir: string; prStateMarkerWriter: PrStateMarkerWriter },
): string | null {
  try {
    options.prStateMarkerWriter(pr.number, {
      headSha: currentHeadSha,
      activeLabels: [WM_LABELS.ready, WM_LABELS.blocked, WM_LABELS.merging]
        .filter((label) => labels.has(label)),
      reason: 'wm:blocked condition revalidated by tend',
      markerRoot: options.repoDir,
    });
    return null;
  } catch (error) {
    return `blocked-label:marker-write-error:${truncateReason(errorMessage(error))}`;
  }
}

function emitPrStateMarkerFinding(
  repoDir: string,
  prNumber: number,
  validation: MarkerValidation<boolean>,
): void {
  const finding = buildStaleMarkerFinding(
    getPrStateMarkerHandle(prNumber, repoDir),
    validation,
    { repo: repoDir, prNumber },
  );
  if (!finding) {
    return;
  }
  appendObserverFinding(repoDir, finding);
}

// HOK-3102: keep the local name `appendObserverFinding` to avoid churning the
// two other call sites here, but route through the shared helper so writes
// are gated on `resolveSessionCapabilities(repoDir).observer`.
function appendObserverFinding(repoDir: string, finding: object): void {
  sharedAppendObserverFinding(repoDir, finding);
}

async function defaultBlockedPrLiveStateProber(prNumber: number, repoDir: string): Promise<BlockedPrLiveState> {
  try {
    const output = String(execShellCommand(
      `gh pr view ${prNumber} --json mergeable,mergeStateStatus,statusCheckRollup`,
      { encoding: 'utf-8', cwd: repoDir, timeout: GH_COMMAND_TIMEOUT_MS },
    ));
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return { available: false };
    }
    return {
      available: true,
      mergeable: typeof parsed.mergeable === 'string' ? parsed.mergeable : undefined,
      mergeStateStatus: typeof parsed.mergeStateStatus === 'string' ? parsed.mergeStateStatus : undefined,
      failingChecks: failingRollupCheckNames(parsed.statusCheckRollup),
      pendingChecks: pendingRollupCheckNames(parsed.statusCheckRollup),
    };
  } catch {
    return { available: false };
  }
}

function pendingRollupCheckNames(rollup: unknown): string[] {
  return extractStatusCheckRollupEntries(rollup)
    .filter((entry) => {
      const conclusion = (stringField(entry, 'conclusion') ?? '').toLowerCase();
      const state = (stringField(entry, 'state') ?? '').toLowerCase();
      if (FAILING_CHECK_CONCLUSIONS.has(conclusion) || FAILING_CHECK_CONCLUSIONS.has(state)) {
        return false;
      }
      if (PASSING_CHECK_CONCLUSIONS.has(conclusion) || PASSING_CHECK_CONCLUSIONS.has(state)) {
        return false;
      }
      return true;
    })
    .map((entry) => stringField(entry, 'name') ?? stringField(entry, 'context') ?? 'check');
}

export function isLiveStateCleanGreen(live: BlockedPrLiveState): boolean {
  return live.available
    && (live.mergeable ?? '').toUpperCase() === 'MERGEABLE'
    && (live.mergeStateStatus ?? '').toUpperCase() === 'CLEAN'
    && (live.failingChecks?.length ?? 0) === 0
    && (live.pendingChecks?.length ?? 0) === 0;
}

/**
 * A gate that positively confirms the PR cannot merge right now. Only these
 * gates may re-establish a block whose marker no longer validates; anything
 * weaker (pending checks, behind base, unreadable state) is not confirmation.
 */
function confirmedLiveBlockingGate(live: BlockedPrLiveState): string | null {
  if (!live.available) {
    return null;
  }
  if ((live.failingChecks?.length ?? 0) > 0) {
    return `checks-failing:${truncateReason((live.failingChecks ?? []).join(','), 80)}`;
  }
  const mergeable = (live.mergeable ?? '').toUpperCase();
  const status = (live.mergeStateStatus ?? '').toUpperCase();
  if (mergeable === 'CONFLICTING' || status === 'DIRTY') {
    return 'merge-conflict';
  }
  return null;
}

/** Best-effort human-readable gate name for a block that stays parked. */
function describeLiveBlockedGate(live: BlockedPrLiveState): string | null {
  const confirmed = confirmedLiveBlockingGate(live);
  if (confirmed) {
    return confirmed;
  }
  if (!live.available) {
    return null;
  }
  if ((live.pendingChecks?.length ?? 0) > 0) {
    return 'checks-pending';
  }
  if ((live.mergeStateStatus ?? '').toUpperCase() === 'BEHIND') {
    return 'behind-base';
  }
  return null;
}

/**
 * Sidecar recording that a wm:blocked label was set by this tend process's
 * handoff-rebind refusal path (HOK-3105). Only that path writes it. Any
 * subsequent successful merge, self-heal, or fresh handoff attempt clears it.
 * The presence + matching head SHA is the "block is attributable to tend's
 * handoff refusal" signal for `resolveBlockedLabelReason`.
 */
interface TendHandoffBlockSentinel {
  /** Head tend pushed (the head the refused rebind targeted). */
  headSha: string;
  reason: string;
  at: string;
  /**
   * HOK-3112: head the handoff record was claimed at before tend's push, so
   * the self-heal can move tend's claim with `rebindTendHandoff`.
   */
  previousHeadSha?: string;
  /** HOK-3112: Ready artifact dir holding `.ready-tend-handoff.json`. */
  featureDir?: string;
}

function tendHandoffBlockSentinelPath(repoDir: string, prNumber: number): string {
  return join(mergeLaneStateDir(prNumber, repoDir), 'tend-handoff-block.json');
}

function writeTendHandoffBlockSentinel(
  repoDir: string,
  prNumber: number,
  headSha: string,
  handoff: { previousHeadSha?: string; featureDir?: string } = {},
): void {
  const sentinel: TendHandoffBlockSentinel = {
    headSha,
    reason: 'handoff-rebind-refused',
    at: new Date().toISOString(),
    ...(handoff.previousHeadSha ? { previousHeadSha: handoff.previousHeadSha } : {}),
    ...(handoff.featureDir ? { featureDir: handoff.featureDir } : {}),
  };
  try {
    mkdirSync(mergeLaneStateDir(prNumber, repoDir), { recursive: true });
    writeFileSync(tendHandoffBlockSentinelPath(repoDir, prNumber), `${JSON.stringify(sentinel)}\n`, 'utf-8');
  } catch (error) {
    console.warn(
      `tend: failed to write handoff-block sentinel for PR #${prNumber}: ${errorMessage(error)}`,
    );
  }
}

function readTendHandoffBlockSentinel(repoDir: string, prNumber: number): TendHandoffBlockSentinel | null {
  const path = tendHandoffBlockSentinelPath(repoDir, prNumber);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || typeof parsed.headSha !== 'string') {
      return null;
    }
    return {
      headSha: parsed.headSha,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      at: typeof parsed.at === 'string' ? parsed.at : '',
      ...(typeof parsed.previousHeadSha === 'string' && parsed.previousHeadSha
        ? { previousHeadSha: parsed.previousHeadSha } : {}),
      ...(typeof parsed.featureDir === 'string' && parsed.featureDir ? { featureDir: parsed.featureDir } : {}),
    };
  } catch {
    return null;
  }
}

function clearTendHandoffBlockSentinel(repoDir: string, prNumber: number): void {
  try {
    rmSync(tendHandoffBlockSentinelPath(repoDir, prNumber), { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Sidecar counting consecutive polls that classified the tend-handoff block
 * as `contradicted-by-live-state` at the same head. Written and read only by
 * `resolveBlockedLabelReason`; the count-of-two rule matches the ticket's
 * "two consecutive polls" self-heal criterion.
 */
interface TendHandoffContradictionObserved {
  headSha: string;
  count: number;
  firstObservedAt: string;
}

function tendHandoffContradictionObservedPath(repoDir: string, prNumber: number): string {
  return join(mergeLaneStateDir(prNumber, repoDir), 'tend-handoff-contradiction-observed.json');
}

function readTendHandoffContradictionObserved(
  repoDir: string,
  prNumber: number,
): TendHandoffContradictionObserved | null {
  const path = tendHandoffContradictionObservedPath(repoDir, prNumber);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRecord(parsed) || typeof parsed.headSha !== 'string' || typeof parsed.count !== 'number') {
      return null;
    }
    return {
      headSha: parsed.headSha,
      count: parsed.count,
      firstObservedAt: typeof parsed.firstObservedAt === 'string' ? parsed.firstObservedAt : '',
    };
  } catch {
    return null;
  }
}

function writeTendHandoffContradictionObserved(
  repoDir: string,
  prNumber: number,
  record: TendHandoffContradictionObserved,
): void {
  try {
    mkdirSync(mergeLaneStateDir(prNumber, repoDir), { recursive: true });
    writeFileSync(
      tendHandoffContradictionObservedPath(repoDir, prNumber),
      `${JSON.stringify(record)}\n`,
      'utf-8',
    );
  } catch (error) {
    console.warn(
      `tend: failed to write handoff-contradiction observation for PR #${prNumber}: ${errorMessage(error)}`,
    );
  }
}

function clearTendHandoffContradictionObserved(repoDir: string, prNumber: number): void {
  try {
    rmSync(tendHandoffContradictionObservedPath(repoDir, prNumber), { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Append a merge-lane finding at most once per (pr, head, reason). The dedup
 * sentinel lives in the PR's merge-lane state dir so a new head or a changed
 * reason re-emits, while steady-state polling stays quiet.
 */
function emitMergeLaneFindingOnce(
  repoDir: string,
  prNumber: number,
  kind: string,
  headSha: string,
  reason: string,
  finding: object,
): void {
  const sentinelPath = join(mergeLaneStateDir(prNumber, repoDir), `finding-${kind}.json`);
  try {
    if (existsSync(sentinelPath)) {
      const previous = JSON.parse(readFileSync(sentinelPath, 'utf-8')) as { head?: string; reason?: string };
      if (previous.head === headSha && previous.reason === reason) {
        return;
      }
    }
  } catch {
    // Unreadable sentinel: fall through and re-emit.
  }
  appendObserverFinding(repoDir, finding);
  try {
    mkdirSync(mergeLaneStateDir(prNumber, repoDir), { recursive: true });
    writeFileSync(sentinelPath, `${JSON.stringify({ head: headSha, reason })}\n`, 'utf-8');
  } catch {
    // Best-effort dedup only.
  }
}

function emitBlockedLabelContradictionFinding(
  repoDir: string,
  pr: GhPrListEntry,
  currentHeadSha: string,
  live: BlockedPrLiveState,
): void {
  emitMergeLaneFindingOnce(repoDir, pr.number, 'blocked-label-contradiction', currentHeadSha, 'clean-green', {
    subsystem: 'merge-lane',
    title: `wm:blocked on PR #${pr.number} contradicted by live state`,
    body: `PR #${pr.number} carries wm:blocked with a marker valid at head ${currentHeadSha}, but GitHub reports `
      + 'MERGEABLE/CLEAN with green required checks. If no wavemill-internal gate applies, canonicalize with '
      + `\`npx tsx tools/set-pr-ready-label.ts ${pr.number}\`.`,
    severity: 'warning',
    context: {
      markerPath: `merge-lane/${pr.number}/blocked-label-contradiction`,
      markerKind: 'merge-lane-blocked-contradiction',
      prNumber: pr.number,
      currentHead: currentHeadSha,
      labels: [...labelSet(pr)].join(','),
      mergeable: live.mergeable ?? '',
      mergeStateStatus: live.mergeStateStatus ?? '',
    },
  });
}

/**
 * Surface that tend self-healed its own handoff-refusal `wm:blocked` label
 * (HOK-3105). The operator gets one entry per (pr, head) so a resolved lag
 * incident is visible in the observer log without spamming.
 */
function emitTendHandoffSelfHealFinding(
  repoDir: string,
  pr: GhPrListEntry,
  currentHeadSha: string,
): void {
  emitMergeLaneFindingOnce(repoDir, pr.number, 'tend-handoff-self-heal', currentHeadSha, 'self-healed', {
    subsystem: 'merge-lane',
    title: `Tend cleared its own handoff-refusal wm:blocked on PR #${pr.number}`,
    body: `PR #${pr.number} carried wm:blocked set by tend's own handoff-rebind refusal, but two consecutive `
      + `polls at head ${currentHeadSha} confirmed the PR is MERGEABLE/CLEAN with green required checks. `
      + 'Tend cleared the label in-band; the PR will be re-evaluated on the next merge-lane pass.',
    severity: 'info',
    context: {
      markerPath: `merge-lane/${pr.number}/tend-handoff-self-heal`,
      markerKind: 'merge-lane-tend-handoff-self-heal',
      prNumber: pr.number,
      currentHead: currentHeadSha,
      labels: [...labelSet(pr)].join(','),
    },
  });
}

/**
 * Surface a mill/tend disagreement (REQ-F5): the mill's merge queue calls the
 * PR a merge candidate while tend's selection blocks it. Named gate, labels,
 * and both subsystems' evidence go into the finding so an operator (or the
 * observer) can arbitrate instead of the stale view silently winning.
 */
function emitMillTendDisagreementFinding(
  repoDir: string,
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
  blockedCandidate: BlockedCandidate,
): void {
  // HOK-3102: when the mill-side merge-candidate lifecycle is off (no tend
  // to drain the queue), a stale merge-candidate artifact is not evidence of
  // disagreement — it is just leftover state. Skip the finding entirely.
  try {
    const caps = resolveSessionCapabilities(repoDir, { readHealth: false });
    if (!caps.mergeQueue) {
      return;
    }
  } catch {
    // Fail closed if the resolver fails; preserve pre-3102 behavior.
  }
  let snapshot: ReadyResultSnapshot | null;
  try {
    snapshot = readReadyResultSnapshot(repoDir, pr, metadata);
  } catch {
    return;
  }
  const artifacts = snapshot?.artifacts;
  if (!artifacts || artifacts.queueState !== 'merge-candidate') {
    return;
  }

  const currentHeadSha = pr.headRefOid ?? '';
  const millCiSummary = typeof artifacts.lastCiSummary === 'string' ? artifacts.lastCiSummary : '';
  const millCiHead = typeof artifacts.lastCiHeadSha === 'string' ? artifacts.lastCiHeadSha : '';
  emitMergeLaneFindingOnce(repoDir, pr.number, 'mill-tend-disagreement', currentHeadSha, blockedCandidate.reason, {
    subsystem: 'merge-lane',
    title: `Mill and tend disagree on PR #${pr.number} merge candidacy`,
    body: `The mill merge queue holds PR #${pr.number} as a merge candidate`
      + `${millCiSummary ? ` (live CI ${millCiSummary}${millCiHead ? ` @${millCiHead.slice(0, 7)}` : ''})` : ''}, `
      + `but tend blocks it with gate '${blockedCandidate.reason}'. One of the two views is stale; `
      + 'this disagreement must be reconciled, not silently resolved in favour of the block.',
    severity: 'warning',
    context: {
      markerPath: `merge-lane/${pr.number}/mill-tend-disagreement`,
      markerKind: 'merge-lane-disagreement',
      prNumber: pr.number,
      currentHead: currentHeadSha,
      labels: (blockedCandidate.labels ?? [...labelSet(pr)]).join(','),
      tendBlockReason: blockedCandidate.reason,
      millQueueState: 'merge-candidate',
      millLastCiSummary: millCiSummary,
      millLastCiHeadSha: millCiHead,
    },
  });
}

function readReadyResultSnapshot(
  repoDir: string,
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
): ReadyResultSnapshot | null {
  const readyDir = resolveReadyStateDir(repoDir, pr, metadata);
  if (!readyDir) {
    return null;
  }

  const resultFile = join(readyDir, '.ready-result.json');
  let snapshot: ReadyResultSnapshot = {};
  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        snapshot = {
          status: typeof record.status === 'string' ? record.status : undefined,
          artifacts: isRecord(record.artifacts) ? record.artifacts : undefined,
          crossPrDiagnostic: record.crossPrDiagnostic,
        };
      }
    } catch {
      snapshot = {};
    }
  }

  const attentionFile = join(readyDir, '.needs-attention');
  if (existsSync(attentionFile)) {
    try {
      snapshot.attention = readFileSync(attentionFile, 'utf-8');
    } catch {
      // Missing attention text just means we rely on structured evidence.
    }
  }

  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function resolveReadyStateDir(
  repoDir: string,
  pr: GhPrListEntry,
  metadata: PrMetadata | null,
): string | null {
  const candidates: string[] = [];
  const workflowEntries = readWorkflowTaskEntries(repoDir);
  const task = metadata?.task;

  for (const [key, value] of workflowEntries) {
    const prNumber = typeof value.pr === 'number' ? value.pr : Number(value.pr);
    const matchesPr = Number.isFinite(prNumber) && prNumber === pr.number;
    const matchesTask = typeof task === 'string' && task.length > 0 && key === task;
    if (!matchesPr && !matchesTask) {
      continue;
    }

    const slug = typeof value.slug === 'string' ? value.slug : '';
    const worktree = typeof value.worktree === 'string' ? value.worktree : '';
    if (worktree && slug) {
      candidates.push(join(worktree, 'features', slug), join(worktree, 'bugs', slug), join(worktree, 'features', slug, 'ready'));
    }
    if (slug) {
      candidates.push(join(repoDir, 'features', slug), join(repoDir, 'bugs', slug));
    }
  }

  if (task) {
    candidates.push(join(repoDir, 'features', task), join(repoDir, 'bugs', task), join(repoDir, 'features', normalizeTaskSlug(task)));
  }

  for (const candidate of uniqueStrings(candidates)) {
    if (existsSync(join(candidate, '.ready-result.json')) || existsSync(join(candidate, '.needs-attention'))) {
      return candidate;
    }
  }

  return null;
}

function readWorkflowTaskEntries(repoDir: string): Array<[string, Record<string, unknown>]> {
  const stateFile = join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(stateFile)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
      return [];
    }
    return Object.entries(parsed.tasks).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
  } catch {
    return [];
  }
}

function resolveEffectiveBaseBranchForPr(repoDir: string, prNumber: number, headBranch: string, fallbackBase: string): string {
  const stateFile = join(repoDir, '.wavemill', 'workflow-state.json');
  const matchingTask = readWorkflowTaskEntries(repoDir).find(([, task]) => {
    const pr = task.pr ?? (isRecord(task.lifecycle) && isRecord(task.lifecycle.deliveryEvidence) ? task.lifecycle.deliveryEvidence.prNumber : undefined);
    return String(pr ?? '') === String(prNumber) || task.branch === headBranch;
  });
  if (!matchingTask) return fallbackBase;
  try {
    return resolveEffectiveTaskConfig({
      repoDir,
      issue: matchingTask[0],
      stateFile,
    }).baseBranch.value;
  } catch {
    return fallbackBase;
  }
}

function taskStateAuthorizesRemoteBranchDeletion(repoDir: string, branch: string): boolean {
  const matchingTask = readWorkflowTaskEntries(repoDir).find(([, task]) => task.branch === branch);
  if (!matchingTask) return true;
  const normalized = normalizeTaskLifecycle(matchingTask[1]);
  return normalized.branchDeletionAuthorized;
}

function normalizeTaskSlug(task: string): string {
  return task.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

function readyResultIsCurrentPass(snapshot: ReadyResultSnapshot | null, currentHeadSha: string): boolean {
  const artifacts = snapshot?.artifacts;
  if (!artifacts) {
    return false;
  }

  const verdict = artifacts.verdict;
  const readyHeadSha = artifacts.readyHeadSha;
  return (
    snapshot?.status === 'completed'
    && (verdict === 'pass' || verdict === 'warn')
    && readyHeadSha === currentHeadSha
    && artifacts.readyLabelsUpdated === true
  );
}

function extractCrossPrGuardEvidence(snapshot: ReadyResultSnapshot | null): CrossPrGuardEvidence {
  if (!snapshot) {
    return { provenance: false };
  }

  const guard = isRecord(snapshot.artifacts?.crossPrGuard) ? snapshot.artifacts.crossPrGuard : null;
  if (guard) {
    return {
      provenance: true,
      checkedHeadSha: stringField(guard, 'checkedHeadSha') ?? stringField(guard, 'headSha') ?? undefined,
      status: stringField(guard, 'status') ?? undefined,
      detail: stringField(guard, 'detail') ?? stringField(guard, 'reason') ?? undefined,
    };
  }

  if (snapshot.crossPrDiagnostic !== undefined || attentionHasCrossPrGuardProvenance(snapshot.attention)) {
    return { provenance: true };
  }

  return { provenance: false };
}

function attentionHasCrossPrGuardProvenance(attention: string | undefined): boolean {
  if (!attention) {
    return false;
  }
  return CROSS_PR_GUARD_PROVENANCE_TEXT.some((text) => attention.includes(text));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function truncateReason(reason: string, max = 100): string {
  return reason.length <= max ? reason : `${reason.slice(0, max)}...`;
}

function removeCandidatesWithBlockedDependencies(eligible: EligibleWorkItem[]): {
  eligible: EligibleWorkItem[];
  blocked: BlockedCandidate[];
} {
  let remaining = [...eligible];
  const blocked: BlockedCandidate[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    const remainingNumbers = new Set(remaining.map((item) => item.pr.number));
    const nextRemaining: EligibleWorkItem[] = [];

    for (const item of remaining) {
      const deps = getPrDependencies(item.metadata);
      const hasMissingEligibleDependency = deps.some((dependency) => !remainingNumbers.has(dependency));

      if (hasMissingEligibleDependency) {
        blocked.push(toBlockedCandidate(item.pr, 'deps-unresolved'));
        changed = true;
      } else {
        nextRemaining.push(item);
      }
    }

    remaining = nextRemaining;
  }

  return { eligible: remaining, blocked };
}

function computeDependencyDepths(eligible: EligibleWorkItem[]): {
  eligible: Array<EligibleWorkItem & { dependencyDepth: number }>;
  cycleBlocked: BlockedCandidate[];
} {
  const itemByNumber = new Map(eligible.map((item) => [item.pr.number, item]));
  const depths = new Map<number, number>();
  const visiting: number[] = [];
  const cycleMembers = new Set<number>();

  function visit(prNumber: number): number {
    if (depths.has(prNumber)) {
      return depths.get(prNumber) ?? 0;
    }

    const activeIndex = visiting.indexOf(prNumber);
    if (activeIndex !== -1) {
      for (const cyclePrNumber of visiting.slice(activeIndex)) {
        cycleMembers.add(cyclePrNumber);
      }
      cycleMembers.add(prNumber);
      return 0;
    }

    const item = itemByNumber.get(prNumber);
    if (!item) {
      return 0;
    }

    visiting.push(prNumber);
    const dependencyDepths = getPrDependencies(item.metadata)
      .filter((dependency) => itemByNumber.has(dependency))
      .map((dependency) => visit(dependency));
    visiting.pop();

    const depth = dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1;
    depths.set(prNumber, depth);
    return depth;
  }

  for (const item of eligible) {
    visit(item.pr.number);
  }

  const cycleBlocked = eligible
    .filter((item) => cycleMembers.has(item.pr.number))
    .map((item) => toBlockedCandidate(item.pr, 'dependency-cycle'));
  const candidates = eligible
    .filter((item) => !cycleMembers.has(item.pr.number))
    .map((item) => ({
      dependencyDepth: depths.get(item.pr.number) ?? 0,
      ...item,
    }));

  return { eligible: candidates, cycleBlocked };
}

function getPrDependencies(metadata: PrMetadata): number[] {
  return (metadata.depends_on ?? [])
    .map(parseDependencyPrNumber)
    .filter((dependency): dependency is number => dependency !== null);
}

function parseDependencyPrNumber(dependency: string): number | null {
  const match = dependency.match(PR_DEPENDENCY_PATTERN);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function labelSet(pr: GhPrListEntry): Set<string> {
  return new Set(pr.labels.map((label) => label.name));
}

function toBlockedCandidate(pr: GhPrListEntry, reason: string): BlockedCandidate {
  return {
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    reason,
    labels: [...labelSet(pr)],
  };
}

function toWaitingReadyCandidate(pr: GhPrListEntry): WaitingReadyCandidate {
  return {
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    labels: [...labelSet(pr)],
  };
}

function resolveOwnerRepoFromRemote(repoDir: string): string | null {
  const remoteUrl = String(execShellCommand('git remote get-url origin', {
    encoding: 'utf-8',
    cwd: repoDir,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  })).trim();

  const repo = parseOwnerRepoFromRemoteUrl(remoteUrl);
  if (repo) {
    return repo;
  }

  try {
    const configuredRemoteUrl = String(execShellCommand('git config --get remote.origin.url', {
      encoding: 'utf-8',
      cwd: repoDir,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    })).trim();
    return parseOwnerRepoFromRemoteUrl(configuredRemoteUrl);
  } catch {
    return null;
  }
}

function parseOwnerRepoFromRemoteUrl(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim();
}

function outputFromError(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybeExecError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const output = [maybeExecError.stdout, maybeExecError.stderr]
      .map((value) => value === undefined || value === null ? '' : String(value))
      .filter((value) => value.length > 0)
      .join('\n');
    if (output.trim()) {
      return output;
    }
    if (typeof maybeExecError.message === 'string') {
      return maybeExecError.message;
    }
  }

  return String(error);
}
