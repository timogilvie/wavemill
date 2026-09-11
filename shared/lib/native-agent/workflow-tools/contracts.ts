/**
 * Workflow Tool Contracts — HOK-2355
 *
 * Defines the shared input/output contract for the eight native workflow tools:
 * linear_get_issue, linear_comment, github_create_pr, github_add_label,
 * review_changes, route_task, expand_issue, and write_stage_result.
 *
 * All shapes are pure type-level declarations with no runtime side effects.
 * Implementers must satisfy these contracts; this module does not execute tools.
 *
 * ## Schema versioning
 * The schema follows semver. Additive (backward-compatible) additions increment
 * the minor version. Breaking changes increment the major version. The JSON
 * Schema mirror in contracts.json must expose the same version.
 */

import type { ToolResultMetadata } from '../tools/types.ts';
import type { ExecutedIdentity } from '../../challenge-execution-contract.ts';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const WORKFLOW_TOOL_SCHEMA_VERSION = '1.3.0' as const;

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

export const WORKFLOW_TOOL_NAMES = [
  'linear_get_issue',
  'linear_comment',
  'github_create_pr',
  'github_add_label',
  'review_changes',
  'route_task',
  'expand_issue',
  'write_stage_result',
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Workflow phase in which a tool may run.
 * Note: native-agent/tools/types.ts uses ToolPhase = 'planning' | 'coding' | 'review',
 * which omits 'ready'. This workflow-tool contract extends the vocabulary with
 * 'ready' for gate and policy purposes without changing the existing ToolPhase type.
 */
export const WORKFLOW_PHASES = ['planning', 'coding', 'review', 'ready'] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

// ---------------------------------------------------------------------------
// Mutation actions
// ---------------------------------------------------------------------------

/**
 * Enumerated mutation actions used in the phase/tool policy matrix.
 * The 'merge' action exists only so the policy gate can explicitly deny it;
 * no tool exposes merge as an allowed operation.
 */
export const WORKFLOW_MUTATION_ACTIONS = [
  'read',
  'comment',
  'create_pr',
  'update_pr',
  'add_label',
  'write_stage_result',
  'stale_base',
  'merge_conflict',
  'merge',
] as const;

export type WorkflowMutationAction = (typeof WORKFLOW_MUTATION_ACTIONS)[number];

// ---------------------------------------------------------------------------
// External object references
// ---------------------------------------------------------------------------

export type ExternalRefSystem = 'linear' | 'github' | 'wavemill';
export type ExternalRefKind =
  | 'issue'
  | 'comment'
  | 'pull_request'
  | 'label'
  | 'stage_result'
  | 'review'
  | 'route'
  | 'task_packet';

/** A stable, provider-agnostic reference to an external object. */
export interface ExternalRef {
  system: ExternalRefSystem;
  kind: ExternalRefKind;
  id: string;
  /** Human-readable URL for the object, when available. */
  url?: string;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_OUTCOMES = ['created', 'reused', 'updated', 'skipped'] as const;
export type IdempotencyOutcome = (typeof IDEMPOTENCY_OUTCOMES)[number];

/**
 * Idempotency result attached to every mutating tool response.
 * `ref` is null when outcome is 'skipped' and no external object was touched.
 */
export interface IdempotencyResult<TRef extends ExternalRef = ExternalRef> {
  /** Stable dedupe key for this operation. See dedupe-key registry in docs. */
  key: string;
  outcome: IdempotencyOutcome;
  ref: TRef | null;
  /** Additional references when the operation involves multiple external objects. */
  refs?: TRef[];
  /** Human-readable explanation, especially useful when outcome is 'skipped'. */
  reason?: string;
}

interface WorkflowToolResultBase {
  metadata?: ToolResultMetadata;
}

// ---------------------------------------------------------------------------
// Common error codes
// ---------------------------------------------------------------------------

export type CommonErrorCode =
  | 'invalid_input'
  | 'policy_denied'
  | 'not_found'
  | 'aborted'
  | 'external_error'
  | 'io_error'
  | 'schema_mismatch';

export type ToolSpecificErrorCode =
  | 'conflict'
  | 'rate_limited'
  | 'review_failed'
  | 'route_failed'
  | 'expansion_failed';

export type WorkflowToolErrorCode = CommonErrorCode | ToolSpecificErrorCode;

// ---------------------------------------------------------------------------
// Recording requirements
// ---------------------------------------------------------------------------

/**
 * Describes the recording requirements for a workflow tool invocation.
 * External mutations must record to both the session transcript and the
 * stage artifact log. Credentials and secret-bearing headers must never appear
 * in recorded fields.
 */
export interface RecordingRequirement {
  tool: WorkflowToolName;
  /** Whether this tool must produce a transcript tool_result event. */
  requiresTranscriptRecord: boolean;
  /** Whether this tool must produce a stage artifact mutation record. */
  requiresStageArtifactRecord: boolean;
  /**
   * Fields that must appear in every recorded result.
   * Applicable when requiresTranscriptRecord or requiresStageArtifactRecord is true.
   */
  requiredRecordedFields: readonly string[];
}

/** Recording requirements for all eight workflow tools. */
export const RECORDING_REQUIREMENTS: readonly RecordingRequirement[] = [
  {
    tool: 'linear_get_issue',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: false,
    requiredRecordedFields: ['tool', 'phase'],
  },
  {
    tool: 'linear_comment',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: true,
    requiredRecordedFields: ['tool', 'phase', 'idempotency.key', 'idempotency.outcome', 'idempotency.ref'],
  },
  {
    tool: 'github_create_pr',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: true,
    requiredRecordedFields: ['tool', 'phase', 'idempotency.key', 'idempotency.outcome', 'idempotency.ref'],
  },
  {
    tool: 'github_add_label',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: true,
    requiredRecordedFields: ['tool', 'phase', 'idempotency.key', 'idempotency.outcome', 'idempotency.ref'],
  },
  {
    tool: 'review_changes',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: false,
    requiredRecordedFields: ['tool', 'phase'],
  },
  {
    tool: 'route_task',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: false,
    requiredRecordedFields: ['tool', 'phase'],
  },
  {
    tool: 'expand_issue',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: false,
    requiredRecordedFields: ['tool', 'phase'],
  },
  {
    tool: 'write_stage_result',
    requiresTranscriptRecord: true,
    requiresStageArtifactRecord: true,
    requiredRecordedFields: ['tool', 'phase', 'idempotency.key', 'idempotency.outcome', 'idempotency.ref'],
  },
] as const;

// ---------------------------------------------------------------------------
// Tool-specific external ref types
// ---------------------------------------------------------------------------

export interface LinearIssueRef extends ExternalRef {
  system: 'linear';
  kind: 'issue';
}

export interface LinearCommentRef extends ExternalRef {
  system: 'linear';
  kind: 'comment';
}

export interface GitHubPullRequestRef extends ExternalRef {
  system: 'github';
  kind: 'pull_request';
  /** GitHub PR number. */
  number: number;
}

export interface GitHubLabelRef extends ExternalRef {
  system: 'github';
  kind: 'label';
}

export interface WavemillStageResultRef extends ExternalRef {
  system: 'wavemill';
  kind: 'stage_result';
}

export interface WavemillRouteRef extends ExternalRef {
  system: 'wavemill';
  kind: 'route';
}

export interface WavemillTaskPacketRef extends ExternalRef {
  system: 'wavemill';
  kind: 'task_packet';
}

// ---------------------------------------------------------------------------
// linear_get_issue
// ---------------------------------------------------------------------------

export interface LinearGetIssueRequest {
  /** Linear issue ID or key (e.g. "HOK-1234"). */
  issue: string;
  /** When true, include linked issue relationships. */
  includeRelations?: boolean;
  /** When true, include comment history. */
  includeComments?: boolean;
}

export interface LinearGetIssueSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'linear_get_issue';
  /** Raw issue data from Linear. Treat as external-untrusted provenance. */
  issue: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    state?: string;
    assignee?: string;
    labels?: string[];
    url?: string;
  };
}

