/**
 * Review Metrics - Track self-review loop outcomes and iterations
 *
 * This module provides lightweight metrics tracking for the self-review loop:
 * - Number of iterations per run
 * - Findings count and severity per iteration
 * - Resolution outcome (resolved, escalated, error)
 *
 * Metrics are stored in .wavemill/review-log.json as JSONL (newline-delimited JSON).
 *
 * @module review-metrics
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import type { ReviewResult, ReviewFinding } from './review-engine.ts';
import { loadWavemillConfig } from './config.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Summary of findings for a single iteration.
 */
export interface FindingsSummary {
  /** Number of blocker-severity findings */
  blockers: number;
  /** Number of warning-severity findings */
  warnings: number;
  /** Total number of findings */
  total: number;
}

/**
 * Record of a single review iteration.
 */
export interface IterationRecord {
  /** Iteration number (1-indexed) */
  iterationNumber: number;
  /** Review verdict for this iteration */
  verdict: 'ready' | 'not_ready';
  /** Timestamp when this iteration completed */
  timestamp: string;
  /** Summary count of findings by severity */
  findingsSummary: FindingsSummary;
  /** Categorized findings (optional, for detailed analysis) */
  findings?: Array<{
    severity: 'blocker' | 'warning';
    category: string;
    location: string;
  }>;
}

/**
 * Complete metric record for a review run.
 */
export interface ReviewMetric {
  /** Unique identifier (timestamp-based) */
  id: string;
  /** ISO timestamp when review started */
  timestamp: string;
  /** Branch being reviewed */
  branch: string;
  /** Target branch (e.g., 'main') */
  targetBranch: string;
  /** Linear issue ID (if available) */
  issueId?: string;
  /** Array of iteration records */
  iterations: IterationRecord[];
  /** Final outcome of the review run */
  outcome: 'resolved' | 'escalated' | 'error';
  /** Total number of iterations performed */
  totalIterations: number;
  /** Optional metadata */
  metadata?: {
    /** PR number if created */
    prNumber?: number;
    /** Agent used (claude, codex, etc.) */
    agent?: string;
    /** Model used for review */
    model?: string;
    /** Error message if outcome is 'error' */
    error?: string;
  };
}

// ────────────────────────────────────────────────────────────────
// Core Functions
// ────────────────────────────────────────────────────────────────

/**
 * Initialize a new review metric record.
 *
 * @param branch - Branch being reviewed
 * @param targetBranch - Target branch to compare against
 * @param issueId - Optional Linear issue ID
 * @returns New metric record with empty iterations array
 */
