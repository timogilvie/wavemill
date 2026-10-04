/**
 * Eval context gathering — fetch and format all context needed for evaluation.
 *
 * Centralizes data fetching for:
 * - Linear issue data (via get-issue --json)
 * - GitHub PR data (diff and URL via gh CLI)
 *
 * All functions are non-throwing: errors are caught and return null/empty
 * values so eval can proceed with degraded data.
 *
 * @module eval-context-gatherer
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { fetchPrDiff, type PrDiffUnavailableReason } from './pr-diff-provider.ts';
import { loadMetrics } from './review-metrics.ts';
import type {
  EvalExecutedPlanning,
  EvalPhaseDurations,
  EvalRouting,
  PlanningExecutionOutcome,
  RoutePrediction,
  RoutingDecision,
  RoutingCandidate,
} from './eval-schema.ts';
import {
  POLICY_RESOLVER_VERSION,
  ROUTE_ARTIFACT_SCHEMA_VERSION,
  buildRoutePrediction,
  resolveRouterPolicyVersion,
} from './route-artifact.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const defaultShellDependencies = { escapeShellArg, execShellCommand, fetchPrDiff };
let shellDependencies = defaultShellDependencies;

/** Override shell access for deterministic unit tests. */
export function setEvalContextGathererShellDependenciesForTest(
  overrides: Partial<typeof defaultShellDependencies>,
): void {
  shellDependencies = { ...defaultShellDependencies, ...overrides };
}

