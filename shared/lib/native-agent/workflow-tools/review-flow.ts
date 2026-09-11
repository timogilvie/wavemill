import { createHash } from 'node:crypto';

import { isDismissedFinding, type ReviewFinding, type ReviewResult } from '../../review-engine.ts';
import {
  appendReviewIteration,
  nextReviewIterationNumber,
  readStageResult,
  reviewOutcomePassesReadyGate,
  type DismissedReviewBlocker,
  type ExecutedIdentity,
  type ReviewerDeltaRecord,
  type ReviewExecutedIdentitySet,
  type ReviewFindingDisposition,
  type ReviewFindingRecord,
  type ReviewIterationRecord,
  type ReviewOutcomeVerdict,
  type StageStatus,
} from '../../stage-result.ts';
import { loadChallengeIntentFromFeatureDir } from '../../challenge-execution-contract.ts';
import {
  executeReviewChanges,
  executeWriteStageResult,
  type CommandToolsDeps,
} from './command-tools.ts';
import {
  githubAddLabel,
  githubCreatePr,
  type GitHubToolDeps,
} from './github.ts';
import {
  executeLinearComment,
  type LinearClient,
  type WorkflowToolStageArtifactEntry,
  type WorkflowToolTranscriptEvent,
} from './linear-tools.ts';
import type {
  GitHubAddLabelResult,
  GitHubCreatePrResult,
  GitHubLabelRef,
  GitHubPullRequestRef,
  LinearCommentResult,
  ReviewChangesResult,
  WorkflowPhase,
} from './contracts.ts';
import {
  createInMemoryDedupeRegistry,
  type DedupeRegistry,
} from './dedupe.ts';
import type { NetworkPolicy } from '../network-policy.ts';
import {
  publishReviewedBranch,
  translateGitHubHeadError,
  type BranchPublicationExecutor,
  type BranchPublicationResult,
} from '../../branch-publication.ts';

export interface NormalizedReviewFinding {
  id: string;
  source: 'code' | 'ui';
  severity: ReviewFinding['severity'];
  location: string;
  category: string;
  description: string;
}

export interface ReviewFindingFixResult {
  ok: boolean;
  outcome: 'applied' | 'skipped' | 'denied' | 'failed';
  findingId?: string;
  filesChanged?: string[];
  message?: string;
}

export type ReviewFindingFixExecutor = (input: {
  finding: NormalizedReviewFinding;
  issueId: string;
  featureDir: string;
  repo: string;
  base: string;
  head: string;
  sessionId: string;
  phase: WorkflowPhase;
}) => Promise<ReviewFindingFixResult>;

export interface ReviewFlowOptions {
  issueId: string;
  featureDir: string;
  worktreeDir?: string;
  repo: string;
  base: string;
  head: string;
  headSha: string;
  title: string;
  body: string;
  reviewContextAppendix?: string;
  labels?: string[];
  sessionId: string;
  phase?: WorkflowPhase;
  registry?: DedupeRegistry;
  transcript: { append(event: WorkflowToolTranscriptEvent): void };
  stageArtifact: { append(entry: WorkflowToolStageArtifactEntry): void };
  clock?: () => number;
  linearClient: LinearClient;
  githubDeps?: Partial<GitHubToolDeps>;
  networkPolicy?: NetworkPolicy;
  /** Branch-publication preflight; defaults to the real Git helper. Test seam only. */
  publishBranchImpl?: BranchPublicationExecutor;
  fixFindings?: ReviewFindingFixExecutor;
  reviewChangesImpl?: CommandToolsDeps['reviewChangesImpl'];
  readStageResultImpl?: CommandToolsDeps['readStageResultImpl'];
  writeStageResultImpl?: CommandToolsDeps['writeStageResultImpl'];
  updateStageResultImpl?: CommandToolsDeps['updateStageResultImpl'];
}

export interface ReviewFlowReviewSummary {
  status: 'completed' | 'failed';
  verdict?: ReviewOutcomeVerdict;
  exitCode?: number;
  iterations?: number;
  findings: string;
  findingCount: number;
  /** Raw blocker count (kept for audit); readiness uses the effective count. */
  blockingCount: number;
  warningCount: number;
  /** Blockers the reviewer disproved, each with a justification (HOK-2932). */
  dismissedBlockers: DismissedReviewBlocker[];
  reviewToolError?: string;
  failureCategory?: string;
  needsStrongerReviewer: boolean;
}