export interface LinearGetIssueError extends WorkflowToolResultBase {
  ok: false;
  tool: 'linear_get_issue';
  error: CommonErrorCode;
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type LinearGetIssueResult = LinearGetIssueSuccess | LinearGetIssueError;

// ---------------------------------------------------------------------------
// linear_comment
// ---------------------------------------------------------------------------

export interface LinearCommentRequest {
  /** Linear issue ID or key. */
  issue: string;
  /** Markdown comment body. */
  body: string;
  /** Native session identifier for dedupe key construction. */
  sessionId: string;
  /** Current workflow phase, used in dedupe key. */
  phase: WorkflowPhase;
  /** Override the content hash used in the dedupe key (advanced use only). */
  dedupeOverride?: string;
}

export interface LinearCommentSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'linear_comment';
  idempotency: IdempotencyResult<LinearCommentRef>;
}

export interface LinearCommentError extends WorkflowToolResultBase {
  ok: false;
  tool: 'linear_comment';
  error: CommonErrorCode | 'rate_limited';
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type LinearCommentResult = LinearCommentSuccess | LinearCommentError;

// ---------------------------------------------------------------------------
// github_create_pr
// ---------------------------------------------------------------------------

export interface GitHubCreatePrRequest {
  /** Repository in "owner/repo" form. */
  repo: string;
  /** Workflow phase used by the mutation policy gate. Defaults to "review". */
  phase?: WorkflowPhase;
  /** Source branch for the PR. */
  head: string;
  /** Target branch for the PR. */
  base: string;
  /** Head commit SHA used as part of the dedupe key. */
  headSha: string;
  title: string;
  body: string;
  /** Create as a draft PR. */
  draft?: boolean;
}

export interface GitHubCreatePrSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'github_create_pr';
  idempotency: IdempotencyResult<GitHubPullRequestRef>;
}