/** Restore production shell access after a unit test override. */
export function resetEvalContextGathererShellDependenciesForTest(): void {
  shellDependencies = defaultShellDependencies;
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Complete context needed for running eval. */
export interface EvalContext {
  /** Formatted task prompt (issue title + description) */
  taskPrompt: string;
  /** PR diff content */
  prDiff: string;
  /** PR URL */
  prUrl: string;
  /** Whether the PR diff was retrieved or why it was unavailable. */
  prDiffAvailability: PrDiffAvailability;
  /** Raw issue data from Linear (null if fetch failed) */
  issueData: any | null;
  /** Expanded task packet content (if available) */
  taskPacket?: string;
  /** Implementation plan content (if available) */
  planContent?: string;
  /** Self-review summary (if available) */
  selfReviewSummary?: string;
  /** Routing decision loaded from .routing-complete (if available) */
  routingDecision?: RoutingDecision;
}

export type PrDiffAvailability =
  | { available: true; source: 'gh-pr-diff' | 'local-git'; bytes: number; attempts: string[] }
  | { available: false; reason: PrDiffUnavailableReason; detail: string; attempts: string[] };

/** Input parameters for gathering context. */
export interface GatherContextParams {
  /** Linear issue ID (e.g. "HOK-870") */
  issueId?: string;
  /** GitHub PR number */
  prNumber?: string;
  /** PR URL (if already known) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
}

// ────────────────────────────────────────────────────────────────
// Issue Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch issue data from Linear via the get-issue tool in JSON mode.
 * Returns the parsed issue object or null on failure.
 */
export function fetchIssueData(issueId: string, repoDir: string): any | null {
  const toolPath = resolve(__dirname, '../../tools/get-issue.ts');
  try {
    const raw = shellDependencies.execShellCommand(
      `npx tsx ${shellDependencies.escapeShellArg(toolPath)} ${shellDependencies.escapeShellArg(issueId)} --json 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format issue data as a markdown prompt.
 */
export function formatIssueAsPrompt(issue: any | null, issueId: string): string {
  if (!issue) return `Issue: ${issueId} (details unavailable)`;
  return `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
}

// ────────────────────────────────────────────────────────────────
// PR Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR diff and URL from GitHub.
 */
export function fetchPrContext(prNumber: string, repoDir: string): { diff: string; url: string; availability: PrDiffAvailability } {
  let url = '';

  try {
    url = shellDependencies.execShellCommand(`gh pr view ${shellDependencies.escapeShellArg(prNumber)} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir,
    }).trim();
  } catch { /* best-effort */ }

  const diffResult = shellDependencies.fetchPrDiff(prNumber, repoDir);
  if (diffResult.kind === 'diff') {
    return {
      diff: diffResult.text,
      url,
      availability: {
        available: true,
        source: diffResult.source,
        bytes: diffResult.bytes,
        attempts: diffResult.attempts,
      },
    };
  }

  return {
    diff: '',
    url,
    availability: {
      available: false,
      reason: diffResult.reason,
      detail: diffResult.detail,
      attempts: diffResult.attempts,
    },
  };
}

/**
 * Compute wall-clock time in seconds for a task branch.
 *
 * Uses commit timestamps from the branch's history relative to the base branch.
 * Returns null when duration cannot be determined reliably, including branches
 * with fewer than two commits or when git history cannot be read.
 *
 * @param repoDir - Repository directory
 * @param branch - Branch to inspect
 * @param baseBranch - Base branch used to define branch-local commits
 * @returns Duration in seconds, or null when indeterminate
 */
export function computeWallClockSeconds(
  repoDir: string,
  branch: string,
  baseBranch = 'main',
): number | null {
  try {
    const raw = shellDependencies.execShellCommand(
      `git log ${shellDependencies.escapeShellArg(baseBranch)}..${shellDependencies.escapeShellArg(branch)} --format="%ct" --reverse`,
      { encoding: 'utf-8', cwd: repoDir }
    ).trim();

    if (!raw) {
      return null;
    }

    const timestamps = raw
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (timestamps.length < 2) {
      return null;
    }

    const firstTimestamp = timestamps[0];
    const lastTimestamp = timestamps[timestamps.length - 1];

    return Math.max(0, lastTimestamp - firstTimestamp);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Gather all context needed for evaluation in a single call.
 *
 * Fetches issue data from Linear and PR data from GitHub.
 * Non-blocking: failures result in degraded data (empty strings, null values).
 *
 * @param params - Context gathering parameters
 * @returns Complete eval context
 */
export function gatherEvalContext(params: GatherContextParams): EvalContext {
  const { issueId, prNumber, prUrl, repoDir } = params;

  // Fetch issue data
  let issueData: any | null = null;
  if (issueId) {
    issueData = fetchIssueData(issueId, repoDir);
  }
  const taskPrompt = formatIssueAsPrompt(issueData, issueId || '');

  // Fetch PR data
  let prDiff = '';
  let finalPrUrl = prUrl || '';
  let prDiffAvailability: PrDiffAvailability = {
    available: false,
    reason: 'pr_metadata_missing',
    detail: 'no PR number',
    attempts: [],
  };
  if (prNumber) {
    const prCtx = fetchPrContext(prNumber, repoDir);
    prDiff = prCtx.diff;
    if (!finalPrUrl) finalPrUrl = prCtx.url;
    prDiffAvailability = prCtx.availability;
  }

  return {
    taskPrompt,
    prDiff,
    prUrl: finalPrUrl,
    prDiffAvailability,
    issueData,
  };
}

// ────────────────────────────────────────────────────────────────
// Auto-Detection
// ────────────────────────────────────────────────────────────────

/**
 * Auto-detect context from workflow state or current branch.
 *
 * Falls back in this order:
 * 1. .wavemill/workflow-state.json (most recent task with PR)
 * 2. Current branch's open PR (via gh CLI)
 *
 * @param repoDir - Repository directory
 * @returns Detected context (issueId, prNumber, branch, prUrl)
 */
/**
 * Fill in context an explicit invocation did not supply.
 *
 * `autoDetectContext` is skipped entirely when a caller passes an issue or PR,
 * which used to leave `branch`, `prUrl`, `worktree` and `challengePairId`
 * empty — so `--issue X --pr N` produced a *worse* record than auto-detection,
 * missing the PR link and challenge identity that eligibility depends on.
 *
 * Everything here is best-effort: unresolved fields come back empty.
 */
export function resolveContextGaps(input: {
  repoDir: string;
  issueId?: string;
  prNumber?: string;
}): { branch: string; prUrl: string; worktree: string; challengePairId: string; slug: string } {
  const out = { branch: '', prUrl: '', worktree: '', challengePairId: '', slug: '' };

  // Probe both layouts, as challenge-execution-contract.ts does — a relocated
  // STATE_DIR otherwise makes every lookup here miss.
  const stateFiles = [
    path.join(input.repoDir, '.wavemill', 'workflow-state.json'),
    path.join(input.repoDir, '.wavemill', 'state', 'workflow-state.json'),
  ];
  for (const stateFile of input.issueId ? stateFiles : []) {
    if (!existsSync(stateFile)) continue;
    try {
      const task = (JSON.parse(readFileSync(stateFile, 'utf-8')).tasks || {})[input.issueId];
      if (!task) continue;
      out.branch = task.branch || '';
      out.worktree = task.worktree || '';
      out.challengePairId = task.challengePairId || '';
      out.slug = task.slug || '';
      break;
    } catch {
      // Best-effort
    }
  }

  if (input.prNumber && (!out.prUrl || !out.branch)) {
    try {
      const prJson = shellDependencies.execShellCommand(
        `gh pr view ${shellDependencies.escapeShellArg(input.prNumber)} --json url,headRefName 2>/dev/null || echo "{}"`,
        { encoding: 'utf-8', cwd: input.repoDir }
      ).trim();
      const prData = JSON.parse(prJson);
      if (prData.url) out.prUrl = prData.url;
      if (!out.branch && prData.headRefName) out.branch = prData.headRefName;
    } catch {
      // Best-effort
    }
  }

  return out;
}

export function autoDetectContext(repoDir: string): {
  issueId: string;
  prNumber: string;
  branch: string;
  prUrl: string;
} {
  let issueId = '';
  let prNumber = '';
  let branch = '';
  let prUrl = '';

  // Try workflow state file
  const stateFile = path.join(repoDir, '.wavemill', 'workflow-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const tasks = state.tasks || {};

      // Find most recently updated task that has a PR
      let mostRecent: any = null;
      let mostRecentTime = '';
      for (const [id, task] of Object.entries(tasks)) {
        const t = task as any;
        if (t.pr && (!mostRecentTime || t.updated > mostRecentTime)) {
          mostRecent = { id, ...t };
          mostRecentTime = t.updated;
        }
      }

      if (mostRecent) {
        issueId = mostRecent.id;
        prNumber = String(mostRecent.pr);
        branch = mostRecent.branch || '';
      }
    } catch {
      // Best-effort
    }
  }

  // Try current branch PR
  if (!prNumber) {
    try {
      branch = shellDependencies.execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();

      const prJson = shellDependencies.execShellCommand(
        'gh pr view --json number,url 2>/dev/null || echo "{}"',
        {
          encoding: 'utf-8',
          cwd: repoDir,
        }
      ).trim();

      const prData = JSON.parse(prJson);
      if (prData.number) {
        prNumber = String(prData.number);
        prUrl = prData.url || '';
      }
    } catch {
      // Best-effort
    }
  }

  if (!issueId && !prNumber) {
    throw new Error(
      'No workflow context found. Auto-detection requires either:\n' +
        '  1. .wavemill/workflow-state.json with a completed task\n' +
        '  2. An open PR on the current branch\n\n' +
        'Or provide explicit arguments: --issue HOK-123 --pr 456'
    );
  }

  return { issueId, prNumber, branch, prUrl };
}

// ────────────────────────────────────────────────────────────────
// Routing Decision Loading (HOK-1002)
// ────────────────────────────────────────────────────────────────

/** Raw shape of the .routing-complete file. */
export interface RoutingCompleteData {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
  routingMode?: string;
  provenance?: {
    routerMode?: 'normal' | 'constrained' | 'survival';
    source?: string;
    inputKind?: string;
  };
  route_source?: 'batch' | 'single' | 'cache';
  cache_hit?: boolean;
  packet_hash?: string;
  constraints?: {
    maxCostUsd?: number;
  };
  maxCostUsd?: number | null;
  expectedSuccess?: number;
  expectedCostPlan?: number;
  expectedCostCode?: number;
  expectedCostReview?: number;
  expectedCost?: number;
  confidence?: number;
  reasoning?: string[];
  signals?: {
    taskType?: string;
    complexityScore?: number;
    riskScore?: number;
    taskDifficulty?: string;
  };
}

/**
 * Convert raw routing data to the RoutingDecision schema.
 *
 * Builds candidates from unique models, picks the coder as the chosen model
 * (primary executor), and includes depth/mode in the rationale.
 */
export function convertToRoutingDecision(data: RoutingCompleteData): RoutingDecision {
  // Build unique candidates from all models used
  const modelSet = new Map<string, RoutingCandidate>();
  for (const modelId of [data.planner, data.coder, data.reviewer]) {
    if (modelId && !modelSet.has(modelId)) {
      modelSet.set(modelId, {
        agentType: 'claude',
        modelId,
      });
    }
  }
  const candidates = Array.from(modelSet.values());

  // Chosen is the coder model (primary executor)
  const chosen = candidates.find((c) => c.modelId === data.coder) || candidates[0];

  // Build rationale from depth/mode settings
  const parts: string[] = [];
  if (data.planDepth) parts.push(`planDepth=${data.planDepth}`);
  if (data.codeDepth) parts.push(`codeDepth=${data.codeDepth}`);
  if (data.reviewMode) parts.push(`reviewMode=${data.reviewMode}`);
  const decisionRationale = parts.length > 0
    ? `Routing: planner=${data.planner}, coder=${data.coder}, reviewer=${data.reviewer}; ${parts.join(', ')}`
    : `Routing: planner=${data.planner}, coder=${data.coder}, reviewer=${data.reviewer}`;

  const decisionPolicyVersion = resolveRouterPolicyVersion({
    routingMode: data.routingMode,
    source: data.provenance?.source,
    inputKind: data.provenance?.inputKind,
    routerMode: data.provenance?.routerMode,
  });

  return {
    candidates,
    chosen,
    decisionPolicyVersion,
    decisionRationale,
    ...(data.routingMode ? { routeMode: data.routingMode } : {}),
    routeArtifactSchemaVersion: ROUTE_ARTIFACT_SCHEMA_VERSION,
    policyResolverVersion: POLICY_RESOLVER_VERSION,
    ...(data.provenance?.routerMode
      ? { operatingModeDependency: data.provenance.routerMode }
      : {}),
  };
}

/**
 * Load routing decision from .routing-complete file in the feature directory.
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * Returns null if the file is missing, malformed, or lacks required fields.
 */
export function fetchRoutingDecision(
  repoDir: string,
  slug: string,
  worktreePath?: string
): RoutingDecision | null {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const routingPath = path.join(root, dir, slug, '.routing-complete');
      if (!existsSync(routingPath)) continue;

      try {
        const raw = readFileSync(routingPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Validate required fields
        if (
          typeof data.planner !== 'string' ||
          typeof data.coder !== 'string' ||
          typeof data.reviewer !== 'string' ||
          (
            data.maxCostUsd !== undefined
            && data.maxCostUsd !== null
            && typeof data.maxCostUsd !== 'number'
          )
        ) {
          return null;
        }

        return convertToRoutingDecision(data as unknown as RoutingCompleteData);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function parseRoutingCompleteData(raw: string): RoutingCompleteData | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof data.planner !== 'string' ||
      typeof data.coder !== 'string' ||
      typeof data.reviewer !== 'string' ||
      (
        data.maxCostUsd !== undefined
        && data.maxCostUsd !== null
        && typeof data.maxCostUsd !== 'number'
      )
    ) {
      return null;
    }
    return data as RoutingCompleteData;
  } catch {
    return null;
  }
}

/**
 * Fetch raw routing decision data from .routing-complete file.
 *
 * Unlike fetchRoutingDecision, this returns the raw data structure
 * without converting to RoutingDecision schema. Used by task descriptor
 * builder to extract per-stage model assignments.
 *
 * @param repoDir - Repository root directory
 * @param slug - Feature slug (e.g., "my-feature")
 * @param worktreePath - Optional worktree path to search first
 * @returns Raw routing data or null if not found
 */
export function fetchRoutingCompleteRaw(
  repoDir: string,
  slug: string,
  worktreePath?: string,
): RoutingCompleteData | null {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter(
    (p): p is string => Boolean(p),
  );

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const routingPath = path.join(root, dir, slug, '.routing-complete');
      if (!existsSync(routingPath)) continue;

      try {
        return parseRoutingCompleteData(readFileSync(routingPath, 'utf-8'));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function loadRoutingCompleteRawFromArchive(
  repoDir: string,
  issueId: string,
): RoutingCompleteData | null {
  const content = loadFromArchive(repoDir, issueId, 'routing-complete.json');
  if (!content) {
    return null;
  }
  return parseRoutingCompleteData(content);
}

function loadResolvedModelRouting(
  repoDir: string,
  issueId: string,
  slug?: string,
  worktreePath?: string,
): EvalRouting | undefined {
  const candidates: string[] = [];
  if (slug) {
    if (worktreePath) {
      candidates.push(path.join(worktreePath, 'features', slug, 'routing.jsonl'));
      candidates.push(path.join(worktreePath, 'bugs', slug, 'routing.jsonl'));
    }
    candidates.push(path.join(repoDir, 'features', slug, 'routing.jsonl'));
    candidates.push(path.join(repoDir, 'bugs', slug, 'routing.jsonl'));
  }
  candidates.push(path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, 'routing.jsonl'));

  let content: string | undefined;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      content = readFileSync(candidate, 'utf-8');
      break;
    } catch {
      continue;
    }
  }
  if (!content) return undefined;

  const latestByRole: EvalRouting = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        (parsed.role === 'planner' || parsed.role === 'coder' || parsed.role === 'reviewer')
        && parsed.requestedSelector
        && typeof parsed.resolvedModelId === 'string'
        && typeof parsed.sourceLayer === 'string'
      ) {
        latestByRole[parsed.role] = parsed as EvalRouting['planner'];
      }
    } catch {
      console.warn(`Skipping malformed routing.jsonl line for ${issueId}`);
    }
  }
  return Object.keys(latestByRole).length > 0 ? latestByRole : undefined;
}

export function fetchRoutingCompleteRawWithArchive(
  repoDir: string,
  slug: string,
  issueId: string,
  worktreePath?: string,
): RoutingCompleteData | null {
  return fetchRoutingCompleteRaw(repoDir, slug, worktreePath)
    ?? loadRoutingCompleteRawFromArchive(repoDir, issueId);
}

// ────────────────────────────────────────────────────────────────
// Stage Artifacts (HOK-1004)
// ────────────────────────────────────────────────────────────────

/**
 * Derive feature slug from branch name or issue ID.
 *
 * @param branch - Git branch name (e.g., "task/my-feature")
 * @param issueId - Linear issue ID (e.g., "HOK-1004")
 * @param repoDir - Repository directory
 * @returns Feature slug or undefined
 */
function deriveFeatureSlug(
  branch: string,
  issueId: string,
  repoDir: string
): string | undefined {
  // Try branch name first (strip task/ or bug/ prefix)
  if (branch) {
    const slug = branch.replace(/^(task|bug)\//, '');
    if (slug && slug !== branch) {
      return slug;
    }
  }

  // Scan features/*/selected-task.json for matching issueId
  if (issueId) {
    try {
      const featuresDirs = ['features', 'bugs'];
      for (const dir of featuresDirs) {
        const dirPath = path.join(repoDir, dir);
        if (!existsSync(dirPath)) continue;

        const subdirs = readdirSync(dirPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const subdir of subdirs) {
          const taskFile = path.join(dirPath, subdir, 'selected-task.json');
          if (existsSync(taskFile)) {
            try {
              const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
              if (task.taskId === issueId || task.id === issueId) {
                return subdir;
              }
            } catch {
              // Skip malformed files
            }
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  return undefined;
}

/**
 * Find and load task packet content.
 *
 * Looks for:
 * 1. features/<slug>/task-packet.md (full format)
 * 2. features/<slug>/task-packet-header.md + task-packet-details.md (split format)
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @param worktreePath - Optional worktree path to search first
 * @returns Task packet content or undefined
 */
function loadTaskPacket(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const featureDir = path.join(root, dir, slug);
      if (!existsSync(featureDir)) continue;

      // Try full format first
      const fullPath = path.join(featureDir, 'task-packet.md');
      if (existsSync(fullPath)) {
        try {
          return readFileSync(fullPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }

      // Try split format (header + details)
      const headerPath = path.join(featureDir, 'task-packet-header.md');
      const detailsPath = path.join(featureDir, 'task-packet-details.md');
      if (existsSync(headerPath) && existsSync(detailsPath)) {
        try {
          const header = readFileSync(headerPath, 'utf-8');
          const details = readFileSync(detailsPath, 'utf-8');
          return `${header}\n\n---\n\n${details}`;
        } catch {
          // Continue to next option
        }
      }

      // Try just header (if details missing)
      if (existsSync(headerPath)) {
        try {
          return readFileSync(headerPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }
    }
  }

  return undefined;
}

/**
 * Find and load plan content.
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @param worktreePath - Optional worktree path to search first
 * @returns Plan content or undefined
 */
function loadPlan(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const planPath = path.join(root, dir, slug, 'plan.md');
      if (existsSync(planPath)) {
        try {
          return readFileSync(planPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }
    }
  }

  return undefined;
}

/**
 * Format self-review summary from review metrics.
 *
 * Loads metrics from worktree first (if provided), then repoDir, merging results.
 *
 * @param repoDir - Repository directory
 * @param branch - Git branch name
 * @param worktreePath - Optional worktree path to search first
 * @returns Formatted summary or undefined
 */
function loadSelfReviewSummary(
  repoDir: string,
  branch: string,
  worktreePath?: string
): string | undefined {
  try {
    // Load metrics from both worktree and repoDir, then merge
    const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));
    const allMetrics: any[] = [];
    const seenIds = new Set<string>();

    for (const root of searchRoots) {
      try {
        const metrics = loadMetrics(root);
        if (metrics && metrics.length > 0) {
          // Deduplicate by metric ID
          for (const metric of metrics) {
            const metricId = `${metric.branch}-${metric.timestamp}`;
            if (!seenIds.has(metricId)) {
              seenIds.add(metricId);
              allMetrics.push(metric);
            }
          }
        }
      } catch {
        // Continue to next root
      }
    }

    if (allMetrics.length === 0) return undefined;

    // Find the most recent review metric for this branch
    const relevantMetrics = allMetrics.filter((m) => m.branch === branch);
    if (relevantMetrics.length === 0) return undefined;

    // Sort by timestamp descending
    relevantMetrics.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const metric = relevantMetrics[0];

    // Build compact summary
    const lines = [
      `Self-Review Summary (${metric.outcome})`,
      `- Iterations: ${metric.totalIterations}`,
    ];

    for (const iteration of metric.iterations) {
      const { iterationNumber, verdict, findingsSummary } = iteration;
      const blockers = findingsSummary.blockers;
      const warnings = findingsSummary.warnings;
      lines.push(
        `  - Iteration ${iterationNumber}: ${verdict} (${blockers} blockers, ${warnings} warnings)`
      );
    }

    return lines.join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Gather stage artifacts for eval judge attribution.
 *
 * Best-effort collection of:
 * - Task packet (expanded issue specification)
 * - Implementation plan
 * - Self-review summary
 *
 * All failures result in undefined (judge will skip that stage).
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param issueId - Linear issue ID
 * @param branch - Git branch name
 * @param worktreePath - Optional worktree path to search first
 * @returns Object with optional stage artifacts
 */
/**
 * Load an artifact from the eval archive directory.
 *
 * Archive artifacts are created by wavemill-mill.sh's archive_stage_artifacts()
 * before worktree cleanup, so they persist even after the worktree is removed.
 *
 * @param repoDir - Repository directory
 * @param issueId - Linear issue ID
 * @param filename - Artifact filename (e.g., 'plan.md', 'task-packet.md')
 * @returns File content or undefined
 */
function loadFromArchive(repoDir: string, issueId: string, filename: string): string | undefined {
  const archivePath = path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, filename);
  if (existsSync(archivePath)) {
    try {
      return readFileSync(archivePath, 'utf-8');
    } catch {
      // Continue
    }
  }
  return undefined;
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function readPhaseDurationSeconds(resultPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
    const startedAt = parseIsoTimestamp(parsed.startedAt);
    const finishedAt = parseIsoTimestamp(parsed.finishedAt);

    if (startedAt === null || finishedAt === null || finishedAt < startedAt) {
      return undefined;
    }

    return Math.max(0, (finishedAt - startedAt) / 1000);
  } catch {
    return undefined;
  }
}

export function computePhaseDurations(
  repoDir: string,
  slug: string,
  worktreePath?: string,
): EvalPhaseDurations | undefined {
  const searchRoots = [worktreePath, repoDir].filter((root): root is string => Boolean(root));
  const phaseFiles: Array<{ phase: Exclude<keyof EvalPhaseDurations, 'total'>; file: string }> = [
    { phase: 'planning', file: '.planning-result.json' },
    { phase: 'coding', file: '.coding-result.json' },
    { phase: 'review', file: '.review-result.json' },
  ];

  const durations: EvalPhaseDurations = {};

  for (const { phase, file } of phaseFiles) {
    let duration: number | undefined;

    for (const root of searchRoots) {
      for (const dir of ['features', 'bugs']) {
        const resultPath = path.join(root, dir, slug, file);
        if (!existsSync(resultPath)) {
          continue;
        }

        duration = readPhaseDurationSeconds(resultPath);
        break;
      }

      if (duration !== undefined) {
        break;
      }
    }

    if (duration !== undefined) {
      durations[phase] = duration;
    }
  }

  const total = [durations.planning, durations.coding, durations.review]
    .filter((value): value is number => typeof value === 'number')
    .reduce((sum, value) => sum + value, 0);

  if (Object.keys(durations).length === 0) {
    return undefined;
  }

  durations.total = total;
  return durations;
}

/**
 * Locate the directory holding `.{stage}-result.json` files for a task
 * (HOK-2958). Returns the first candidate (worktree first, then repo;
 * features before bugs) containing at least one stage result file, so
 * downstream consumers can read windows via the stage-result readers
 * instead of re-deriving paths.
 */
function findStageResultsDir(
  repoDir: string,
  slug: string,
  worktreePath?: string,
): string | undefined {
  const searchRoots = [worktreePath, repoDir].filter((root): root is string => Boolean(root));
  for (const root of searchRoots) {
    for (const dir of ['features', 'bugs']) {
      const candidate = path.join(root, dir, slug);
      const hasStageResult = ['planning', 'coding', 'review'].some((stage) =>
        existsSync(path.join(candidate, `.${stage}-result.json`)));
      if (hasStageResult) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function gatherStageArtifacts(
  repoDir: string,
  issueId: string,
  branch: string,
  worktreePath?: string
): {
  taskPacket?: string;
  planContent?: string;
  selfReviewSummary?: string;
  routingDecision?: RoutingDecision;
  routing?: EvalRouting;
  routePrediction?: RoutePrediction;
  executedPlanning?: EvalExecutedPlanning;
  planningExecutionOutcome?: PlanningExecutionOutcome;
  phaseDurations?: EvalPhaseDurations;
  executionModel?: string;
  /** Directory containing `.{stage}-result.json` files, when found (HOK-2958). */
  stageResultsDir?: string;
} {
  // Derive feature slug
  const slug = deriveFeatureSlug(branch, issueId, repoDir);
  if (!slug) {
    // Even without a slug, try the archive dir (keyed by issueId)
    return {
      taskPacket: loadFromArchive(repoDir, issueId, 'task-packet.md'),
      planContent: loadFromArchive(repoDir, issueId, 'plan.md'),
      selfReviewSummary: undefined,
      routingDecision: undefined,
      routing: loadResolvedModelRouting(repoDir, issueId),
      routePrediction: buildRoutePrediction(loadRoutingCompleteRawFromArchive(repoDir, issueId) ?? undefined),
      executedPlanning: undefined,
      planningExecutionOutcome: loadPlanningExecutionOutcomeFromArchive(repoDir, issueId),
      phaseDurations: undefined,
      executionModel: undefined,
      stageResultsDir: undefined,
    };
  }

  // Gather artifacts (search worktree first, then fall back to repoDir)
  const taskPacket = loadTaskPacket(repoDir, slug, worktreePath)
    ?? loadFromArchive(repoDir, issueId, 'task-packet.md');
  const planContent = loadPlan(repoDir, slug, worktreePath)
    ?? loadFromArchive(repoDir, issueId, 'plan.md');
  const selfReviewSummary = loadSelfReviewSummary(repoDir, branch, worktreePath);
  const routingCompleteRaw = fetchRoutingCompleteRaw(repoDir, slug, worktreePath)
    ?? loadRoutingCompleteRawFromArchive(repoDir, issueId)
    ?? undefined;
  const routingDecision = routingCompleteRaw
    ? convertToRoutingDecision(routingCompleteRaw)
    : undefined;
  const routing = loadResolvedModelRouting(repoDir, issueId, slug, worktreePath);

  return {
    taskPacket,
    planContent,
    selfReviewSummary,
    routingDecision,
    routing,
    routePrediction: buildRoutePrediction(routingCompleteRaw),
    executedPlanning: loadExecutedPlanning(repoDir, slug, issueId, worktreePath),
    planningExecutionOutcome: loadPlanningExecutionOutcome(repoDir, slug, issueId, worktreePath),
    phaseDurations: computePhaseDurations(repoDir, slug, worktreePath),
    executionModel: loadStageExecutionModel(repoDir, slug, worktreePath),
    stageResultsDir: findStageResultsDir(repoDir, slug, worktreePath),
  };
}

const PLANNING_STATUSES = new Set(['running', 'awaiting_user', 'completed', 'aborted', 'failed']);
const PLANNING_TERMINAL_REASONS = new Set([
  'turn_limit',
  'tool_call_limit',
  'wall_clock_limit',
  'tool_stagnation',
  'invalid_final_plan',
  'empty_final_plan',
  'aborted',
  'error',
]);

function isNonEmptyPlanningString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegativePlanningNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parsePlanningExecutionOutcome(parsed: Record<string, unknown>): PlanningExecutionOutcome | undefined {
  const artifacts = parsed.artifacts && typeof parsed.artifacts === 'object'
    ? parsed.artifacts as Record<string, unknown>
    : {};
  const boundsInput = artifacts.bounds && typeof artifacts.bounds === 'object'
    ? artifacts.bounds as Record<string, unknown>
    : {};
  const usageInput = artifacts.usage && typeof artifacts.usage === 'object'
    ? artifacts.usage as Record<string, unknown>
    : {};
  const promptRefInput = artifacts.promptRef && typeof artifacts.promptRef === 'object'
    ? artifacts.promptRef as Record<string, unknown>
    : undefined;

  const bounds = {
    ...(isFiniteNonNegativePlanningNumber(boundsInput.maxTurns) ? { maxTurns: boundsInput.maxTurns } : {}),
    ...(isFiniteNonNegativePlanningNumber(boundsInput.maxToolCalls) ? { maxToolCalls: boundsInput.maxToolCalls } : {}),
    ...(isFiniteNonNegativePlanningNumber(boundsInput.maxWallClockMs) ? { maxWallClockMs: boundsInput.maxWallClockMs } : {}),
  };
  const usage = {
    ...(isFiniteNonNegativePlanningNumber(usageInput.turnsCompleted) ? { turnsCompleted: usageInput.turnsCompleted } : {}),
    ...(isFiniteNonNegativePlanningNumber(usageInput.toolCallsExecuted) ? { toolCallsExecuted: usageInput.toolCallsExecuted } : {}),
    ...(isFiniteNonNegativePlanningNumber(usageInput.wallClockMs) ? { wallClockMs: usageInput.wallClockMs } : {}),
    ...(isFiniteNonNegativePlanningNumber(usageInput.totalInputTokens) ? { totalInputTokens: usageInput.totalInputTokens } : {}),
    ...(isFiniteNonNegativePlanningNumber(usageInput.totalOutputTokens) ? { totalOutputTokens: usageInput.totalOutputTokens } : {}),
    ...(isFiniteNonNegativePlanningNumber(usageInput.totalCostUsd) ? { totalCostUsd: usageInput.totalCostUsd } : {}),
  };
  const promptRef = promptRefInput
    && isNonEmptyPlanningString(promptRefInput.id)
    && isNonEmptyPlanningString(promptRefInput.version)
    ? { id: promptRefInput.id, version: promptRefInput.version }
    : undefined;
  const agent = isNonEmptyPlanningString(parsed.agent) ? parsed.agent : undefined;
  const model = isNonEmptyPlanningString(parsed.model) ? parsed.model : undefined;
  const status = PLANNING_STATUSES.has(String(parsed.status)) ? parsed.status as PlanningExecutionOutcome['status'] : undefined;
  const failureReason = parsed.failureReason === null
    ? null
    : PLANNING_TERMINAL_REASONS.has(String(parsed.failureReason))
      ? parsed.failureReason as PlanningExecutionOutcome['failureReason']
      : undefined;

  const outcome: PlanningExecutionOutcome = {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(typeof artifacts.planArtifactValid === 'boolean' ? { planArtifactValid: artifacts.planArtifactValid } : {}),
    ...(typeof artifacts.approvalReady === 'boolean' ? { approvalReady: artifacts.approvalReady } : {}),
    ...(Object.keys(bounds).length > 0 ? { bounds } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(promptRef ? { promptRef } : {}),
    source: '.planning-result.json',
  };

  return Object.keys(outcome).length > 1 ? outcome : undefined;
}

function parsePlanningExecutionOutcomeText(content: string): PlanningExecutionOutcome | undefined {
  try {
    return parsePlanningExecutionOutcome(JSON.parse(content) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function loadPlanningExecutionOutcomeFromArchive(
  repoDir: string,
  issueId: string,
): PlanningExecutionOutcome | undefined {
  const archivedPlanning = loadFromArchive(repoDir, issueId, 'planning-result.json');
  return archivedPlanning ? parsePlanningExecutionOutcomeText(archivedPlanning) : undefined;
}

function loadPlanningExecutionOutcome(
  repoDir: string,
  slug: string,
  issueId: string,
  worktreePath?: string,
): PlanningExecutionOutcome | undefined {
  const resultPaths = ['features', 'bugs'].flatMap((dir) => {
    const paths: string[] = [];
    if (worktreePath) {
      paths.push(path.join(worktreePath, dir, slug, '.planning-result.json'));
    }
    paths.push(path.join(repoDir, dir, slug, '.planning-result.json'));
    return paths;
  });

  for (const resultPath of resultPaths) {
    if (!existsSync(resultPath)) {
      continue;
    }
    const outcome = parsePlanningExecutionOutcomeText(readFileSync(resultPath, 'utf-8'));
    if (outcome) {
      return outcome;
    }
  }

  return loadPlanningExecutionOutcomeFromArchive(repoDir, issueId);
}

function loadExecutedPlanning(
  repoDir: string,
  slug: string,
  issueId: string,
  worktreePath?: string,
): EvalExecutedPlanning | undefined {
  const resultPaths = ['features', 'bugs'].flatMap((dir) => {
    const paths: string[] = [];
    if (worktreePath) {
      paths.push(path.join(worktreePath, dir, slug, '.planning-result.json'));
    }
    paths.push(path.join(repoDir, dir, slug, '.planning-result.json'));
    return paths;
  });

  for (const resultPath of resultPaths) {
    if (!existsSync(resultPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
      const model = typeof parsed.model === 'string' && parsed.model.trim().length > 0
        ? parsed.model
        : undefined;
      const agent = typeof parsed.agent === 'string' && parsed.agent.trim().length > 0
        ? parsed.agent
        : undefined;
      const status = (
        parsed.status === 'running'
        || parsed.status === 'awaiting_user'
        || parsed.status === 'completed'
        || parsed.status === 'aborted'
        || parsed.status === 'failed'
      )
        ? parsed.status
        : undefined;

      if (!agent && !model && !status) {
        return undefined;
      }

      return {
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(status ? { status } : {}),
        source: '.planning-result.json',
      };
    } catch {
      continue;
    }
  }

  const archivedPlanning = loadFromArchive(repoDir, issueId, 'planning-result.json');
  if (!archivedPlanning) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(archivedPlanning) as Record<string, unknown>;
    const model = typeof parsed.model === 'string' && parsed.model.trim().length > 0
      ? parsed.model
      : undefined;
    const agent = typeof parsed.agent === 'string' && parsed.agent.trim().length > 0
      ? parsed.agent
      : undefined;
    const status = (
      parsed.status === 'running'
      || parsed.status === 'awaiting_user'
      || parsed.status === 'completed'
      || parsed.status === 'aborted'
      || parsed.status === 'failed'
    )
      ? parsed.status
      : undefined;

    if (!agent && !model && !status) {
      return undefined;
    }

    return {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(status ? { status } : {}),
      source: '.planning-result.json',
    };
  } catch {
    return undefined;
  }
}

function loadStageExecutionModel(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const resultPaths = ['coding', 'review', 'planning'].flatMap((stage) => {
    const paths: string[] = [];
    if (worktreePath) {
      paths.push(path.join(worktreePath, 'features', slug, `.${stage}-result.json`));
    }
    paths.push(path.join(repoDir, 'features', slug, `.${stage}-result.json`));
    paths.push(path.join(repoDir, 'bugs', slug, `.${stage}-result.json`));
    return paths;
  });

  for (const resultPath of resultPaths) {
    if (!existsSync(resultPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
        return parsed.model;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Load routing decision from the archive directory.
 */
function loadRoutingDecisionFromArchive(repoDir: string, issueId: string): RoutingDecision | null {
  const raw = loadRoutingCompleteRawFromArchive(repoDir, issueId);
  return raw ? convertToRoutingDecision(raw) : null;
}