export interface ReviewFlowFixOutcome {
  findingId: string;
  outcome: ReviewFindingFixResult['outcome'];
  ok: boolean;
  message?: string;
  filesChanged?: string[];
}

export interface ReviewFlowFixSummary {
  attempted: number;
  applied: number;
  skipped: number;
  denied: number;
  failed: number;
  outcomes: ReviewFlowFixOutcome[];
}

export interface ReviewFlowResult {
  ok: boolean;
  review: ReviewFlowReviewSummary;
  fixes: ReviewFlowFixSummary;
  linearComment?: LinearCommentResult;
  branchPublication?: BranchPublicationResult;
  pullRequest?: GitHubCreatePrResult;
  labels: Array<GitHubAddLabelResult>;
  stageResult?: Awaited<ReturnType<typeof executeWriteStageResult>>;
  haltedBeforeMerge: true;
  merged: false;
  warnings: string[];
}

const DEFAULT_PHASE: WorkflowPhase = 'review';

function now(clock?: () => number): number {
  return clock ? clock() : Date.now();
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function makeFixSummary(): ReviewFlowFixSummary {
  return {
    attempted: 0,
    applied: 0,
    skipped: 0,
    denied: 0,
    failed: 0,
    outcomes: [],
  };
}

function normalizeFinding(source: 'code' | 'ui', finding: ReviewFinding): NormalizedReviewFinding {
  const identity = `${source}\n${finding.severity}\n${finding.location}\n${finding.category}\n${finding.description}`;
  return {
    id: `review_finding:${shortHash(identity)}`,
    source,
    severity: finding.severity,
    location: finding.location,
    category: finding.category,
    description: finding.description,
  };
}

function extractFindings(review: ReviewResult): NormalizedReviewFinding[] {
  // Dismissed findings are disproved false positives — there is nothing to fix,
  // so they are excluded from the fix pipeline but kept in the audit trail.
  const code = review.codeReviewFindings
    .filter((finding) => !isDismissedFinding(finding))
    .map((finding) => normalizeFinding('code', finding));
  const ui = (review.uiFindings ?? [])
    .filter((finding) => !isDismissedFinding(finding))
    .map((finding) => normalizeFinding('ui', finding));
  return [...code, ...ui];
}

function extractDismissedBlockers(review: ReviewResult): DismissedReviewBlocker[] {
  return [...review.codeReviewFindings, ...(review.uiFindings ?? [])]
    .filter((finding) => finding.severity === 'blocker' && isDismissedFinding(finding))
    .map((finding) => ({
      location: finding.location,
      category: finding.category,
      description: finding.description,
      justification: finding.dismissalJustification,
      ...(finding.dismissalEvidence ? { evidence: finding.dismissalEvidence } : {}),
    }));
}

/**
 * A fix outcome that did not actually resolve the finding leaves it `open`
 * rather than inventing a status the executor never reported (HOK-2969):
 * `skipped`/`denied`/`failed` all still need attention.
 */
function dispositionFromFixOutcome(outcome: ReviewFindingFixResult['outcome'] | undefined): ReviewFindingDisposition {
  return outcome === 'applied' ? 'fixed' : 'open';
}

/**
 * Build the complete per-finding evidence record for one review iteration:
 * location, category, severity, evidence, proposed fix, and disposition —
 * dismissed false positives keep their justification/evidence, and every
 * other finding's disposition reflects the matching fix-loop outcome, if any
 * (HOK-2969, Arbiter P2.4f).
 */
function buildFindingRecords(review: ReviewResult, fixes: ReviewFlowFixSummary): ReviewFindingRecord[] {
  const records: ReviewFindingRecord[] = [];
  const collect = (source: 'code' | 'ui', list: ReviewFinding[] | undefined) => {
    for (const finding of list ?? []) {
      const id = normalizeFinding(source, finding).id;
      const base: ReviewFindingRecord = {
        location: finding.location,
        category: finding.category,
        severity: finding.severity,
        description: finding.description,
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
        ...(finding.proposedFix ? { proposedFix: finding.proposedFix } : {}),
        disposition: 'open',
      };
      if (isDismissedFinding(finding)) {
        records.push({
          ...base,
          disposition: 'dismissed',
          dismissalJustification: finding.dismissalJustification,
          ...(finding.dismissalEvidence ? { dismissalEvidence: finding.dismissalEvidence } : {}),
        });
        continue;
      }
      const fixOutcome = fixes.outcomes.find((entry) => entry.findingId === id);
      records.push({ ...base, disposition: dispositionFromFixOutcome(fixOutcome?.outcome) });
    }
  };
  collect('code', review.codeReviewFindings);
  collect('ui', review.uiFindings);
  return records;
}

/**
 * The reviewer-authored delta is anchored by SHA relative to the shared
 * challenge fork commit rather than embedding a raw diff (HOK-2969): the
 * fork commit and reviewed head are enough to reconstruct the delta on
 * demand, and the raw diff never needs to leave this local artifact.
 */
function buildReviewerDelta(options: ReviewFlowOptions): ReviewerDeltaRecord | undefined {
  const intent = loadChallengeIntentFromFeatureDir(options.featureDir);
  const forkCommit = intent?.forkCommit ?? undefined;
  if (!forkCommit && !options.headSha) return undefined;
  return {
    ...(forkCommit ? { forkCommit } : {}),
    ...(options.headSha ? { reviewedHeadSha: options.headSha } : {}),
  };
}

/**
 * Layer remediation identity onto the orchestrator/substantive-analysis pair
 * `executeReviewChanges` already resolved. The remediation step in this flow
 * is the same calling agent applying its own fix-loop edits, so remediation
 * identity is only meaningful (non-null) once a fix was actually applied
 * (HOK-2969) — inventing one for a run with zero applied fixes would assert
 * evidence for work that never happened.
 */
function buildIterationExecutedIdentity(
  reviewCall: ReviewChangesResult,
  fixes: ReviewFlowFixSummary,
): ReviewExecutedIdentitySet | undefined {
  if (!reviewCall.ok || !reviewCall.executedIdentity) return undefined;
  const { orchestrator, substantiveAnalysis } = reviewCall.executedIdentity;
  const remediation: ExecutedIdentity | null = fixes.applied > 0
    ? { ...orchestrator, role: 'remediation' }
    : null;
  return { orchestrator, substantiveAnalysis, remediation };
}

function parseStructuredReview(findings: string): ReviewResult {
  const parsed = JSON.parse(findings) as Partial<ReviewResult>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.codeReviewFindings)) {
    throw new Error('review_changes returned malformed JSON review payload');
  }
  if (parsed.verdict !== 'ready' && parsed.verdict !== 'not_ready') {
    throw new Error('review_changes returned invalid review verdict');
  }
  return {
    verdict: parsed.verdict,
    codeReviewFindings: parsed.codeReviewFindings,
    uiFindings: Array.isArray(parsed.uiFindings) ? parsed.uiFindings : undefined,
    needsStrongerReviewer: parsed.needsStrongerReviewer === true,
    strongerReviewerReason: parsed.strongerReviewerReason,
    metadata: parsed.metadata,
  };
}

