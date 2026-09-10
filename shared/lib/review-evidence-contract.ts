/**
 * Review Evidence Contract - Local review-evidence artifact schema
 *
 * Defines the structure for persisting complete, directly comparable review evidence
 * at the arm level. This includes the three role identities, every iteration's findings,
 * test commands, reviewer delta, and explicit absence/error state.
 *
 * Raw prompts, full diffs, and command output remain local and gitignored.
 * Only derived metrics and presence/digest/identity are exposed to Arbiter.
 *
 * @module review-evidence-contract
 */

import { createHash } from 'node:crypto';

/**
 * Execution identity for one role in the review process.
 *
 * Distinguishes between requested, resolved (actual), and status flags:
 * - `requested`: Model specified at launch (from WAVEMILL_RESOLVED_MODEL or CLI)
 * - `resolved`: Actual model/provider that ran (may differ if fallback occurred)
 * - `status`: 'pinned' (request matched resolved), 'fallback' (different model used),
 *   'conflict' (multiple sources disagree), 'unavailable' (no provider ready),
 *   'unpinned' (no requested model available)
 */
export interface ExecutionIdentity {
  /** Requested model ID (null if not pinned) */
  requested: string | null;
  /** Actual model that executed (null if not run or pinned analysis unavailable) */
  resolved: string | null;
  /** Provider name for resolved model (e.g., 'anthropic', 'openrouter') */
  resolvedProvider?: string;
  /** Status: 'pinned', 'fallback', 'conflict', 'unavailable', 'unpinned', 'not-run' */
  status: 'pinned' | 'fallback' | 'conflict' | 'unavailable' | 'unpinned' | 'not-run';
  /** Source of the requested model: 'env', 'cli', 'config', or null */
  requestSource?: string | null;
}

/**
 * Execution identity set for all three review roles.
 *
 * Allows independent tracking of who did what:
 * - `orchestrator`: Outer review-changes/review-runner/review-engine caller
 * - `analysis`: Inner review-changes analysis (the challenged dimension)
 * - `remediation`: Optional fix/mitigation model (not counted toward analysis verdict)
 *
 * For a reviewer-stage challenge, the `analysis` identity is the challenged dimension
 * and must be pinned. Outer `remediation` variation alone is explicit and cannot be
 * credited as reviewer analysis.
 */
export interface ReviewExecutedIdentitySet {
  /** Review orchestrator (outer caller) */
  orchestrator: ExecutionIdentity;
  /** Substantive analysis model (the challenged dimension) */
  analysis: ExecutionIdentity;
  /** Optional remediation/fix model (not counted toward analysis) */
  remediation?: ExecutionIdentity | null;
  /** Timestamp when identities were recorded (ISO 8601) */
  recordedAt: string;
  /** Optional narrative about identity conflicts or fallbacks */
  notes?: string;
}

/**
 * Single finding from a review iteration.
 *
 * Captures everything needed to evaluate reviewer analysis:
 * location, category, severity, evidence, proposed fix, disposition, and dismissal.
 */
export interface ReviewIterationFinding {
  /** File path and line/function location */
  location: string;
  /** Finding category (e.g., 'correctness', 'performance', 'security') */
  category: string;
  /** 'blocker' or 'warning' */
  severity: 'blocker' | 'warning';
  /** Description of the issue */
  description: string;
  /** Evidence excerpt (code snippet, test output, etc.) */
  evidence?: string;
  /** Proposed fix or remediation */
  proposedFix?: string;
  /** Disposition: 'open', 'fixed', 'dismissed' */
  disposition: 'open' | 'fixed' | 'dismissed';
  /** If dismissed: why the finding was invalid */
  dismissalJustification?: string;
  /** If dismissed: verification command and result (e.g., test output) */
  dismissalEvidence?: string;
}

/**
 * Test or reproduction command executed during review.
 *
 * Captures what was tried and the outcome.
 */
export interface ReviewCommand {
  /** Command text that was executed */
  command: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Command output (trimmed to reasonable length) */
  stdout?: string;
  /** Error output if any */
  stderr?: string;
  /** Timestamp when command was run (ISO 8601) */
  ranAt: string;
  /** Why the command was run (e.g., 'verify-performance', 'check-tests') */
  purpose?: string;
}

/**
 * Delta evidence computed from the shared fork commit.
 *
 * Allows direct comparison of reviewer's changes.
 */
export interface ReviewerDelta {
  /** SHA of the shared fork commit baseline */
  forkCommitSha: string | null;
  /** Whether fork commit was verified to exist */
  forkCommitVerified: boolean;
  /** Files modified by the reviewer since fork commit */
  filesChanged: string[];
  /** Number of lines added/removed */
  linesAdded: number;
  /** Lines removed */
  linesRemoved: number;
  /** Failure reason if delta could not be computed */
  failureReason?: string;
}

/**
 * One iteration of the review process.
 *
 * Iterations accumulate as the review process repeats (e.g., for fixes and re-review).
 */
export interface ReviewIteration {
  /** Iteration number (1-based) */
  number: number;
  /** Timestamp when iteration started (ISO 8601) */
  startedAt: string;
  /** Timestamp when iteration completed (ISO 8601) */
  completedAt: string;
  /** Findings from this iteration */
  findings: ReviewIterationFinding[];
  /** Commands tried during this iteration */
  commands: ReviewCommand[];
  /** Reviewer delta from fork commit */
  delta: ReviewerDelta;
  /** Whether this iteration passed review */
  passedReview: boolean;
  /** Summary reason if failed */
  failureReason?: string;
}