export function initReviewMetric(
  branch: string,
  targetBranch: string,
  issueId?: string
): ReviewMetric {
  const timestamp = new Date().toISOString();
  const id = `review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    id,
    timestamp,
    branch,
    targetBranch,
    issueId,
    iterations: [],
    outcome: 'resolved', // Default, will be updated
    totalIterations: 0,
  };
}

/**
 * Create a findings summary from a ReviewResult.
 *
 * @param findings - Array of review findings
 * @returns Summary with counts by severity
 */
function summarizeFindings(findings: ReviewFinding[]): FindingsSummary {
  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    blockers,
    warnings,
    total: findings.length,
  };
}

/**
 * Add an iteration record to a metric.
 *
 * @param metric - Metric to update (modified in place)
 * @param iterationNumber - Iteration number (1-indexed)
 * @param result - Review result from this iteration
 */
export function addIteration(
  metric: ReviewMetric,
  iterationNumber: number,
  result: ReviewResult
): void {
  const timestamp = new Date().toISOString();

  // Combine code and UI findings
  const allFindings = [
    ...(result.codeReviewFindings || []),
    ...(result.uiFindings || []),
  ];

  const findingsSummary = summarizeFindings(allFindings);

  // Store simplified findings for aggregate analysis
  const findings = allFindings.map((f) => ({
    severity: f.severity,
    category: f.category,
    location: f.location,
  }));

  const iteration: IterationRecord = {
    iterationNumber,
    verdict: result.verdict,
    timestamp,
    findingsSummary,
    findings,
  };

  metric.iterations.push(iteration);
  metric.totalIterations = metric.iterations.length;
}

/**
 * Finalize a metric with the final outcome.
 *
 * @param metric - Metric to finalize (modified in place)
 * @param outcome - Final outcome
 * @param metadata - Optional metadata to attach
 */
export function finalizeMetric(
  metric: ReviewMetric,
  outcome: 'resolved' | 'escalated' | 'error',
  metadata?: ReviewMetric['metadata']
): void {
  metric.outcome = outcome;
  if (metadata) {
    metric.metadata = { ...metric.metadata, ...metadata };
  }
}

/**
 * Get the review metrics log path from config.
 *
 * @param repoDir - Repository directory
 * @returns Absolute path to review log file
 */
function getReviewLogPath(repoDir: string): string {
  const config = loadWavemillConfig(repoDir);
  const logPath = config.review?.metricsLog || '.wavemill/review-log.json';

  // Resolve relative paths against repo root
  return resolve(repoDir, logPath);
}

/**
 * Ensure the metrics directory exists and is writable.
 *
 * This is a defensive check that prevents metrics failures from crashing the review tool.
 * Returns false if directory cannot be created or is not writable.
 *
 * @param repoDir - Repository directory
 * @param verbose - Log diagnostic information
 * @returns true if directory is ready, false if setup failed
 */
function ensureMetricsDirectory(repoDir: string, verbose: boolean = false): boolean {
  try {
    const logPath = getReviewLogPath(repoDir);
    const logDir = dirname(logPath);

    // Try to create directory if it doesn't exist
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Verify directory is writable by attempting to write a test file
    const testFile = join(logDir, '.write-test');
    try {
      writeFileSync(testFile, '', 'utf-8');
      const { unlinkSync } = require('node:fs');
      unlinkSync(testFile);
    } catch (writeError) {
      if (verbose) {
        console.error(`Warning: Metrics directory is not writable: ${logDir}`);
        console.error(`  Error: ${(writeError as Error).message}`);
      }
      return false;
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error(`Warning: Failed to set up metrics directory`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return false;
  }
}

/**
 * Save a metric record to the review log file.
 *
 * Appends the metric as a single JSON line to the JSONL file.
 * This function is designed to be non-intrusive - failures are logged but don't throw.
 *
 * @param metric - Metric to save
 * @param repoDir - Repository directory (default: cwd)
 * @param verbose - Log diagnostic information
 * @returns true if save succeeded, false if it failed
 */
export function saveMetric(
  metric: ReviewMetric,
  repoDir: string = process.cwd(),
  verbose: boolean = false
): boolean {
  try {
    // Early check: ensure directory is ready
    if (!ensureMetricsDirectory(repoDir, verbose)) {
      if (verbose) {
        console.error('Warning: Skipping metrics save - directory not available');
      }
      return false;
    }

    const logPath = getReviewLogPath(repoDir);

    // Append as single JSON line
    const line = JSON.stringify(metric) + '\n';
    appendFileSync(logPath, line, 'utf-8');

    return true;
  } catch (error) {
    // Metrics failures should not crash the review tool
    if (verbose) {
      console.error(`Warning: Failed to save review metric`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return false;
  }
}

/**
 * Load all metrics from the review log file.
 *
 * This function is defensive - it returns an empty array if the file cannot be read.
 *
 * @param repoDir - Repository directory (default: cwd)
 * @param verbose - Log diagnostic information
 * @returns Array of review metrics, or empty array if loading failed
 */
export function loadMetrics(
  repoDir: string = process.cwd(),
  verbose: boolean = false
): ReviewMetric[] {
  try {
    const logPath = getReviewLogPath(repoDir);

    if (!existsSync(logPath)) {
      return [];
    }

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    const metrics: ReviewMetric[] = [];
    for (const line of lines) {
      try {
        const metric = JSON.parse(line) as ReviewMetric;
        metrics.push(metric);
      } catch (err) {
        // Skip malformed lines
        if (verbose) {
          console.warn(`Warning: Skipping malformed review metric line: ${line.slice(0, 50)}...`);
        }
      }
    }

    return metrics;
  } catch (error) {
    // Return empty array on any error - metrics loading should not crash the tool
    if (verbose) {
      console.error(`Warning: Failed to load review metrics`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return [];
  }
}

/**
 * Find issue ID from feature directory context.
 *
 * Looks for selected-task.json in feature directories.
 * This function is defensive - it returns undefined on any error.
 *
 * @param repoDir - Repository directory
 * @param verbose - Log diagnostic information
 * @returns Issue ID or undefined
 */
export function findIssueIdFromContext(
  repoDir: string,
  verbose: boolean = false
): string | undefined {
  try {
    // Check common feature directory patterns
    const patterns = [
      'features/*/selected-task.json',
      'bugs/*/selected-task.json',
    ];

    for (const pattern of patterns) {
      try {
        const { execSync } = require('node:child_process');
        const files = execSync(
          `find "${repoDir}" -path "*/${pattern}" -type f 2>/dev/null | head -1`,
          { encoding: 'utf-8', maxBuffer: 1024 * 1024 } // 1MB buffer
        ).trim();

        if (files) {
          const contextFile = files.split('\n')[0];
          const content = readFileSync(contextFile, 'utf-8');
          const context = JSON.parse(content);
          return context.taskId;
        }
      } catch (patternError) {
        // Continue to next pattern
        if (verbose) {
          console.error(`Info: Could not find issue context with pattern ${pattern}`);
        }
      }
    }
  } catch (error) {
    // No issue context available - this is not an error condition
    if (verbose) {
      console.error(`Info: No issue context found in repository`);
    }
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Review Run State Management
// ────────────────────────────────────────────────────────────────

/**
 * State file for tracking ongoing review runs across multiple iterations.
 */
interface ReviewRunState {
  /** ID of the current metric being built */
  metricId: string;
  /** In-progress metric */
  metric: ReviewMetric;
  /** Timestamp when state was created */
  createdAt: string;
}

/**
 * Get path to review run state file.
 */
function getStateFilePath(repoDir: string): string {
  return join(repoDir, '.wavemill', '.review-run-state.json');
}

/**
 * Load ongoing review run state if it exists and is recent.
 *
 * State is considered stale after 1 hour.
 * This function is defensive - it returns undefined on any error.
 *
 * @param repoDir - Repository directory
 * @param verbose - Log diagnostic information
 * @returns State or undefined
 */
export function loadReviewRunState(
  repoDir: string,
  verbose: boolean = false
): ReviewRunState | undefined {
  try {
    const statePath = getStateFilePath(repoDir);

    if (!existsSync(statePath)) {
      return undefined;
    }

    const content = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(content) as ReviewRunState;

    // Check if state is stale (> 1 hour old)
    const createdAt = new Date(state.createdAt);
    const now = new Date();
    const hoursSinceCreated = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceCreated > 1) {
      // Stale state, discard it
      if (verbose) {
        console.error(`Info: Discarding stale review run state (${hoursSinceCreated.toFixed(1)} hours old)`);
      }
      return undefined;
    }

    return state;
  } catch (error) {
    // Return undefined on any error - state loading should not crash the tool
    if (verbose) {
      console.error(`Warning: Failed to load review run state`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Save review run state to disk.
 *
 * This function is designed to be non-intrusive - failures are logged but don't throw.
 *
 * @param metric - Current metric being built
 * @param repoDir - Repository directory
 * @param verbose - Log diagnostic information
 * @returns true if save succeeded, false if it failed
 */
export function saveReviewRunState(
  metric: ReviewMetric,
  repoDir: string,
  verbose: boolean = false
): boolean {
  try {
    // Early check: ensure directory is ready
    if (!ensureMetricsDirectory(repoDir, verbose)) {
      if (verbose) {
        console.error('Warning: Skipping review run state save - directory not available');
      }
      return false;
    }

    const statePath = getStateFilePath(repoDir);

    const state: ReviewRunState = {
      metricId: metric.id,
      metric,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (error) {
    // State save failures should not crash the review tool
    if (verbose) {
      console.error(`Warning: Failed to save review run state`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return false;
  }
}

/**
 * Clear review run state.
 *
 * This function is defensive - it never throws errors.
 *
 * @param repoDir - Repository directory
 * @param verbose - Log diagnostic information
 * @returns true if cleared, false if it failed (but file may not have existed)
 */
export function clearReviewRunState(repoDir: string, verbose: boolean = false): boolean {
  try {
    const statePath = getStateFilePath(repoDir);

    if (!existsSync(statePath)) {
      return true; // Nothing to clear
    }

    const { unlinkSync } = require('node:fs');
    unlinkSync(statePath);
    return true;
  } catch (error) {
    // Clearing state is not critical - log but don't throw
    if (verbose) {
      console.error(`Warning: Failed to clear review run state`);
      console.error(`  Error: ${(error as Error).message}`);
    }
    return false;
  }
}

/**
 * Mark the current review run as escalated to human.
 *
 * Finalizes the metric with 'escalated' outcome and saves it.
 * Useful when the review loop reaches maxIterations without resolving.
 *
 * @param repoDir - Repository directory
 * @returns true if escalation was marked, false if no active run
 */
export function escalateReviewRun(repoDir: string): boolean {
  const state = loadReviewRunState(repoDir);

  if (!state) {
    return false;
  }

  finalizeMetric(state.metric, 'escalated');
  saveMetric(state.metric, repoDir);
  clearReviewRunState(repoDir);

  return true;
}