function buildLinearCommentBody(issueId: string, review: ReviewFlowReviewSummary, fixes: ReviewFlowFixSummary): string {
  const lines = [
    `Native review summary for ${issueId}`,
    ``,
    `- Findings: ${review.findingCount}`,
    `- Blocking findings: ${review.blockingCount}`,
    ...(review.dismissedBlockers.length > 0
      ? [`- Dismissed blockers (disproved, with justification): ${review.dismissedBlockers.length}`]
      : []),
    `- Needs stronger reviewer: ${review.needsStrongerReviewer ? 'yes' : 'no'}`,
    `- Fixes applied: ${fixes.applied}`,
    `- Fixes denied: ${fixes.denied}`,
    `- Fixes skipped: ${fixes.skipped}`,
    `- Fixes failed: ${fixes.failed}`,
    ``,
    'Structured review output:',
    '```json',
    review.findings,
    '```',
  ];
  return lines.join('\n');
}

function buildPrBody(baseBody: string, review: ReviewFlowReviewSummary, fixes: ReviewFlowFixSummary): string {
  const reviewSummary = [
    '## Native Review',
    '',
    `- Findings: ${review.findingCount}`,
    `- Blocking findings: ${review.blockingCount}`,
    ...(review.dismissedBlockers.length > 0
      ? [`- Dismissed blockers (disproved, with justification): ${review.dismissedBlockers.length}`]
      : []),
    `- Needs stronger reviewer: ${review.needsStrongerReviewer ? 'yes' : 'no'}`,
    `- Fixes applied: ${fixes.applied}`,
    `- Fixes denied: ${fixes.denied}`,
    `- Fixes skipped: ${fixes.skipped}`,
    `- Fixes failed: ${fixes.failed}`,
    '',
    '```json',
    review.findings,
    '```',
  ].join('\n');
  return `${baseBody.trim()}\n\n${reviewSummary}`.trim();
}