/**
 * Schema version and digest for local review evidence.
 *
 * Allows readers to verify artifact integrity and validate version compatibility.
 */
export interface ReviewEvidenceMetadata {
  /** Schema version of this artifact (e.g., '1.0.0') */
  schemaVersion: string;
  /** SHA-256 of all iterations + identities (for integrity checking) */
  contentDigest: string;
  /** Timestamp when artifact was created (ISO 8601) */
  createdAt: string;
  /** Timestamp when artifact was last updated (ISO 8601) */
  updatedAt: string;
}

/**
 * Complete local review-evidence artifact.
 *
 * Persisted at `{armDir}/.review-evidence.json` (gitignored).
 * Contains all raw findings, commands, and identity evidence.
 *
 * Readers should validate:
 * 1. `metadata.schemaVersion` matches expected version
 * 2. `identities` analysis status is 'pinned' (not fallback, conflict, unavailable, unpinned)
 * 3. `iterations` has at least one with `passedReview: true`
 */
export interface ReviewEvidenceArtifact {
  /** Metadata and versioning */
  metadata: ReviewEvidenceMetadata;
  /** Execution identities for orchestrator, analysis, remediation */
  identities: ReviewExecutedIdentitySet;
  /** All iterations of the review process */
  iterations: ReviewIteration[];
  /** Error state if artifact could not be created/updated */
  error?: {
    reason: 'missing-artifact' | 'malformed-artifact' | 'identity-unverifiable' | 'unknown';
    message: string;
  };
}

/**
 * Compute SHA-256 digest of review evidence.
 *
 * Used for integrity checking and change detection.
 */
export function computeReviewEvidenceDigest(
  identities: ReviewExecutedIdentitySet,
  iterations: ReviewIteration[]
): string {
  const content = JSON.stringify({
    identities: {
      orchestrator: identities.orchestrator,
      analysis: identities.analysis,
      remediation: identities.remediation,
    },
    iterations: iterations.map(it => ({
      number: it.number,
      findingCount: it.findings.length,
      passedReview: it.passedReview,
    })),
  });
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine if an identity is valid for challenge attribution.
 *
 * For challenge validity, the analysis identity must be:
 * 1. Pinned (requested and resolved match)
 * 2. Not marked as fallback, conflict, unavailable, or unpinned
 * 3. Both requested and resolved must be non-null
 */
export function isAnalysisIdentityValid(identity: ExecutionIdentity): boolean {
  return (
    identity.status === 'pinned' &&
    identity.requested !== null &&
    identity.resolved !== null
  );
}

/**
 * Determine if review evidence is sufficient for stage attribution.
 *
 * Returns the evidence mode ('direct', 'inferred-fallback', or 'not-applicable')
 * and the reason if evidence is insufficient.
 */
export function classifyEvidenceMode(
  artifact: ReviewEvidenceArtifact | null | undefined,
  identities?: ReviewExecutedIdentitySet
): {
  mode: 'direct' | 'inferred-fallback' | 'not-applicable';
  reason?: string;
  statusReason?: string;
} {
  if (!artifact) {
    return { mode: 'not-applicable', reason: 'missing-artifact' };
  }

  if (artifact.error) {
    return { mode: 'not-applicable', reason: `artifact-error: ${artifact.error.reason}` };
  }

  const identity = identities || artifact.identities;

  if (!isAnalysisIdentityValid(identity.analysis)) {
    const statusReason = identity.analysis.status;
    return {
      mode: 'not-applicable',
      reason: `analysis-identity-invalid: ${statusReason}`,
      statusReason,
    };
  }

  if (identity.remediation && identity.remediation.status !== 'not-run' && identity.remediation.resolved !== null) {
    // Remediation ran but didn't match requested
    if (identity.remediation.status === 'fallback') {
      return { mode: 'inferred-fallback', reason: 'remediation-fallback' };
    }
  }

  return { mode: 'direct', reason: 'analysis-pinned' };
}

/**
 * Count findings by status and severity in an artifact.
 */
export function countReviewFindings(artifact: ReviewEvidenceArtifact): {
  total: number;
  blockers: number;
  dismissed: number;
  passedIterations: number;
} {
  let total = 0;
  let blockers = 0;
  let dismissed = 0;
  let passedIterations = 0;

  for (const iteration of artifact.iterations) {
    if (iteration.passedReview) {
      passedIterations++;
    }
    for (const finding of iteration.findings) {
      total++;
      if (finding.severity === 'blocker' && finding.disposition !== 'dismissed') {
        blockers++;
      }
      if (finding.disposition === 'dismissed') {
        dismissed++;
      }
    }
  }

  return { total, blockers, dismissed, passedIterations };
}

/**
 * Create a new empty review evidence artifact.
 */
export function createEmptyReviewEvidence(identities: ReviewExecutedIdentitySet): ReviewEvidenceArtifact {
  const now = new Date().toISOString();
  return {
    metadata: {
      schemaVersion: '1.0.0',
      contentDigest: '',
      createdAt: now,
      updatedAt: now,
    },
    identities,
    iterations: [],
  };
}