export interface GitHubCreatePrError extends WorkflowToolResultBase {
  ok: false;
  tool: 'github_create_pr';
  error: CommonErrorCode | 'conflict' | 'rate_limited';
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type GitHubCreatePrResult = GitHubCreatePrSuccess | GitHubCreatePrError;

// ---------------------------------------------------------------------------
// github_add_label
// ---------------------------------------------------------------------------

export interface GitHubAddLabelRequest {
  /** Repository in "owner/repo" form. */
  repo: string;
  /** Workflow phase used by the mutation policy gate. Defaults to "review". */
  phase?: WorkflowPhase;
  /** Whether the target is a PR or issue. */
  targetKind: 'pull_request' | 'issue';
  /** PR or issue number. */
  targetNumber: number;
  /** Label name to add. */
  label: string;
}

export interface GitHubAddLabelSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'github_add_label';
  idempotency: IdempotencyResult<GitHubLabelRef>;
}

export interface GitHubAddLabelError extends WorkflowToolResultBase {
  ok: false;
  tool: 'github_add_label';
  error: CommonErrorCode | 'conflict' | 'not_found' | 'rate_limited';
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type GitHubAddLabelResult = GitHubAddLabelSuccess | GitHubAddLabelError;

// ---------------------------------------------------------------------------
// review_changes
// ---------------------------------------------------------------------------

export interface ReviewChangesRequest {
  /** Git ref to diff against (e.g. "main" or a commit SHA). */
  base: string;
  /** Worktree path or branch context for the review. */
  worktree?: string;
  /** Return structured JSON findings instead of plain text. */
  json?: boolean;
  /** Maximum output bytes. Implementer should truncate or reject above this. */
  maxOutputBytes?: number;
}

export interface ReviewChangesSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'review_changes';
  /** Plain-text or JSON review findings. Treat as wavemill-generated provenance. */
  findings: string;
  findingCount?: number;
  blockingCount?: number;
  /** Process-equivalent final review tool exit code. Success is always 0. */
  exitCode?: number;
  /** Parsed final review verdict. */
  verdict?: 'ready' | 'not_ready';
  /** Number of review tool iterations represented by this result. */
  iterations?: number;
  /** Alias used by stage-result readiness predicates. */
  blockerCount?: number;
  warningCount?: number;
  failureCategory?: string;
  /**
   * Orchestrator (calling agent) and substantive-analysis identities executed
   * for this call, with pin/fallback status (HOK-2969, Arbiter P2.4f).
   * Remediation identity is layered on separately by the review flow that
   * applies fixes across findings from potentially multiple calls.
   */
  executedIdentity?: {
    orchestrator: ExecutedIdentity;
    substantiveAnalysis: ExecutedIdentity;
  };
}