function buildStageArtifacts(input: {
  review: ReviewFlowReviewSummary;
  fixes: ReviewFlowFixSummary;
  linearComment?: LinearCommentResult;
  branchPublication?: BranchPublicationResult;
  pullRequest?: GitHubCreatePrResult;
  labels: GitHubAddLabelResult[];
  warnings: string[];
  headSha?: string;
  /** This run's complete per-iteration local evidence, merged onto any prior iterations (HOK-2969). */
  reviewIterations?: ReviewIterationRecord[];
  /** Orchestrator/substantive-analysis/remediation identity for this run's iteration (HOK-2969). */
  reviewExecutedIdentity?: ReviewExecutedIdentitySet;
}): Record<string, unknown> {
  const pullRequestSummary = summarizeMutation(input.pullRequest);
  const prNumber = input.pullRequest?.ok ? input.pullRequest.idempotency.ref?.number : undefined;
  const dismissedBlockers = input.review.dismissedBlockers;
  return {
    type: 'review',
    ...(typeof prNumber === 'number' ? { prNumber } : {}),
    exitCode: input.review.exitCode,
    verdict: input.review.verdict,
    iterations: input.review.iterations,
    blockerCount: input.review.blockingCount,
    warningCount: input.review.warningCount,
    ...(dismissedBlockers.length > 0 ? { dismissedBlockers } : {}),
    ...(input.review.reviewToolError ? { reviewToolError: input.review.reviewToolError } : {}),
    ...(input.review.failureCategory ? { failureCategory: input.review.failureCategory } : {}),
    // Head reviewed for this artifact (HOK-2964): a later head makes this
    // verdict stale, which recovery/reconciliation consumers rely on.
    ...(input.headSha ? { reviewHeadSha: input.headSha } : {}),
    ...(input.reviewIterations && input.reviewIterations.length > 0 ? { reviewIterations: input.reviewIterations } : {}),
    ...(input.reviewExecutedIdentity ? { reviewExecutedIdentity: input.reviewExecutedIdentity } : {}),
    review: {
      status: input.review.status,
      verdict: input.review.verdict,
      exitCode: input.review.exitCode,
      iterations: input.review.iterations,
      findingCount: input.review.findingCount,
      blockingCount: input.review.blockingCount,
      blockerCount: input.review.blockingCount,
      warningCount: input.review.warningCount,
      ...(dismissedBlockers.length > 0 ? { dismissedBlockers } : {}),
      reviewToolError: input.review.reviewToolError,
      failureCategory: input.review.failureCategory,
      needsStrongerReviewer: input.review.needsStrongerReviewer,
      ...(input.headSha ? { reviewHeadSha: input.headSha } : {}),
    },
    fixes: input.fixes,
    linearComment: summarizeMutation(input.linearComment),
    ...(input.branchPublication ? { branchPublication: input.branchPublication } : {}),
    pullRequest: pullRequestSummary,
    labels: input.labels.map((label) => summarizeMutation(label)),
    haltedBeforeMerge: true,
    merged: false,
    warnings: input.warnings,
  };
}

function summarizeMutation(result: LinearCommentResult | GitHubCreatePrResult | GitHubAddLabelResult | undefined): Record<string, unknown> | null {
  if (!result) {
    return null;
  }
  if (result.ok) {
    return {
      ok: true,
      tool: result.tool,
      idempotency: result.idempotency,
    };
  }
  return {
    ok: false,
    tool: result.tool,
    error: result.error,
    message: result.message,
  };
}

function stageNotes(review: ReviewFlowReviewSummary, ok: boolean): string {
  if (!ok) {
    return `Native review flow failed after ${review.findingCount} findings`;
  }
  if (review.needsStrongerReviewer) {
    return 'Native review requested a stronger reviewer; merge remains halted';
  }
  return `Native review completed with ${review.findingCount} findings; merge remains halted`;
}

function createDeps(options: ReviewFlowOptions): CommandToolsDeps {
  return {
    registry: options.registry ?? createInMemoryDedupeRegistry({ clock: options.clock }),
    transcript: options.transcript,
    stageArtifact: options.stageArtifact,
    sessionId: options.sessionId,
    phase: options.phase ?? DEFAULT_PHASE,
    repoDir: options.worktreeDir ?? options.featureDir,
    clock: options.clock,
    reviewChangesImpl: options.reviewChangesImpl,
    readStageResultImpl: options.readStageResultImpl,
    writeStageResultImpl: options.writeStageResultImpl,
    updateStageResultImpl: options.updateStageResultImpl,
    networkPolicy: options.networkPolicy,
  };
}

function recordToolEvent(input: {
  options: ReviewFlowOptions;
  tool: string;
  action: string;
  details?: Record<string, unknown>;
  idempotency?: {
    key: string;
    outcome: string;
    ref: GitHubPullRequestRef | GitHubLabelRef | null;
    reason?: string;
  };
  includeStageArtifact?: boolean;
}): void {
  const ts = now(input.options.clock);
  const phase = input.options.phase ?? DEFAULT_PHASE;
  const event: WorkflowToolTranscriptEvent = {
    type: 'workflow_tool_call',
    tool: input.tool,
    phase,
    action: input.action,
    details: input.details,
    idempotency: input.idempotency,
    at: ts,
  };
  input.options.transcript.append(event);
  if (input.includeStageArtifact) {
    input.options.stageArtifact.append({
      tool: input.tool,
      phase,
      details: input.details,
      idempotency: input.idempotency ?? { key: '', outcome: 'skipped', ref: null },
      at: ts,
    });
  }
}

async function writeTerminalStageResult(
  options: ReviewFlowOptions,
  deps: CommandToolsDeps,
  input: {
    ok: boolean;
    review: ReviewFlowReviewSummary;
    fixes: ReviewFlowFixSummary;
    linearComment?: LinearCommentResult;
    branchPublication?: BranchPublicationResult;
    pullRequest?: GitHubCreatePrResult;
    labels: GitHubAddLabelResult[];
    warnings: string[];
    failureReason?: string;
    failureCategory?: string;
    reviewIterations?: ReviewIterationRecord[];
    reviewExecutedIdentity?: ReviewExecutedIdentitySet;
  },
): Promise<Awaited<ReturnType<typeof executeWriteStageResult>>> {
  const status: StageStatus = input.ok ? 'completed' : 'failed';
  return executeWriteStageResult({
    featureDir: options.featureDir,
    issueId: options.issueId,
    stage: 'review',
    status,
    notes: stageNotes(input.review, input.ok),
    artifacts: {
      ...buildStageArtifacts({ ...input, headSha: options.headSha }),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      // A repository-mutation failure must stay distinguishable from
      // provider/model failures; this category overrides the review's own.
      ...(input.failureCategory ? { failureCategory: input.failureCategory } : {}),
    },
  }, deps);
}