export interface ReviewChangesError extends WorkflowToolResultBase {
  ok: false;
  tool: 'review_changes';
  error: CommonErrorCode | 'review_failed';
  message: string;
  /** Process-equivalent final review tool exit code. Tool errors are 2. */
  exitCode?: number;
  verdict?: 'error';
  iterations?: number;
  blockerCount?: number;
  warningCount?: number;
  failureCategory?: string;
  diagnostics?: Record<string, unknown>;
}

export type ReviewChangesResult = ReviewChangesSuccess | ReviewChangesError;

// ---------------------------------------------------------------------------
// route_task
// ---------------------------------------------------------------------------

export interface RouteTaskRequest {
  /** Absolute path to the task packet file. */
  taskPacketPath: string;
  /** Repository root directory. */
  repoDir?: string;
  /** Route mode hint (e.g. "normal", "constrained", "survival"). */
  routeMode?: string;
  /** Optional model pool to pass through to the router. */
  modelsAvailable?: string[];
}

export interface RouteTaskSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'route_task';
  /** Route artifact. Treat as wavemill-generated provenance. */
  route: {
    model?: string;
    mode?: string;
    rationale?: string;
  };
  ref?: WavemillRouteRef;
}

export interface RouteTaskError extends WorkflowToolResultBase {
  ok: false;
  tool: 'route_task';
  error: CommonErrorCode | 'route_failed';
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type RouteTaskResult = RouteTaskSuccess | RouteTaskError;

// ---------------------------------------------------------------------------
// expand_issue
// ---------------------------------------------------------------------------

export interface ExpandIssueRequest {
  /** Linear issue ID or key. */
  issue: string;
  /** Directory where the task packet should be written. */
  outputDir?: string;
}

export interface ExpandIssueSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'expand_issue';
  /** Task packet output path. Treat as wavemill-generated provenance. */
  taskPacketPath: string;
  ref?: WavemillTaskPacketRef;
  /** Idempotency metadata (optional; present when the tool executor tracks dedupe). */
  idempotency?: IdempotencyResult<WavemillTaskPacketRef>;
}

export interface ExpandIssueError extends WorkflowToolResultBase {
  ok: false;
  tool: 'expand_issue';
  error: CommonErrorCode | 'expansion_failed';
  message: string;
  diagnostics?: Record<string, unknown>;
}

export type ExpandIssueResult = ExpandIssueSuccess | ExpandIssueError;

// ---------------------------------------------------------------------------
// write_stage_result
// ---------------------------------------------------------------------------

export interface WriteStageResultRequest {
  /** Feature directory path or feature identifier. */
  featureDir: string;
  /** Linear issue ID associated with this feature. */
  issueId: string;
  /** Workflow stage for the result file. */
  stage: 'planning' | 'coding' | 'review' | 'ready';
  /** Stage completion status. */
  status: 'running' | 'awaiting_user' | 'completed' | 'aborted' | 'failed';
  /** Human-readable summary of the stage outcome. */
  notes?: string;
  /** Stage-specific artifact metadata. */
  artifacts?: Record<string, unknown>;
}

export interface WriteStageResultSuccess extends WorkflowToolResultBase {
  ok: true;
  tool: 'write_stage_result';
  idempotency: IdempotencyResult<WavemillStageResultRef>;
}

export interface WriteStageResultError extends WorkflowToolResultBase {
  ok: false;
  tool: 'write_stage_result';
  error: CommonErrorCode;
  message: string;
}

export type WriteStageResultResult = WriteStageResultSuccess | WriteStageResultError;

// ---------------------------------------------------------------------------
// Union of all tool results
// ---------------------------------------------------------------------------

export type WorkflowToolResult =
  | LinearGetIssueResult
  | LinearCommentResult
  | GitHubCreatePrResult
  | GitHubAddLabelResult
  | ReviewChangesResult
  | RouteTaskResult
  | ExpandIssueResult
  | WriteStageResultResult;