export async function runReviewFlow(options: ReviewFlowOptions): Promise<ReviewFlowResult> {
  const phase = options.phase ?? DEFAULT_PHASE;
  const required: Array<[string, string | undefined | string[]]> = [
    ['issueId', options.issueId],
    ['featureDir', options.featureDir],
    ['repo', options.repo],
    ['base', options.base],
    ['head', options.head],
    ['headSha', options.headSha],
    ['title', options.title],
    ['body', options.body],
  ];
  const missing = required.find(([, value]) => {
    if (Array.isArray(value)) return value.length === 0;
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missing) {
    throw new Error(`runReviewFlow missing required option: ${missing[0]}`);
  }

  const deps = createDeps(options);
  const registry = deps.registry;

  // Read prior iteration evidence before this run's write so a rerun appends
  // rather than overwriting earlier direct evidence (HOK-2969, Arbiter P2.4f).
  const readStageResultImpl = options.readStageResultImpl ?? readStageResult;
  const existingReviewResult = await readStageResultImpl(options.featureDir, 'review');
  const iterationNumber = nextReviewIterationNumber(existingReviewResult?.artifacts);
  const recordedAt = new Date(now(options.clock)).toISOString();
  const appendIteration = (
    entry: Omit<ReviewIterationRecord, 'iteration' | 'recordedAt'>,
  ): ReviewIterationRecord[] => appendReviewIteration(existingReviewResult?.artifacts, {
    iteration: iterationNumber,
    recordedAt,
    ...entry,
  });

  const reviewWorktreeDir = options.worktreeDir ?? options.featureDir;
  const reviewCall = await executeReviewChanges({
    base: options.base,
    worktree: reviewWorktreeDir,
    json: true,
    featureDir: options.featureDir,
    additionalContext: options.reviewContextAppendix,
  }, deps);

  const initialReview: ReviewFlowReviewSummary = {
    status: reviewCall.ok ? 'completed' : 'failed',
    verdict: reviewCall.ok ? reviewCall.verdict : 'error',
    exitCode: reviewCall.exitCode ?? (reviewCall.ok ? 0 : 2),
    iterations: reviewCall.iterations ?? 1,
    findings: reviewCall.ok ? reviewCall.findings : '',
    findingCount: reviewCall.ok ? reviewCall.findingCount ?? 0 : 0,
    blockingCount: reviewCall.ok ? reviewCall.blockingCount ?? 0 : 0,
    warningCount: reviewCall.ok ? reviewCall.warningCount ?? Math.max(0, (reviewCall.findingCount ?? 0) - (reviewCall.blockingCount ?? 0)) : 0,
    dismissedBlockers: [],
    reviewToolError: reviewCall.ok ? undefined : reviewCall.message,
    failureCategory: reviewCall.failureCategory,
    needsStrongerReviewer: false,
  };
  const emptyFixes = makeFixSummary();

  if (!reviewCall.ok) {
    const warnings = [reviewCall.message];
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review: initialReview,
      fixes: emptyFixes,
      labels: [],
      warnings,
      failureReason: reviewCall.message,
      reviewIterations: appendIteration({ verdict: 'error', findings: [] }),
    });
    return {
      ok: false,
      review: initialReview,
      fixes: emptyFixes,
      labels: [],
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  let parsedReview: ReviewResult;
  try {
    parsedReview = parseStructuredReview(reviewCall.findings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedReview: ReviewFlowReviewSummary = {
      ...initialReview,
      status: 'failed',
      verdict: 'error',
      reviewToolError: message,
    };
    const warnings = [message];
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review: failedReview,
      fixes: emptyFixes,
      labels: [],
      warnings,
      failureReason: message,
      reviewIterations: appendIteration({ verdict: 'error', findings: [] }),
    });
    return {
      ok: false,
      review: failedReview,
      fixes: emptyFixes,
      labels: [],
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  const review: ReviewFlowReviewSummary = {
    ...initialReview,
    verdict: parsedReview.verdict,
    exitCode: reviewCall.exitCode ?? 0,
    iterations: reviewCall.iterations ?? 1,
    dismissedBlockers: extractDismissedBlockers(parsedReview),
    needsStrongerReviewer: parsedReview.needsStrongerReviewer === true,
  };

  const findings = extractFindings(parsedReview);
  const fixes = makeFixSummary();
  const warnings: string[] = [];
  const labels: GitHubAddLabelResult[] = [];
  let linearComment: LinearCommentResult | undefined;
  let pullRequest: GitHubCreatePrResult | undefined;

  if (!review.needsStrongerReviewer) {
    for (const finding of findings) {
      fixes.attempted += 1;
      const key = `review_fix:${options.issueId}:${finding.id}`;
      let result: ReviewFindingFixResult;

      if (!options.fixFindings) {
        result = {
          ok: true,
          outcome: 'skipped',
          findingId: finding.id,
          message: 'no fix executor configured',
        };
      } else {
        result = await options.fixFindings({
          finding,
          issueId: options.issueId,
          featureDir: options.featureDir,
          repo: options.repo,
          base: options.base,
          head: options.head,
          sessionId: options.sessionId,
          phase,
        });
      }

      const outcome = result.outcome;
      if (outcome === 'applied') fixes.applied += 1;
      if (outcome === 'skipped') fixes.skipped += 1;
      if (outcome === 'denied') fixes.denied += 1;
      if (outcome === 'failed') fixes.failed += 1;

      fixes.outcomes.push({
        findingId: finding.id,
        outcome,
        ok: result.ok,
        message: result.message,
        filesChanged: result.filesChanged,
      });

      if (outcome === 'failed' || outcome === 'denied') {
        warnings.push(result.message ?? `${finding.id} ${outcome}`);
      }

      recordToolEvent({
        options,
        tool: 'review_fix',
        action: 'narrow_fix',
        details: {
          finding,
          message: result.message,
          filesChanged: result.filesChanged ?? [],
        },
        idempotency: {
          key,
          outcome,
          ref: null,
          reason: result.message,
        },
        includeStageArtifact: true,
      });
      if (outcome === 'applied') {
        registry.record(key, { key, outcome: 'updated', ref: null, reason: result.message });
      }
    }
  }

  // Complete local evidence for this iteration: structured findings (with
  // disposition), the reviewer-authored delta anchored to the shared fork
  // commit, and the executed identity that produced them (HOK-2969). `fixes`
  // is final by this point on every remaining path below, so this is
  // computed once and reused for every subsequent terminal write.
  const reviewerDelta = buildReviewerDelta(options);
  const reviewIterations = appendIteration({
    verdict: review.verdict,
    ...(options.headSha ? { headSha: options.headSha } : {}),
    findings: buildFindingRecords(parsedReview, fixes),
    ...(reviewerDelta ? { reviewerDelta } : {}),
  });
  const reviewExecutedIdentity = buildIterationExecutedIdentity(reviewCall, fixes);

  if (review.needsStrongerReviewer) {
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: true,
      review,
      fixes,
      labels,
      warnings,
      reviewIterations,
      ...(reviewExecutedIdentity ? { reviewExecutedIdentity } : {}),
    });
    return {
      ok: true,
      review,
      fixes,
      labels,
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  linearComment = await executeLinearComment({
    issue: options.issueId,
    body: buildLinearCommentBody(options.issueId, review, fixes),
    sessionId: options.sessionId,
    phase,
  }, {
    client: options.linearClient,
    registry,
    transcript: options.transcript,
    stageArtifact: options.stageArtifact,
    sessionId: options.sessionId,
    phase,
    clock: options.clock,
    networkPolicy: options.networkPolicy,
  });
  if (!linearComment.ok) {
    warnings.push(`linear_comment: ${linearComment.message}`);
  }

  // Publication preflight (HOK-2914): prove origin/<head> resolves to exactly
  // the reviewed SHA before any PR create call. Runs after review/fixes so it
  // publishes the SHA that was actually reviewed.
  const publishBranch = options.publishBranchImpl ?? publishReviewedBranch;
  const branchPublication = await publishBranch({
    worktreeDir: reviewWorktreeDir,
    branch: options.head,
    reviewedSha: options.headSha,
    baseBranch: options.base,
  });

  recordToolEvent({
    options,
    tool: 'branch_publication',
    action: 'publish_branch',
    details: branchPublication.ok
      ? {
          remote: branchPublication.remote,
          branch: branchPublication.branch,
          localSha: branchPublication.localSha,
          remoteSha: branchPublication.remoteSha,
        }
      : {
          remote: branchPublication.remote,
          branch: branchPublication.branch,
          reason: branchPublication.reason,
          message: branchPublication.message,
          localSha: branchPublication.localSha,
          remoteSha: branchPublication.remoteSha,
          recoveryCommand: branchPublication.recoveryCommand,
        },
    idempotency: {
      key: `branch_publication:${options.repo}:${options.head}:${options.headSha}`,
      outcome: branchPublication.ok ? branchPublication.outcome : 'skipped',
      ref: null,
      reason: branchPublication.ok ? undefined : branchPublication.message,
    },
    includeStageArtifact: true,
  });

  if (!branchPublication.ok) {
    const failureCategory = branchPublication.reason === 'no-commits-ahead-of-base'
      ? 'pr-orchestration'
      : 'branch-publication';
    warnings.push(`branch_publication: ${branchPublication.message}`);
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review,
      fixes,
      linearComment,
      branchPublication,
      labels,
      warnings,
      failureReason: `branch publication failed (${branchPublication.reason}): ${branchPublication.message}; recover with: ${branchPublication.recoveryCommand}`,
      failureCategory,
      reviewIterations,
      ...(reviewExecutedIdentity ? { reviewExecutedIdentity } : {}),
    });
    return {
      ok: false,
      review,
      fixes,
      linearComment,
      branchPublication,
      labels,
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  pullRequest = await githubCreatePr({
    repo: options.repo,
    phase,
    head: options.head,
    base: options.base,
    headSha: options.headSha,
    title: options.title,
    body: buildPrBody(options.body, review, fixes),
  }, options.githubDeps);

  recordToolEvent({
    options,
    tool: 'github_create_pr',
    action: pullRequest.ok && pullRequest.idempotency.outcome === 'updated' ? 'update_pr' : 'create_pr',
    details: pullRequest.ok
      ? {
          repo: options.repo,
          head: options.head,
          base: options.base,
          title: options.title,
        }
      : {
          repo: options.repo,
          head: options.head,
          base: options.base,
          error: pullRequest.error,
          message: pullRequest.message,
        },
    idempotency: pullRequest.ok
      ? {
          key: pullRequest.idempotency.key,
          outcome: pullRequest.idempotency.outcome,
          ref: pullRequest.idempotency.ref,
          reason: pullRequest.idempotency.reason,
        }
      : {
          key: `github_create_pr:${options.repo}:${options.head}:${options.base}:${options.headSha}`,
          outcome: 'skipped',
          ref: null,
          reason: pullRequest.message,
        },
    includeStageArtifact: true,
  });

  if (!pullRequest.ok) {
    // The preflight should make GitHub's unresolvable-head error impossible,
    // but if it still appears, surface the real diagnosis instead of the
    // misleading "No commits between ..." text.
    const translated = translateGitHubHeadError(pullRequest.message);
    const failureReason = translated
      ? `${translated} (GitHub said: ${pullRequest.message})`
      : pullRequest.message;
    warnings.push(`github_create_pr: ${failureReason}`);
    const stageResult = await writeTerminalStageResult(options, deps, {
      ok: false,
      review,
      fixes,
      linearComment,
      branchPublication,
      pullRequest,
      labels,
      warnings,
      failureReason,
      failureCategory: translated ? 'branch-publication' : 'pr-orchestration',
      reviewIterations,
      ...(reviewExecutedIdentity ? { reviewExecutedIdentity } : {}),
    });
    return {
      ok: false,
      review,
      fixes,
      linearComment,
      branchPublication,
      pullRequest,
      labels,
      stageResult,
      haltedBeforeMerge: true,
      merged: false,
      warnings,
    };
  }

  // Effective readiness (HOK-2932): the same rule as the monitor's ready gate.
  // A raw blocker no longer withholds wm:ready when every blocker was
  // auditably dismissed with a justification.
  const reviewPassedReadyGate = reviewOutcomePassesReadyGate({
    exitCode: review.exitCode,
    verdict: review.verdict,
    iterations: review.iterations,
    blockerCount: review.blockingCount,
    dismissedBlockers: review.dismissedBlockers,
  });
  const dedupedLabels = [...new Set((options.labels ?? []).map((label) => label.trim()).filter(Boolean))]
    .filter((label) => label !== 'wm:ready' || reviewPassedReadyGate);
  for (const label of dedupedLabels) {
    const labelResult = await githubAddLabel({
      repo: options.repo,
      phase,
      targetKind: 'pull_request',
      targetNumber: pullRequest.idempotency.ref!.number,
      label,
    }, options.githubDeps);
    labels.push(labelResult);
    recordToolEvent({
      options,
      tool: 'github_add_label',
      action: 'add_label',
      details: labelResult.ok
        ? {
            repo: options.repo,
            targetNumber: pullRequest.idempotency.ref!.number,
            label,
          }
        : {
            repo: options.repo,
            targetNumber: pullRequest.idempotency.ref!.number,
            label,
            error: labelResult.error,
            message: labelResult.message,
          },
      idempotency: labelResult.ok
        ? {
            key: labelResult.idempotency.key,
            outcome: labelResult.idempotency.outcome,
            ref: labelResult.idempotency.ref,
            reason: labelResult.idempotency.reason,
          }
        : {
            key: `github_add_label:${options.repo}:pull_request:${pullRequest.idempotency.ref!.number}:${label.toLowerCase()}`,
            outcome: 'skipped',
            ref: null,
            reason: labelResult.message,
          },
      includeStageArtifact: true,
    });
    if (!labelResult.ok) {
      warnings.push(`github_add_label(${label}): ${labelResult.message}`);
    }
  }

  const stageResult = await writeTerminalStageResult(options, deps, {
    ok: true,
    review,
    fixes,
    linearComment,
    branchPublication,
    pullRequest,
    labels,
    warnings,
    reviewIterations,
    ...(reviewExecutedIdentity ? { reviewExecutedIdentity } : {}),
  });

  return {
    ok: true,
    review,
    fixes,
    linearComment,
    branchPublication,
    pullRequest,
    labels,
    stageResult,
    haltedBeforeMerge: true,
    merged: false,
    warnings,
  };
}
