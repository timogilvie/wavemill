/**
 * Ready Stage - Merge Readiness Validation
 *
 * PHASE BOUNDARY:
 * - Review phase: Judges code quality and correctness (does the code do what it should?)
 * - Ready phase: Judges merge-readiness (is it safe to merge RIGHT NOW?)
 *
 * The ready stage runs AFTER PR creation and checks:
 * - CI status (all checks passing?)
 * - PR approvals (required reviewers approved?)
 * - Merge conflicts (clean merge possible?)
 * - Branch freshness (up-to-date with base?)
 *
 * This module provides the contract only. Actual check implementations
 * are in separate HOK-1138 sub-issues.
 */

import { execShellCommand, escapeShellArg } from './shell-utils.ts';
import { extractReleaseReadiness, type ReleaseReadiness } from './task-packet-utils.ts';
import {
  DEFAULT_READY_MIGRATION_PATTERNS,
  getMigrationChecksConfig,
  getReadyConfig,
  loadWavemillConfig,
} from './config.ts';
import {
  classifyDowngradeBody,
  extractOperationCalls,
  getMigrationFunction,
  parseMigrationFile,
  type DowngradeClassification,
} from './migration-ast.ts';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshBaseForMigration } from './ready-migration-base.ts';
import {
  evaluateCiChecks,
  normalizeStatusCheckRollup,
  type PrCiStatus,
} from './pr-ci-status.ts';

/**
 * Status of an individual ready check.
 *
 * - `pass`: Check succeeded
 * - `fail`: Check failed (blocks merge)
 * - `warn`: Check has concerns but doesn't block
 * - `skip`: Check was skipped (not applicable or disabled)
 * - `pending`: Check is still running and should be retried later
 */
export type ReadyCheckStatus = 'pass' | 'fail' | 'warn' | 'skip' | 'pending';

/**
 * Result of an individual ready check.
 *
 * Each check validates one aspect of merge-readiness (CI, approvals, conflicts, etc).
 */
export interface ReadyCheck {
  /** Unique name identifying this check (e.g., "ci-status", "approvals") */
  name: string;

  /** Status of the check */
  status: ReadyCheckStatus;

  /** Human-readable message describing the result */
  message: string;

  /** Optional structured data providing additional context */
  details?: Record<string, unknown>;
}

/**
 * Overall result of the ready stage.
 *
 * Aggregates individual check results into a final merge-readiness verdict.
 */
export interface ReadyResult {
  /** PR number that was checked */
  prNumber: number;

  /** Branch name for the PR */
  branch?: string;

  /**
   * Overall verdict for the PR.
   *
   * - `pass`: All required checks passed, safe to merge
   * - `fail`: One or more required checks failed, blocked
   * - `warn`: All required checks passed but warnings present
   * - `pending`: Blocking checks are still running, retry later
   */
  verdict: 'pass' | 'fail' | 'warn' | 'pending';

  /** Individual check results */
  checks: ReadyCheck[];

  /** ISO 8601 timestamp when checks were run */
  timestamp: string;

  /** Human-readable summary of the overall result */
  summary: string;

  /** GitHub mergeability state, reported separately from readiness verdict */
  mergeConflict?: MergeConflictResult;

  /** Head SHA evaluated for CI, when available from GitHub. */
  headSha?: string;

  /** Live CI conclusion from the shared evaluator. */
  ciConclusion?: string;

  /** GitHub merge-state status observed with CI. */
  mergeStateStatus?: string;

  /**
   * Typed pending reason (HOK-2963), set only for challenge eval/comparison
   * waits on implementation-ready PRs. Additive; absent for CI and other
   * untyped pending verdicts.
   */
  pendingReason?: string;

  /** All typed pending reasons, when any. */
  pendingReasons?: string[];

  /**
   * True when CI, base-branch, metadata, dependency, migration, and risk
   * guards all pass/warn — i.e. only challenge resolution blocks merge.
   */
  implementationReady?: boolean;

  /** Challenge pair diagnostics (pair id, per-side eval evidence, outcome). */
  challenge?: Record<string, unknown>;
}

/**
 * Configuration for the ready stage.
 *
 * This is loaded from `.wavemill-config.json` under the `ready` key.
 */
export interface ReadyStageConfig {
  /**
   * List of check names to run.
   *
   * Empty array means run all available checks.
   * Use to disable specific checks.
   */
  checks?: string[];

  /**
   * Subset of checks that must pass for merge approval.
   *
   * Other checks can warn but won't fail the verdict.
   */
  requiredChecks?: string[];
  requireCiChecks?: boolean;
  migrationKind?: 'alembic' | 'sql' | 'none';

  /**
   * Regex patterns used to identify migration files in the repository.
   */
  migrationPatterns?: string[];

  /**
   * Required PR labels for specific forbidden-DDL findings.
   */
  migrationDangerLabels?: Record<string, string>;

  /**
   * Extra repository-specific forbidden migration patterns.
   */
  migrationForbiddenPatterns?: string[];
}

/**
 * PR context gathered from GitHub CLI.
 */
interface PRContext {
  prNumber: number;
  changedFiles: string[];
  labels: string[];
  branch: string;
  baseBranch: string;
  url: string;
  ciStatus: string;
}

interface ForbiddenDDLFinding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

interface ForbiddenDDLError {
  file: string;
  message: string;
}

interface ForbiddenDDLAnalyzerResult {
  findings: ForbiddenDDLFinding[];
  errors: ForbiddenDDLError[];
}

/**
 * Task packet context.
 */
interface TaskPacketContext {
  fullPath: string;
  content: string;
  releaseReadiness: ReleaseReadiness | null;
}

/**
 * Plan file context.
 */
interface PlanContext {
  path: string;
  content: string;
}

/**
 * Merge conflict state for an open PR.
 *
 * This is reported separately from the overall ready verdict because merge
 * conflicts have a distinct remediation path in the monitor.
 */
export interface MergeConflictResult {
  status: 'CLEAN' | 'CONFLICTED' | 'UNKNOWN' | 'ERROR';
  message: string;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  attempts: number;
  error?: string;
}

export const MAX_TRANSIENT_ATTEMPTS = 3;
export const INITIAL_BACKOFF_MS = 5000;
export const MAX_BACKOFF_MS = 15000;

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export const readyStageDeps = {
  execShellCommand,
  sleep,
  async fetchPrCiStatus(prNumber: number, repoDir: string): Promise<PrCiStatus> {
    try {
      const checksJson = readyStageDeps.execShellCommand(
        `gh pr checks ${escapeShellArg(String(prNumber))} --json state,name 2>/dev/null`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const checks = normalizeStatusCheckRollup(JSON.parse(checksJson.toString()));
      const readyConfig = getReadyConfig(repoDir);
      const evaluation = evaluateCiChecks(checks, readyConfig.requiredChecks ?? [], {
        requireChecks: readyConfig.requireCiChecks,
        requiredSource: readyConfig.requiredChecks && readyConfig.requiredChecks.length > 0 ? 'config' : 'none',
      });
      return {
        ...evaluation,
        checks,
        requiredSource: evaluation.requiredSource ?? 'none',
      };
    } catch (error) {
      return {
        conclusion: 'unknown',
        observed: 0,
        passing: 0,
        failing: [],
        pending: [],
        missingRequired: [],
        requiredContexts: [],
        checks: [],
        requiredSource: 'none',
        readError: {
          errorType: 'unknown',
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
  spawnPython(
    scriptPath: string,
    filePaths: string[],
    repoDir: string
  ): SpawnSyncReturns<string> {
    return spawnSync('python3', [scriptPath, ...filePaths], {
      cwd: repoDir,
      encoding: 'utf-8',
    });
  },
};

interface MigrationRevision {
  file: string;
  revision: string;
  downRevisions: string[];
}

interface MigrationGraphCycle {
  revisions: string[];
  files: string[];
}

interface MigrationHead {
  revision: string;
  file: string;
}

interface MergeTreeMigrationFile {
  file: string;
  content: string;
}

type MergeTreeCollectionResult =
  | { kind: 'ok'; treeOid: string; files: MergeTreeMigrationFile[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'conflict'; reason: string };

interface MigrationChainDetailsBase {
  evaluatedAgainst: 'merge-tree' | 'worktree';
  baseRef?: string;
  treeOid?: string;
  mergeContext?: {
    source: 'worktree-fallback';
    reason: string;
  };
}

const DEFAULT_SCHEMA_PATTERNS = [
  /\.prisma$/,
  /schema\.sql$/,
  /models\.py$/,
];

const MIGRATION_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.wavemill',
  '__pycache__',
  'node_modules',
]);

const MIGRATION_CHAIN_IGNORED_FILES = new Set([
  'env.py',
  'script.py.mako',
]);

export const UNIVERSAL_READY_CHECKS = ['pr-exists', 'merge-conflict', 'ci-status'] as const;
export const UNIVERSAL_REQUIRED_CHECKS = ['pr-exists', 'merge-conflict', 'ci-status'] as const;

interface ResolvedReadyPolicy {
  checks: string[];
  requiredChecks: string[];
  migrationKind?: 'alembic' | 'sql' | 'none';
  migrationPatterns: string[];
  hasExplicitReadyConfig: boolean;
  migrationChainAutoEnabled: boolean;
}

function canonicalizeReadyCheckName(name: string): string {
  return name === 'merge-conflicts' ? 'merge-conflict' : name;
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  }
  return ordered;
}

function extendUniversalChecksForRepo(
  repoDir: string,
  baseChecks: readonly string[],
): Pick<ResolvedReadyPolicy, 'checks' | 'requiredChecks' | 'migrationKind' | 'migrationPatterns' | 'migrationChainAutoEnabled'> {
  const readyConfig = getReadyConfig(repoDir);
  const migrationChecks = getMigrationChecksConfig(repoDir);
  const checks = [...baseChecks];
  const hasAlembicDir = existsSync(path.join(repoDir, 'alembic', 'versions'));
  const canAutoEnable = hasAlembicDir
    && migrationChecks.enabled
    && migrationChecks.autoDetectAlembic
    && (readyConfig.migrationKind === undefined || readyConfig.migrationKind === 'alembic');

  if (!canAutoEnable) {
    return {
      checks,
      requiredChecks: [...UNIVERSAL_REQUIRED_CHECKS],
      migrationKind: readyConfig.migrationKind,
      migrationPatterns: readyConfig.migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
      migrationChainAutoEnabled: false,
    };
  }

  return {
    checks: uniqueOrdered([...checks, 'migration-chain-integrity']),
    requiredChecks: uniqueOrdered([...UNIVERSAL_REQUIRED_CHECKS, 'migration-chain-integrity']),
    migrationKind: 'alembic',
    migrationPatterns: ['alembic/versions/.*\\.py$'],
    migrationChainAutoEnabled: true,
  };
}

function resolveReadyPolicy(repoDir: string): ResolvedReadyPolicy {
  const rawConfig = loadWavemillConfig(repoDir);
  const readyConfig = getReadyConfig(repoDir);
  const rawReady = rawConfig.ready;
  const rawChecks = rawReady?.checks;
  const hasExplicitReadyConfig = Boolean(rawReady);

  const configuredChecks = Array.isArray(rawChecks)
    ? uniqueOrdered(rawChecks.map(canonicalizeReadyCheckName))
    : [];

  if (configuredChecks.length === 0) {
    const universal = extendUniversalChecksForRepo(repoDir, UNIVERSAL_READY_CHECKS);
    return {
      checks: universal.checks,
      requiredChecks: universal.requiredChecks,
      migrationKind: universal.migrationKind,
      migrationPatterns: universal.migrationPatterns,
      hasExplicitReadyConfig,
      migrationChainAutoEnabled: universal.migrationChainAutoEnabled,
    };
  }

  const rawRequired = rawReady?.requiredChecks;
  const requiredChecks = !Array.isArray(rawRequired)
    ? configuredChecks
    : uniqueOrdered(rawRequired.map(canonicalizeReadyCheckName));

  return {
    checks: configuredChecks,
    requiredChecks,
    migrationKind: readyConfig.migrationKind,
    migrationPatterns: readyConfig.migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
    hasExplicitReadyConfig,
    migrationChainAutoEnabled: false,
  };
}

function isMigrationRelatedCheck(checkName: string): boolean {
  return ['migration-chain-integrity', 'migration-reversibility', 'schema-migrations'].includes(checkName);
}

async function buildMigrationBaseRefreshCheck(repoDir: string, baseRef: string): Promise<ReadyCheck> {
  const migrationChecks = getMigrationChecksConfig(repoDir);
  const outcome = await refreshBaseForMigration(repoDir, baseRef, migrationChecks.baseRefresh);
  return {
    name: 'migration-base-refresh',
    status: outcome.refreshed ? 'pass' : 'warn',
    message: outcome.refreshed
      ? `Fetched origin/${baseRef} before migration validation`
      : `Skipped migration base refresh: ${outcome.reason ?? 'unknown'}`,
    details: {
      baseRef,
      ...outcome,
    },
  };
}

function compileMigrationPatterns(
  patternSources: string[]
): { patterns: RegExp[] } | { error: string; pattern: string } {
  const patterns: RegExp[] = [];

  for (const source of patternSources) {
    try {
      patterns.push(new RegExp(source));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        pattern: source,
      };
    }
  }

  return { patterns };
}

function getMigrationPatternsOrCheck(patternSources: string[], checkName: string): RegExp[] | ReadyCheck {
  const compiled = compileMigrationPatterns(patternSources);
  if ('error' in compiled) {
    return {
      name: checkName,
      status: 'fail',
      message: `Invalid ready.migrationPatterns entry: ${compiled.pattern}`,
      details: {
        pattern: compiled.pattern,
        error: compiled.error,
      },
    };
  }
  return compiled.patterns;
}

function findMigrationFiles(changedFiles: string[], migrationPatterns: RegExp[]): string[] {
  return changedFiles.filter(file => migrationPatterns.some(pattern => pattern.test(file)));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectMigrationFiles(repoDir: string, migrationPatterns: RegExp[]): Promise<string[]> {
  const matchedFiles: string[] = [];
  const pendingDirs = [repoDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!MIGRATION_SCAN_IGNORED_DIRS.has(entry.name)) {
          pendingDirs.push(entryPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(repoDir, entryPath).split(path.sep).join('/');
      if (
        relativePath.endsWith('.py') &&
        !MIGRATION_CHAIN_IGNORED_FILES.has(entry.name) &&
        migrationPatterns.some(pattern => pattern.test(relativePath))
      ) {
        matchedFiles.push(relativePath);
      }
    }
  }

  matchedFiles.sort();
  return matchedFiles;
}

function describeCommandFailure(error: unknown): { status?: number; reason: string } {
  if (!(error instanceof Error)) {
    return { reason: String(error) };
  }

  const commandError = error as Error & { status?: number; stderr?: string | Buffer };
  const stderr = typeof commandError.stderr === 'string'
    ? commandError.stderr.trim()
    : Buffer.isBuffer(commandError.stderr)
      ? commandError.stderr.toString('utf-8').trim()
      : '';
  const message = stderr || commandError.message;
  return {
    status: commandError.status,
    reason: message,
  };
}

async function collectMigrationFilesFromMergeTree(
  repoDir: string,
  baseRef: string,
  migrationPatterns: RegExp[],
): Promise<MergeTreeCollectionResult> {
  try {
    readyStageDeps.execShellCommand(
      `git fetch --quiet origin ${escapeShellArg(baseRef)}`,
      { encoding: 'utf-8', cwd: repoDir }
    );
  } catch {
    // Best-effort only; local refs may still be usable.
  }

  const candidateBaseRefs = [`origin/${baseRef}`, baseRef];
  let lastUnavailableReason = `Unable to resolve merge base for ${baseRef}`;

  for (const candidateBaseRef of candidateBaseRefs) {
    let treeOid: string;
    try {
      const mergeTreeOutput = readyStageDeps.execShellCommand(
        `git merge-tree --write-tree ${escapeShellArg(candidateBaseRef)} HEAD`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      treeOid = mergeTreeOutput.toString().trim();
      if (!treeOid) {
        lastUnavailableReason = `git merge-tree returned no tree for ${candidateBaseRef}`;
        continue;
      }
    } catch (error) {
      const { status, reason } = describeCommandFailure(error);
      if (status === 1) {
        return { kind: 'conflict', reason };
      }
      if (candidateBaseRef === `origin/${baseRef}` && /unknown revision|not a valid object name/i.test(reason)) {
        lastUnavailableReason = reason;
        continue;
      }
      return { kind: 'unavailable', reason };
    }

    try {
      const lsTreeOutput = readyStageDeps.execShellCommand(
        `git ls-tree -r --name-only ${escapeShellArg(treeOid)}`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const matchedFiles = lsTreeOutput
        .toString()
        .split('\n')
        .map(file => file.trim())
        .filter(file =>
          file.length > 0 &&
          file.endsWith('.py') &&
          !MIGRATION_CHAIN_IGNORED_FILES.has(path.posix.basename(file)) &&
          migrationPatterns.some(pattern => pattern.test(file))
        )
        .sort();

      const files = await Promise.all(
        matchedFiles.map(async file => {
          const content = readyStageDeps.execShellCommand(
            `git show ${escapeShellArg(`${treeOid}:${file}`)}`,
            { encoding: 'utf-8', cwd: repoDir }
          ).toString();
          return { file, content };
        })
      );

      return { kind: 'ok', treeOid, files };
    } catch (error) {
      return { kind: 'unavailable', reason: describeCommandFailure(error).reason };
    }
  }

  return { kind: 'unavailable', reason: lastUnavailableReason };
}

function formatMigrationList(items: string[], limit = 5): string {
  if (items.length <= limit) {
    return items.join(', ');
  }
  return `${items.slice(0, limit).join(', ')}, ...`;
}

function formatRevisionWithFile(revision: string, file: string): string {
  return `${revision} (${file})`;
}

function buildMigrationChainDetails(
  detailsBase: MigrationChainDetailsBase,
  details: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...details,
    ...detailsBase,
  };
}

function parseMigrationRevision(file: string, content: string): MigrationRevision | { error: string; details: Record<string, unknown> } {
  const revisionMatch = content.match(/^\s*revision\s*(?::\s*[^=]+)?=\s*(['"])([^'"]+)\1/m);
  if (!revisionMatch) {
    return {
      error: 'Migration file is missing a parseable revision',
      details: { file },
    };
  }

  const downRevisionLineMatch = content.match(/^\s*down_revision\s*(?::\s*[^=]+)?=\s*(.+)$/m);
  if (!downRevisionLineMatch) {
    return {
      error: 'Migration file is missing down_revision',
      details: { file, revision: revisionMatch[2] },
    };
  }

  const downRevisionValue = downRevisionLineMatch[1]?.trim() ?? '';
  let downRevisions: string[];
  if (downRevisionValue === 'None') {
    downRevisions = [];
  } else {
    const downRevisionMatch = downRevisionValue.match(/^(['"])([^'"]+)\1$/);
    if (downRevisionMatch) {
      downRevisions = [downRevisionMatch[2]!];
    } else if (
      (downRevisionValue.startsWith('(') && downRevisionValue.endsWith(')')) ||
      (downRevisionValue.startsWith('[') && downRevisionValue.endsWith(']'))
    ) {
      downRevisions = [...downRevisionValue.matchAll(/(['"])([^'"]+)\1/g)].map(match => match[2]!);
      if (downRevisions.length === 0) {
        return {
          error: 'Migration file has an unsupported down_revision format',
          details: {
            file,
            revision: revisionMatch[2],
            downRevision: downRevisionValue,
          },
        };
      }
    } else {
      return {
        error: 'Migration file has an unsupported down_revision format',
        details: {
          file,
          revision: revisionMatch[2],
          downRevision: downRevisionValue,
        },
      };
    }
  }

  return {
    file,
    revision: revisionMatch[2]!,
    downRevisions,
  };
}

function detectMigrationCycle(revisions: Map<string, MigrationRevision>): MigrationGraphCycle | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(revisionId: string): MigrationGraphCycle | null {
    if (visiting.has(revisionId)) {
      const cycleStartIndex = stack.indexOf(revisionId);
      const cycleRevisions = [...stack.slice(cycleStartIndex), revisionId];
      return {
        revisions: cycleRevisions,
        files: cycleRevisions
          .slice(0, -1)
          .map(id => revisions.get(id)?.file)
          .filter((file): file is string => Boolean(file)),
      };
    }

    if (visited.has(revisionId)) {
      return null;
    }

    visiting.add(revisionId);
    stack.push(revisionId);

    const node = revisions.get(revisionId);
    if (node) {
      for (const downRevision of node.downRevisions) {
        if (revisions.has(downRevision)) {
          const cycle = visit(downRevision);
          if (cycle) {
            return cycle;
          }
        }
      }
    }

    stack.pop();
    visiting.delete(revisionId);
    visited.add(revisionId);
    return null;
  }

  for (const revisionId of [...revisions.keys()].sort()) {
    const cycle = visit(revisionId);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

function findMigrationHeads(revisions: Iterable<MigrationRevision>): MigrationHead[] {
  const revisionList = [...revisions];
  const referencedDownRevisions = new Set(
    revisionList
      .flatMap(revision => revision.downRevisions)
  );

  return revisionList
    .filter(revision => !referencedDownRevisions.has(revision.revision))
    .map(revision => ({ revision: revision.revision, file: revision.file }))
    .sort((left, right) => left.revision.localeCompare(right.revision));
}

async function collectBaseMigrationFiles(
  repoDir: string,
  baseBranch: string,
  migrationPatterns: RegExp[],
): Promise<MergeTreeMigrationFile[]> {
  const baseRef = `origin/${baseBranch}`;
  const lsTreeOutput = readyStageDeps.execShellCommand(
    `git ls-tree -r --name-only ${escapeShellArg(baseRef)}`,
    { encoding: 'utf-8', cwd: repoDir }
  );
  const matchedFiles = lsTreeOutput
    .toString()
    .split('\n')
    .map(file => file.trim())
    .filter(file =>
      file.length > 0 &&
      file.endsWith('.py') &&
      !MIGRATION_CHAIN_IGNORED_FILES.has(path.posix.basename(file)) &&
      migrationPatterns.some(pattern => pattern.test(file))
    )
    .sort();

  return Promise.all(
    matchedFiles.map(async file => {
      const content = readyStageDeps.execShellCommand(
        `git show ${escapeShellArg(`${baseRef}:${file}`)}`,
        { encoding: 'utf-8', cwd: repoDir }
      ).toString();
      return { file, content };
    })
  );
}

// ────────────────────────────────────────────────────────────────
// Context Gathering Functions
// ────────────────────────────────────────────────────────────────

/**
 * Gather PR context from GitHub CLI.
 *
 * Fetches PR metadata and changed files list.
 *
 * @param prNumber - PR number to check
 * @param repoDir - Repository directory
 * @returns PR context including changed files
 * @throws Error if gh CLI fails or PR not found
 */
async function gatherPRContext(prNumber: number, repoDir: string): Promise<PRContext> {
  try {
    // Fetch PR metadata
    const prJson = readyStageDeps.execShellCommand(
      `gh pr view ${escapeShellArg(String(prNumber))} --json number,headRefName,baseRefName,url,files,labels`,
      { encoding: 'utf-8', cwd: repoDir }
    );
    const prData = JSON.parse(prJson.toString());

    // Extract changed files from JSON
    const changedFiles: string[] = prData.files?.map((f: any) => f.path) || [];

    // Normalize labels; defaults to [] when gh response omits the field.
    const labels: string[] = Array.isArray(prData.labels)
      ? prData.labels
          .map((label: any) => (typeof label?.name === 'string' ? label.name : null))
          .filter((name: string | null): name is string => name !== null)
      : [];

    // Fetch CI status
    let ciStatus = 'unknown';
    try {
      const checksJson = readyStageDeps.execShellCommand(
        `gh pr checks ${escapeShellArg(String(prNumber))} --json state 2>/dev/null`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const checks = JSON.parse(checksJson.toString());
      ciStatus = checks.length > 0 ? 'configured' : 'none';
    } catch (error) {
      // CI status check is best-effort
      ciStatus = 'unknown';
    }

    return {
      prNumber,
      changedFiles,
      labels,
      branch: prData.headRefName,
      baseBranch: prData.baseRefName,
      url: prData.url,
      ciStatus,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('could not resolve to a PullRequest')) {
        throw new Error(`PR #${prNumber} not found. Make sure the PR exists and you have access.`);
      }
      if (error.message.includes('gh: command not found')) {
        throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com/');
      }
      throw new Error(`Failed to fetch PR #${prNumber}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Find and load task packet from feature directory.
 *
 * Searches for task packet in features/ directory matching branch name or PR number.
 *
 * @param repoDir - Repository directory
 * @param prNumber - Optional PR number to help locate feature directory
 * @returns Task packet context or null if not found
 */
async function findTaskPacket(repoDir: string, prNumber?: number): Promise<TaskPacketContext | null> {
  try {
    // Look for features/ directory
    const featuresDir = path.join(repoDir, 'features');
    try {
      await fs.access(featuresDir);
    } catch {
      // No features directory
      return null;
    }

    // List all feature directories
    const entries = await fs.readdir(featuresDir, { withFileTypes: true });
    const featureDirs = entries.filter(e => e.isDirectory());

    // Try to find task-packet.md in any feature directory
    for (const dir of featureDirs) {
      const taskPacketPath = path.join(featuresDir, dir.name, 'task-packet.md');
      try {
        const content = await fs.readFile(taskPacketPath, 'utf-8');
        const releaseReadiness = extractReleaseReadiness(content);
        return {
          fullPath: taskPacketPath,
          content,
          releaseReadiness,
        };
      } catch {
        // This directory doesn't have a task packet, continue
        continue;
      }
    }

    // No task packet found
    return null;
  } catch (error) {
    // Graceful degradation - missing task packet is not an error
    return null;
  }
}

/**
 * Find and load plan file from feature directory.
 *
 * @param featureDir - Feature directory path
 * @returns Plan context or null if not found
 */
async function findPlan(featureDir: string): Promise<PlanContext | null> {
  try {
    const planPath = path.join(featureDir, 'plan.md');
    const content = await fs.readFile(planPath, 'utf-8');
    return {
      path: planPath,
      content,
    };
  } catch {
    // Missing plan is not an error
    return null;
  }
}

/**
 * Load deployment configuration.
 *
 * Currently returns empty object - extensibility for HOK-1177.
 *
 * @param repoDir - Repository directory
 * @returns Deployment config
 */
function loadDeployConfig(repoDir: string): Record<string, unknown> {
  // TODO: HOK-1177 will add deploy configuration loading
  return {};
}

// ────────────────────────────────────────────────────────────────
// Check Functions
// ────────────────────────────────────────────────────────────────

/**
 * Check for schema changes without corresponding migrations.
 *
 * Detects schema file changes and verifies matching migration files exist.
 * This is a hard-fail condition - schema changes require migrations.
 *
 * @param changedFiles - List of changed file paths
 * @param repoDir - Repository directory (unused for now)
 * @returns Check result
 * @internal Exported for testing purposes
 */
export function checkSchemaMigrations(changedFiles: string[], repoDir: string): ReadyCheck {
  // Check if any schema files changed
  const schemaFilesChanged = changedFiles.filter(file =>
    DEFAULT_SCHEMA_PATTERNS.some(pattern => pattern.test(file))
  );

  if (schemaFilesChanged.length === 0) {
    return {
      name: 'schema-migrations',
      status: 'skip',
      message: 'No schema changes detected',
      details: {},
    };
  }

  // Check if any migration files changed
  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    getReadyConfig(repoDir).migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
    'schema-migrations'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }
  const migrationFilesChanged = findMigrationFiles(changedFiles, migrationPatternsOrCheck);

  if (migrationFilesChanged.length === 0) {
    return {
      name: 'schema-migrations',
      status: 'fail',
      message: 'Schema files changed without migration files',
      details: {
        schemaFiles: schemaFilesChanged,
        migrationFiles: [],
      },
    };
  }

  // Both schema and migration files changed - pass
  return {
    name: 'schema-migrations',
    status: 'pass',
    message: 'Schema changes have corresponding migrations',
    details: {
      schemaFiles: schemaFilesChanged,
      migrationFiles: migrationFilesChanged,
    },
  };
}

/**
 * Check if changed files map to known deploy targets.
 *
 * v1 implementation: always skip (not configured).
 * Future versions will validate against deploy config.
 *
 * @param changedFiles - List of changed file paths
 * @param deployConfig - Deployment configuration
 * @returns Check result
 * @internal Exported for testing purposes
 */
export function checkDeployPaths(changedFiles: string[], deployConfig: Record<string, unknown>): ReadyCheck {
  return {
    name: 'deploy-paths',
    status: 'skip',
    message: 'Deploy path validation not configured',
    details: {},
  };
}

/**
 * Check if release requirements from task packet are met.
 *
 * Verifies that the PR implementation matches the expectations
 * declared in the task packet's release readiness metadata.
 *
 * @param taskPacket - Task packet context (may be null)
 * @param prContext - PR context with changed files
 * @returns Check result
 */
function checkReleaseRequirements(
  taskPacket: TaskPacketContext | null,
  prContext: PRContext,
  repoDir: string
): ReadyCheck {
  if (!taskPacket) {
    return {
      name: 'release-requirements',
      status: 'warn',
      message: 'No task packet found - skipping release requirements check',
      details: {},
    };
  }

  if (!taskPacket.releaseReadiness) {
    return {
      name: 'release-requirements',
      status: 'pass',
      message: 'No release expectations defined in task packet',
      details: {},
    };
  }

  const { releaseReadiness } = taskPacket;
  const { changedFiles } = prContext;

  // Define schema and migration file patterns (same as checkSchemaMigrations)
  const schemaFilesChanged = changedFiles.filter(file =>
    DEFAULT_SCHEMA_PATTERNS.some(pattern => pattern.test(file))
  );
  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    getReadyConfig(repoDir).migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
    'release-requirements'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }
  const migrationFilesChanged = findMigrationFiles(changedFiles, migrationPatternsOrCheck);

  // Check database change risk
  if (releaseReadiness.databaseChangeRisk === 'required') {
    // Migration files MUST be present
    if (migrationFilesChanged.length === 0) {
      return {
        name: 'release-requirements',
        status: 'fail',
        message: 'Task packet declares database changes required, but no migration files found',
        details: {
          databaseChangeRisk: 'required',
          migrationFilesFound: [],
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  } else if (releaseReadiness.databaseChangeRisk === 'possible') {
    // If schema files changed, warn if no migration
    if (schemaFilesChanged.length > 0 && migrationFilesChanged.length === 0) {
      return {
        name: 'release-requirements',
        status: 'warn',
        message: 'Schema files changed but no migration files (task packet marked as "possible")',
        details: {
          databaseChangeRisk: 'possible',
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  } else if (releaseReadiness.databaseChangeRisk === 'none') {
    // Warn if schema files found unexpectedly
    if (schemaFilesChanged.length > 0) {
      return {
        name: 'release-requirements',
        status: 'warn',
        message: 'Schema files changed but task packet declares no database changes expected',
        details: {
          databaseChangeRisk: 'none',
          schemaFilesFound: schemaFilesChanged,
        },
      };
    }
  }

  // Build details object
  const details: Record<string, unknown> = {
    databaseChangeRisk: releaseReadiness.databaseChangeRisk,
  };

  if (releaseReadiness.envChanges.length > 0) {
    details.envChanges = releaseReadiness.envChanges;
  }
  if (releaseReadiness.configChanges.length > 0) {
    details.configChanges = releaseReadiness.configChanges;
  }
  if (releaseReadiness.manualSteps.length > 0) {
    details.manualSteps = releaseReadiness.manualSteps;
  }

  return {
    name: 'release-requirements',
    status: 'pass',
    message: 'Release requirements met',
    details,
  };
}

export async function checkMigrationChainIntegrity(
  repoDir: string,
  migrationPatternSources: string[] = [...DEFAULT_READY_MIGRATION_PATTERNS],
  migrationKind?: 'alembic' | 'sql' | 'none',
  options?: { baseRef?: string },
): Promise<ReadyCheck> {
  if (migrationKind !== undefined && migrationKind !== 'alembic') {
    const kind = migrationKind ?? 'unspecified';
    return {
      name: 'migration-chain-integrity',
      status: 'skip',
      message: `migration-chain-integrity unsupported for ${kind} migrations`,
      details: {
        migrationKind: kind,
      },
    };
  }

  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    migrationPatternSources,
    'migration-chain-integrity'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }

  let migrationFiles: string[];
  let migrationFileContents: MergeTreeMigrationFile[] | null = null;
  let detailsBase: MigrationChainDetailsBase = {
    evaluatedAgainst: 'worktree',
  };

  if (options?.baseRef) {
    const mergeTreeFiles = await collectMigrationFilesFromMergeTree(
      repoDir,
      options.baseRef,
      migrationPatternsOrCheck
    );
    if (mergeTreeFiles.kind === 'ok') {
      migrationFileContents = mergeTreeFiles.files;
      migrationFiles = mergeTreeFiles.files.map(file => file.file);
      detailsBase = {
        evaluatedAgainst: 'merge-tree',
        baseRef: options.baseRef,
        treeOid: mergeTreeFiles.treeOid,
      };
    } else {
      migrationFiles = await collectMigrationFiles(repoDir, migrationPatternsOrCheck);
      detailsBase = {
        evaluatedAgainst: 'worktree',
        baseRef: options.baseRef,
        mergeContext: {
          source: 'worktree-fallback',
          reason: mergeTreeFiles.kind === 'conflict' ? 'merge-conflict' : 'git-unavailable',
        },
      };
    }
  } else {
    migrationFiles = await collectMigrationFiles(repoDir, migrationPatternsOrCheck);
  }

  if (migrationFiles.length === 0) {
    return {
      name: 'migration-chain-integrity',
      status: 'skip',
      message: 'No migration files found in repository',
      details: buildMigrationChainDetails(detailsBase, {}),
    };
  }

  const revisions = new Map<string, MigrationRevision>();
  const duplicateRevisions = new Map<string, string[]>();
  const skippedFiles: Array<{ file: string; reason: string }> = [];

  for (const relativeFile of migrationFiles) {
    const content = migrationFileContents
      ? migrationFileContents.find(file => file.file === relativeFile)?.content
      : await fs.readFile(path.join(repoDir, relativeFile), 'utf-8');
    if (content === undefined) {
      skippedFiles.push({
        file: relativeFile,
        reason: 'Migration file content was unavailable',
      });
      continue;
    }
    const parsed = parseMigrationRevision(relativeFile, content);
    if ('error' in parsed) {
      skippedFiles.push({
        file: relativeFile,
        reason: parsed.error,
      });
      continue;
    }

    const existing = revisions.get(parsed.revision);
    if (existing) {
      duplicateRevisions.set(parsed.revision, [existing.file, parsed.file]);
      continue;
    }

    revisions.set(parsed.revision, parsed);
  }

  const revisionFiles = [...revisions.values()].map(revision => revision.file).sort();
  if (revisionFiles.length === 0) {
    return {
      name: 'migration-chain-integrity',
      status: 'skip',
      message: 'No Alembic revision files found in repository',
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles,
        skippedFiles,
      }),
    };
  }

  if (duplicateRevisions.size > 0) {
    const duplicateEntries = [...duplicateRevisions.entries()].map(([revision, files]) => ({
      revision,
      files,
    }));
    return {
      name: 'migration-chain-integrity',
      status: 'fail',
      message: `Duplicate migration revision IDs found: ${formatMigrationList(
        duplicateEntries.map(entry => `${entry.revision} (${entry.files.join(', ')})`)
      )}`,
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles: revisionFiles,
        skippedFiles,
        duplicateRevisions: duplicateEntries,
      }),
    };
  }

  const missingDownRevisions = [...revisions.values()]
    .flatMap(revision =>
      revision.downRevisions
        .filter(downRevision => !revisions.has(downRevision))
        .map(downRevision => ({
          file: revision.file,
          revision: revision.revision,
          downRevision,
        }))
    );
  if (missingDownRevisions.length > 0) {
    return {
      name: 'migration-chain-integrity',
      status: 'fail',
      message: `Migration chain has unresolved down_revision references: ${formatMigrationList(
        missingDownRevisions.map(revision =>
          `${formatRevisionWithFile(revision.revision, revision.file)} -> ${revision.downRevision}`
        )
      )}`,
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles: revisionFiles,
        skippedFiles,
        missingDownRevisions,
      }),
    };
  }

  const cycle = detectMigrationCycle(revisions);
  if (cycle) {
    return {
      name: 'migration-chain-integrity',
      status: 'fail',
      message: `Migration chain contains a cycle: ${formatMigrationList([
        cycle.revisions.join(' -> '),
      ])}`,
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles: revisionFiles,
        skippedFiles,
        cycle,
      }),
    };
  }

  const referencedDownRevisions = new Set(
    [...revisions.values()]
      .flatMap(revision => revision.downRevisions)
  );
  const heads = [...revisions.values()]
    .filter(revision => !referencedDownRevisions.has(revision.revision))
    .map(revision => ({ revision: revision.revision, file: revision.file }));
  if (heads.length !== 1) {
    return {
      name: 'migration-chain-integrity',
      status: 'fail',
      message: `Migration chain must have exactly one head, found ${heads.length}: ${formatMigrationList(
        heads.map(head => formatRevisionWithFile(head.revision, head.file))
      )}`,
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles: revisionFiles,
        skippedFiles,
        heads,
      }),
    };
  }

  const roots = [...revisions.values()]
    .filter(revision => revision.downRevisions.length === 0)
    .map(revision => ({ revision: revision.revision, file: revision.file }));
  if (roots.length !== 1) {
    return {
      name: 'migration-chain-integrity',
      status: 'fail',
      message: `Migration chain must have exactly one root, found ${roots.length}: ${formatMigrationList(
        roots.map(root => formatRevisionWithFile(root.revision, root.file))
      )}`,
      details: buildMigrationChainDetails(detailsBase, {
        migrationFiles: revisionFiles,
        skippedFiles,
        roots,
      }),
    };
  }

  return {
    name: 'migration-chain-integrity',
    status: 'pass',
    message: 'Migration chain is well-formed',
    details: buildMigrationChainDetails(detailsBase, {
      migrationFiles: revisionFiles,
      skippedFiles,
      heads,
      roots,
    }),
  };
}

/**
 * Check whether the branch migration head is still based on the latest base
 * branch migration head.
 *
 * This only runs for Alembic repositories when the PR changed migration files.
 * It fetches the current `origin/<base>` ref, identifies the latest base head,
 * identifies the branch head from the worktree, then walks the branch chain to
 * confirm the base head is still reachable.
 */
export async function checkMigrationBaseFreshness(options: {
  repoDir: string;
  changedFiles: string[];
  baseBranch: string;
  migrationPatternSources?: string[];
  migrationKind?: 'alembic' | 'sql' | 'none';
}): Promise<ReadyCheck> {
  const {
    repoDir,
    changedFiles,
    baseBranch,
    migrationPatternSources = [...DEFAULT_READY_MIGRATION_PATTERNS],
    migrationKind,
  } = options;

  if (!baseBranch) {
    return {
      name: 'migration-base-freshness',
      status: 'skip',
      message: 'Base branch unknown',
      details: {},
    };
  }

  if (migrationKind !== undefined && migrationKind !== 'alembic') {
    const kind = migrationKind ?? 'unspecified';
    return {
      name: 'migration-base-freshness',
      status: 'skip',
      message: `migration-base-freshness unsupported for ${kind} migrations`,
      details: {
        migrationKind: kind,
      },
    };
  }

  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    migrationPatternSources,
    'migration-base-freshness'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }

  const migrationFilesChanged = findMigrationFiles(changedFiles, migrationPatternsOrCheck);
  if (migrationFilesChanged.length === 0) {
    return {
      name: 'migration-base-freshness',
      status: 'skip',
      message: 'No migration files changed in this PR',
      details: {},
    };
  }

  try {
    readyStageDeps.execShellCommand(
      `git fetch --quiet origin ${escapeShellArg(baseBranch)}`,
      { encoding: 'utf-8', cwd: repoDir }
    );
  } catch (error) {
    const { status, reason } = describeCommandFailure(error);
    return {
      name: 'migration-base-freshness',
      status: 'warn',
      message: 'Could not verify base migration head',
      details: {
        baseBranch,
        fetchError: reason,
        fetchStatus: status,
      },
    };
  }

  let baseMigrationFiles: MergeTreeMigrationFile[];
  try {
    baseMigrationFiles = await collectBaseMigrationFiles(repoDir, baseBranch, migrationPatternsOrCheck);
  } catch (error) {
    const { status, reason } = describeCommandFailure(error);
    return {
      name: 'migration-base-freshness',
      status: 'warn',
      message: 'Could not verify base migration head',
      details: {
        baseBranch,
        fetchError: reason,
        fetchStatus: status,
      },
    };
  }

  const baseRevisions = new Map<string, MigrationRevision>();
  const baseParseErrors: Array<{ file: string; reason: string; details: Record<string, unknown> }> = [];
  for (const migrationFile of baseMigrationFiles) {
    const parsed = parseMigrationRevision(migrationFile.file, migrationFile.content);
    if ('error' in parsed) {
      baseParseErrors.push({
        file: migrationFile.file,
        reason: parsed.error,
        details: parsed.details,
      });
      continue;
    }
    baseRevisions.set(parsed.revision, parsed);
  }

  if (baseParseErrors.length > 0) {
    return {
      name: 'migration-base-freshness',
      status: 'warn',
      message: 'Could not verify base migration head',
      details: {
        baseBranch,
        parseErrors: baseParseErrors,
      },
    };
  }

  const baseHeads = findMigrationHeads(baseRevisions.values());
  if (baseHeads.length !== 1) {
    return {
      name: 'migration-base-freshness',
      status: 'warn',
      message: 'Base branch has ambiguous Alembic heads - cannot verify freshness',
      details: {
        baseBranch,
        baseHeads,
      },
    };
  }

  const branchMigrationFiles = await collectMigrationFiles(repoDir, migrationPatternsOrCheck);
  const branchRevisions = new Map<string, MigrationRevision>();
  for (const relativeFile of branchMigrationFiles) {
    const content = await fs.readFile(path.join(repoDir, relativeFile), 'utf-8');
    const parsed = parseMigrationRevision(relativeFile, content);
    if ('error' in parsed) {
      return {
        name: 'migration-base-freshness',
        status: 'warn',
        message: 'Could not parse branch migration metadata',
        details: {
          file: relativeFile,
          parseError: parsed.error,
          ...parsed.details,
        },
      };
    }
    branchRevisions.set(parsed.revision, parsed);
  }

  const branchHeads = findMigrationHeads(branchRevisions.values());
  if (branchHeads.length !== 1) {
    return {
      name: 'migration-base-freshness',
      status: 'skip',
      message: 'Branch has no single Alembic head; deferring to migration-chain-integrity',
      details: {
        branchHeads,
      },
    };
  }

  const combinedRevisions = new Map<string, MigrationRevision>(baseRevisions);
  for (const [revision, migration] of branchRevisions.entries()) {
    combinedRevisions.set(revision, migration);
  }

  const baseHead = baseHeads[0]!.revision;
  const branchHeadRevision = branchHeads[0]!.revision;
  const branchHead = branchRevisions.get(branchHeadRevision)!;

  const branchChain: string[] = [];
  const branchChainSet = new Set<string>();
  const visited = new Set<string>();
  const revisionsToVisit = [branchHeadRevision];

  while (revisionsToVisit.length > 0) {
    const currentRevision = revisionsToVisit.pop()!;
    if (visited.has(currentRevision)) {
      continue;
    }
    visited.add(currentRevision);
    branchChain.push(currentRevision);
    branchChainSet.add(currentRevision);
    const currentMigration = combinedRevisions.get(currentRevision);
    if (currentMigration) {
      revisionsToVisit.push(...currentMigration.downRevisions);
    }
  }

  if (baseHead === branchHeadRevision || branchChainSet.has(baseHead)) {
    return {
      name: 'migration-base-freshness',
      status: 'pass',
      message: 'Branch migration head is based on the current base head',
      details: {
        baseHead,
        branchHead: branchHeadRevision,
        branchDownRevisions: branchHead.downRevisions,
        branchChain,
        baseBranch,
        migrationFilesChanged,
      },
    };
  }

  return {
    name: 'migration-base-freshness',
    status: 'fail',
    message: `Branch migration head ${branchHeadRevision} is not based on the current base head ${baseHead}. Rebase onto origin/${baseBranch} and update down_revision to ${baseHead} (or a descendant) before retrying.`,
    details: {
      baseHead,
      branchHead: branchHeadRevision,
      branchDownRevisions: branchHead.downRevisions,
      branchChain,
      baseBranch,
      migrationFilesChanged,
    },
  };
}

function summarizeForbiddenDDLFinding(finding: ForbiddenDDLFinding): string {
  return `${finding.file}:${finding.line} ${finding.rule}`;
}

export function checkForbiddenDDL(prContext: PRContext, repoDir: string): ReadyCheck {
  const config = getReadyConfig(repoDir);
  if (config.migrationKind !== undefined && config.migrationKind !== 'alembic' && config.migrationKind !== 'sql') {
    const kind = config.migrationKind ?? 'unspecified';
    return {
      name: 'forbidden-ddl',
      status: 'skip',
      message: `forbidden-ddl unsupported for ${kind} migrations`,
      details: { migrationKind: kind },
    };
  }
  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    config.migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
    'forbidden-ddl'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }

  const migrationFiles = findMigrationFiles(prContext.changedFiles, migrationPatternsOrCheck);
  const existingMigrationFiles = migrationFiles.filter(relativePath =>
    existsSync(path.join(repoDir, relativePath))
  );
  const analyzableMigrationFiles = existingMigrationFiles.filter(relativePath =>
    !isSqlRollbackMigration(relativePath)
  );

  if (analyzableMigrationFiles.length === 0) {
    return {
      name: 'forbidden-ddl',
      status: 'skip',
      message: 'No migration files changed',
      details: {
        migrationFiles: [],
        labels: prContext.labels,
      },
    };
  }

  const analyzer = readyStageDeps.spawnPython(
    FORBIDDEN_DDL_ANALYZER_PATH,
    analyzableMigrationFiles.map(relativePath => path.join(repoDir, relativePath)),
    repoDir
  );

  if (analyzer.error) {
    return {
      name: 'forbidden-ddl',
      status: 'fail',
      message: 'Python 3 is required to analyze migration files',
      details: {
        error: analyzer.error.message,
      },
    };
  }

  if (analyzer.status !== 0) {
    return {
      name: 'forbidden-ddl',
      status: 'fail',
      message: 'Forbidden DDL analyzer failed',
      details: {
        status: analyzer.status,
        stdout: analyzer.stdout?.slice(0, 2000),
        stderr: analyzer.stderr?.slice(0, 2000),
      },
    };
  }

  let analyzerResult: ForbiddenDDLAnalyzerResult;
  try {
    analyzerResult = JSON.parse(analyzer.stdout || '{}') as ForbiddenDDLAnalyzerResult;
  } catch (error) {
    return {
      name: 'forbidden-ddl',
      status: 'fail',
      message: 'Forbidden DDL analyzer returned invalid JSON',
      details: {
        error: error instanceof Error ? error.message : String(error),
        stdout: analyzer.stdout?.slice(0, 2000),
      },
    };
  }

  if (!Array.isArray(analyzerResult.findings) || !Array.isArray(analyzerResult.errors)) {
    return {
      name: 'forbidden-ddl',
      status: 'fail',
      message: 'Forbidden DDL analyzer returned an invalid payload',
      details: {
        stdout: analyzer.stdout?.slice(0, 2000),
      },
    };
  }

  if (analyzerResult.errors.length > 0) {
    return {
      name: 'forbidden-ddl',
      status: 'fail',
      message: 'Forbidden DDL analyzer could not parse one or more migration files',
      details: {
        migrationFiles: analyzableMigrationFiles,
        labels: prContext.labels,
        errors: analyzerResult.errors,
      },
    };
  }

  const prLabels = new Set(prContext.labels);
  const requiredLabels = config.migrationDangerLabels ?? {};
  const findings = analyzerResult.findings.map(finding => {
    const requiredLabel = requiredLabels[finding.rule];
    const acknowledged = typeof requiredLabel === 'string' && prLabels.has(requiredLabel);

    let status: ReadyCheckStatus = 'warn';
    let message = `${summarizeForbiddenDDLFinding(finding)} matched a custom forbidden migration pattern`;

    switch (finding.rule) {
      case 'add_column_non_nullable_no_default':
        status = 'fail';
        message = `${summarizeForbiddenDDLFinding(finding)} adds a non-nullable column without server_default`;
        break;
      case 'drop_column':
      case 'drop_table':
        status = acknowledged ? 'pass' : 'fail';
        message = acknowledged
          ? `${summarizeForbiddenDDLFinding(finding)} acknowledged by PR label ${requiredLabel}`
          : `${summarizeForbiddenDDLFinding(finding)} is destructive and requires PR label ${requiredLabel ?? '(unconfigured)'}`;
        break;
      case 'alter_column_type':
        status = acknowledged ? 'pass' : 'warn';
        message = acknowledged
          ? `${summarizeForbiddenDDLFinding(finding)} acknowledged by PR label ${requiredLabel}`
          : `${summarizeForbiddenDDLFinding(finding)} changes column type; expect a long-running table rewrite`;
        break;
      case 'execute_dml':
        status = 'warn';
        message = `${summarizeForbiddenDDLFinding(finding)} performs DML inside upgrade(); prefer a separate online job`;
        break;
    }

    return {
      ...finding,
      requiredLabel,
      acknowledged,
      status,
      message,
    };
  });

  const blockingFindings = findings.filter(finding => finding.status === 'fail');
  const warningFindings = findings.filter(finding => finding.status === 'warn');
  const acknowledgedFindings = findings.filter(finding => finding.acknowledged);

  if (blockingFindings.length === 0 && warningFindings.length === 0) {
    return {
      name: 'forbidden-ddl',
      status: 'pass',
      message: acknowledgedFindings.length > 0
        ? 'Migration risk findings were explicitly acknowledged by PR labels'
        : 'No forbidden migration patterns detected',
      details: {
        migrationFiles: analyzableMigrationFiles,
        labels: prContext.labels,
        findings,
        acknowledgedFindings,
        requiredLabels,
      },
    };
  }

  return {
    name: 'forbidden-ddl',
    status: blockingFindings.length > 0 ? 'fail' : 'warn',
    message: blockingFindings.length > 0
      ? `${blockingFindings.length} forbidden migration pattern(s) require changes or explicit acknowledgment`
      : `${warningFindings.length} migration risk warning(s) detected`,
    details: {
      migrationFiles: analyzableMigrationFiles,
      labels: prContext.labels,
      findings,
      acknowledgedFindings,
      requiredLabels,
    },
  };
}

/**
 * PR label that explicitly accepts an irreversible migration.
 *
 * When applied to the PR, hard reversibility failures (empty / docstring-only /
 * NotImplementedError downgrades) are recorded but converted to a `pass` so the
 * choice is documented rather than silently allowed.
 */
export const MIGRATION_IRREVERSIBLE_LABEL = 'migration:irreversible';
const READY_STAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_DDL_ANALYZER_PATH = path.join(READY_STAGE_DIR, 'forbidden-ddl-analyzer.py');
const SQL_ROLLBACK_SUFFIX = '_rollback.sql';

function isSqlRollbackMigration(file: string): boolean {
  return file.toLowerCase().endsWith(SQL_ROLLBACK_SUFFIX);
}

function getSqlRollbackPath(file: string): string {
  return file.replace(/\.sql$/i, SQL_ROLLBACK_SUFFIX);
}

/**
 * Alembic operations in `upgrade()` that destroy data even if `downgrade()`
 * recreates the schema. Listed here for the soft warning emitted by
 * `checkMigrationReversibility`.
 */
const DESTRUCTIVE_UPGRADE_OPERATIONS = ['op.drop_column', 'op.drop_table'] as const;

type MigrationFailureReason =
  | 'parse-error'
  | 'missing-downgrade'
  | 'empty-pass'
  | 'empty-docstring'
  | 'not-implemented';

interface MigrationReversibilityFailure {
  file: string;
  reason: MigrationFailureReason;
  classification?: DowngradeClassification;
  message: string;
}

interface MigrationReversibilityWarning {
  file: string;
  destructiveOperations: string[];
  classification: DowngradeClassification;
}

const MIGRATION_FAILURE_MESSAGES: Record<MigrationFailureReason, string> = {
  'parse-error': 'Migration file could not be parsed by python3 ast',
  'missing-downgrade': 'Migration file has no downgrade() function',
  'empty-pass': 'Migration downgrade() body is only "pass"',
  'empty-docstring': 'Migration downgrade() body is only a docstring',
  'not-implemented': 'Migration downgrade() raises NotImplementedError',
};

/**
 * Check that every changed migration file has a real, executable `downgrade()`.
 *
 * Fails when any migration in the PR has a downgrade body that is `pass`,
 * docstring-only, or `raise NotImplementedError`. Operators can document a
 * deliberate decision by applying the `migration:irreversible` label, which
 * converts the failure into a passing check while preserving the override
 * record in `details.overriddenFailures`.
 *
 * Even with a non-trivial downgrade, the check emits a soft warning when the
 * upgrade contains `op.drop_column` or `op.drop_table` because data loss is
 * not recoverable by `add_column` / `create_table`.
 */
export async function checkMigrationReversibility(
  changedFiles: string[],
  repoDir: string,
  labels: string[],
  migrationPatternSources: string[] = [...DEFAULT_READY_MIGRATION_PATTERNS],
  migrationKind?: 'alembic' | 'sql' | 'none'
): Promise<ReadyCheck> {
  if (migrationKind !== undefined && migrationKind !== 'alembic' && migrationKind !== 'sql') {
    const kind = migrationKind ?? 'unspecified';
    return {
      name: 'migration-reversibility',
      status: 'skip',
      message: `migration-reversibility unsupported for ${kind} migrations`,
      details: { migrationKind: kind },
    };
  }

  const migrationPatternsOrCheck = getMigrationPatternsOrCheck(
    migrationPatternSources,
    'migration-reversibility'
  );
  if (!Array.isArray(migrationPatternsOrCheck)) {
    return migrationPatternsOrCheck;
  }

  const migrationFiles = findMigrationFiles(changedFiles, migrationPatternsOrCheck);
  if (migrationFiles.length === 0) {
    return {
      name: 'migration-reversibility',
      status: 'skip',
      message: 'No migration files changed in this PR',
      details: {},
    };
  }

  const failures: MigrationReversibilityFailure[] = [];
  const warnings: MigrationReversibilityWarning[] = [];
  const rollbackFiles = new Set<string>();
  const changedFileSet = new Set(migrationFiles);

  for (const file of migrationFiles) {
    if (migrationKind === 'sql' && !file.toLowerCase().endsWith('.sql')) {
      continue;
    }
    if (migrationKind === 'alembic' && file.toLowerCase().endsWith('.sql')) {
      continue;
    }

    if (file.toLowerCase().endsWith('.sql')) {
      if (isSqlRollbackMigration(file)) {
        rollbackFiles.add(file);
        continue;
      }

      const rollbackFile = getSqlRollbackPath(file);
      const rollbackPath = path.isAbsolute(rollbackFile)
        ? rollbackFile
        : path.join(repoDir, rollbackFile);
      if (changedFileSet.has(rollbackFile) || existsSync(rollbackPath)) {
        rollbackFiles.add(rollbackFile);
        continue;
      }

      failures.push({
        file,
        reason: 'missing-downgrade',
        classification: 'missing',
        message: `${MIGRATION_FAILURE_MESSAGES['missing-downgrade']}; SQL migrations must include a matching ${path.basename(rollbackFile)}`,
      });
      continue;
    }

    const absolutePath = path.isAbsolute(file) ? file : path.join(repoDir, file);
    const parsed = parseMigrationFile(absolutePath);
    if (parsed.parseError) {
      failures.push({
        file,
        reason: 'parse-error',
        message: `${MIGRATION_FAILURE_MESSAGES['parse-error']}: ${parsed.parseError.kind} (${parsed.parseError.message})`,
      });
      continue;
    }

    const downgrade = getMigrationFunction(parsed, 'downgrade');
    const classification = downgrade ? classifyDowngradeBody(downgrade.body) : 'missing';

    if (classification !== 'non-trivial') {
      const reason: MigrationFailureReason =
        classification === 'missing'
          ? 'missing-downgrade'
          : classification;
      failures.push({
        file,
        reason,
        classification,
        message: MIGRATION_FAILURE_MESSAGES[reason],
      });
    }

    if (classification === 'non-trivial') {
      const upgrade = getMigrationFunction(parsed, 'upgrade');
      const upgradeOps = extractOperationCalls(upgrade);
      const destructive = [
        ...new Set(
          upgradeOps.filter(op =>
            (DESTRUCTIVE_UPGRADE_OPERATIONS as readonly string[]).includes(op)
          )
        ),
      ];
      if (destructive.length > 0) {
        warnings.push({
          file,
          destructiveOperations: destructive,
          classification,
        });
      }
    }
  }

  const overrideApplied = labels.some(
    label => label.toLowerCase() === MIGRATION_IRREVERSIBLE_LABEL.toLowerCase()
  );

  if (failures.length > 0) {
    if (overrideApplied) {
      return {
        name: 'migration-reversibility',
        status: 'pass',
        message: `Migration reversibility failures overridden by ${MIGRATION_IRREVERSIBLE_LABEL} label`,
        details: {
          overrideLabel: MIGRATION_IRREVERSIBLE_LABEL,
          overrideApplied: true,
          overriddenFailures: failures,
          warnings,
          migrationFiles,
          rollbackFiles: [...rollbackFiles].sort(),
        },
      };
    }
    return {
      name: 'migration-reversibility',
      status: 'fail',
      message: `Migration ${
        failures.length === 1 ? 'file has' : 'files have'
      } no executable downgrade() — apply the ${MIGRATION_IRREVERSIBLE_LABEL} label to document this decision`,
      details: {
        overrideLabel: MIGRATION_IRREVERSIBLE_LABEL,
        overrideApplied: false,
        failures,
        warnings,
        migrationFiles,
        rollbackFiles: [...rollbackFiles].sort(),
      },
    };
  }

  if (warnings.length > 0) {
    return {
      name: 'migration-reversibility',
      status: 'pass',
      message:
        'Migration downgrade() bodies are non-trivial; upgrade() contains destructive operations that downgrade cannot restore data for',
      details: {
        warnings,
        migrationFiles,
        rollbackFiles: [...rollbackFiles].sort(),
      },
    };
  }

  return {
    name: 'migration-reversibility',
    status: 'pass',
    message: rollbackFiles.size > 0
      ? 'All changed migrations have a non-trivial downgrade() or matching SQL rollback file'
      : 'All changed migrations have a non-trivial downgrade()',
    details: {
      migrationFiles,
      rollbackFiles: [...rollbackFiles].sort(),
    },
  };
}

/**
 * Check CI status for the PR.
 *
 * Verifies that all CI checks are passing.
 * This is a hard-fail condition - failing CI blocks merge.
 *
 * @param prNumber - PR number to check
 * @param repoDir - Repository directory
 * @returns Check result
 */
export async function checkCIStatus(prNumber: number, repoDir: string): Promise<ReadyCheck> {
  const ci = await readyStageDeps.fetchPrCiStatus(prNumber, repoDir);
  if (ci.conclusion === 'unknown') {
    return {
      name: 'ci-status',
      status: 'pending',
      message: 'Unable to fetch CI status',
      details: {
        error: ci.readError?.reason,
        errorType: ci.readError?.errorType,
      },
    };
  }

  return ciStatusToReadyCheck(ci);
}

export function ciStatusToReadyCheck(ci: PrCiStatus): ReadyCheck {
  const details = {
    conclusion: ci.conclusion,
    headSha: ci.headSha,
    mergeStateStatus: ci.mergeStateStatus,
    observed: ci.observed,
    passing: ci.passing,
    requiredContexts: ci.requiredContexts,
    requiredSource: ci.requiredSource,
    failingChecks: ci.failing,
    pendingChecks: ci.pending,
    missingRequired: ci.missingRequired,
    readError: ci.readError,
  };

  if (ci.conclusion === 'none') {
    return {
      name: 'ci-status',
      status: 'skip',
      message: 'No CI checks configured',
      details,
    };
  }
  if (ci.conclusion === 'fail') {
    return {
      name: 'ci-status',
      status: 'fail',
      message: `${ci.failing.length} CI check(s) failing`,
      details,
    };
  }
  if (ci.conclusion === 'pending') {
    const missing = ci.missingRequired.length;
    const pending = ci.pending.length;
    return {
      name: 'ci-status',
      status: 'pending',
      message: missing > 0
        ? `Waiting on ${missing} required CI check(s) to report`
        : `${pending || ci.requiredContexts.length || 1} CI check(s) still running`,
      details,
    };
  }
  if (ci.conclusion === 'unknown') {
    return {
      name: 'ci-status',
      status: 'pending',
      message: 'Unable to fetch CI status',
      details,
    };
  }

  return {
    name: 'ci-status',
    status: 'pass',
    message: 'All required CI checks passing',
    details,
  };
}

/**
 * Check GitHub mergeability state for an open PR.
 *
 * GitHub computes mergeability lazily and may initially report `UNKNOWN`.
 * Retry a few times before giving up so the monitor can distinguish transient
 * API latency from an actual conflicted PR.
 */
export async function checkMergeConflicts(
  prNumber: number,
  repoDir: string
): Promise<MergeConflictResult> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      const mergeabilityJson = readyStageDeps.execShellCommand(
        `gh pr view ${escapeShellArg(String(prNumber))} --json mergeable,mergeStateStatus`,
        { encoding: 'utf-8', cwd: repoDir }
      );
      const mergeability = JSON.parse(mergeabilityJson.toString()) as {
        mergeable?: string | null;
        mergeStateStatus?: string | null;
      };

      const mergeable = mergeability.mergeable ?? null;
      const mergeStateStatus = mergeability.mergeStateStatus ?? null;

      if (mergeable === 'MERGEABLE' || mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS') {
        return {
          status: 'CLEAN',
          message: 'No merge conflicts detected',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
        return {
          status: 'CONFLICTED',
          message: 'PR has merge conflicts with base branch',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      if (mergeable === 'UNKNOWN' || mergeStateStatus === 'UNKNOWN' || (!mergeable && !mergeStateStatus)) {
        if (attempt < MAX_TRANSIENT_ATTEMPTS) {
          await readyStageDeps.sleep(
            Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          );
          continue;
        }

        return {
          status: 'UNKNOWN',
          message: 'GitHub is still computing mergeability',
          mergeable,
          mergeStateStatus,
          attempts: attempt,
        };
      }

      return {
        status: 'ERROR',
        message: `Unexpected mergeability state: ${mergeable ?? 'null'} / ${mergeStateStatus ?? 'null'}`,
        mergeable,
        mergeStateStatus,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_TRANSIENT_ATTEMPTS) {
        await readyStageDeps.sleep(
          Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
        );
        continue;
      }

      return {
        status: 'ERROR',
        message: 'Unable to fetch mergeability from GitHub',
        attempts: attempt,
        error: lastError,
      };
    }
  }

  return {
    status: 'UNKNOWN',
    message: 'GitHub is still computing mergeability',
    attempts: MAX_TRANSIENT_ATTEMPTS,
    ...(lastError ? { error: lastError } : {}),
  };
}

// ────────────────────────────────────────────────────────────────
// Verdict Computation
// ────────────────────────────────────────────────────────────────

/**
 * Compute overall verdict from check results.
 *
 * Conservative approach:
 * - Any 'fail' → verdict is 'fail'
 * - No fails but any 'pending' → verdict is 'pending'
 * - No fails but any 'warn' → verdict is 'warn'
 * - Otherwise → verdict is 'pass'
 *
 * @param checks - Array of check results
 * @returns Overall verdict
 * @internal Exported for testing purposes
 */
export function computeVerdict(
  checks: ReadyCheck[],
  requiredCheckNames?: string[]
): 'pass' | 'fail' | 'warn' | 'pending' {
  // Empty checks array means nothing failed
  if (checks.length === 0) {
    return 'pass';
  }

  if (!requiredCheckNames) {
    const hasFail = checks.some(check => check.status === 'fail');
    if (hasFail) return 'fail';
    const hasPending = checks.some(check => check.status === 'pending');
    if (hasPending) return 'pending';
    const hasWarn = checks.some(check => check.status === 'warn');
    if (hasWarn) return 'warn';
    return 'pass';
  }

  const requiredSet = requiredCheckNames
    ? new Set(requiredCheckNames.map(canonicalizeReadyCheckName))
    : new Set(checks.map(check => check.name));
  const requiredChecks = checks.filter(check => requiredSet.has(check.name));
  const optionalChecks = checks.filter(check => !requiredSet.has(check.name));

  if (requiredChecks.some(check => check.status === 'fail')) return 'fail';
  if (requiredChecks.some(check => check.status === 'pending')) return 'pending';

  // 'skip' on optional checks means "not applicable" — it is not a warning condition.
  // Only treat optional fail/pending/warn as noteworthy.
  const hasWarnings = requiredChecks.some(check => check.status === 'warn' || check.status === 'skip')
    || optionalChecks.some(
      check => check.status === 'warn' || check.status === 'fail' || check.status === 'pending'
    );
  if (hasWarnings) {
    return 'warn';
  }

  return 'pass';
}

// ────────────────────────────────────────────────────────────────
// Main Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Run the ready stage for a PR.
 *
 * Gathers context, runs all configured checks, and produces a merge-readiness verdict.
 *
 * @param options - Options for running the ready stage
 * @param options.prNumber - PR number to check
 * @param options.repoDir - Repository directory
 * @returns Result of all ready checks
 * @throws Error if gh CLI not available or PR not found
 */
export async function runReadyStage(options: {
  prNumber: number;
  repoDir: string;
}): Promise<ReadyResult> {
  const { prNumber, repoDir } = options;

  const policy = resolveReadyPolicy(repoDir);

  // 1. Gather context
  let prContext: PRContext;
  try {
    prContext = await gatherPRContext(prNumber, repoDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|could not resolve to a PullRequest/i.test(message)) {
      return {
        prNumber,
        verdict: 'fail',
        checks: [{
          name: 'pr-exists',
          status: 'fail',
          message,
        }],
        timestamp: new Date().toISOString(),
        summary: 'Pull request was not found',
      };
    }
    throw error;
  }

  const checks: ReadyCheck[] = [];
  if (policy.checks.includes('pr-exists')) {
    checks.push({
      name: 'pr-exists',
      status: 'pass',
      message: `PR #${prNumber} is accessible`,
    });
  }

  const taskPacket = policy.checks.includes('release-requirements')
    ? await findTaskPacket(repoDir, prNumber)
    : null;
  const deployConfig = policy.checks.includes('deploy-paths')
    ? loadDeployConfig(repoDir)
    : {};
  let mergeConflict: MergeConflictResult | undefined;
  let ciStatus: PrCiStatus | undefined;
  let migrationBaseRefreshCheck: ReadyCheck | null = null;
  if (policy.checks.includes('merge-conflict')) {
    mergeConflict = await checkMergeConflicts(prNumber, repoDir);
    checks.push({
      name: 'merge-conflict',
      status:
        mergeConflict.status === 'CLEAN' ? 'pass'
          : mergeConflict.status === 'CONFLICTED' ? 'fail'
          : mergeConflict.status === 'UNKNOWN' ? 'pending'
          : 'warn',
      message: mergeConflict.message,
      details: {
        mergeable: mergeConflict.mergeable,
        mergeStateStatus: mergeConflict.mergeStateStatus,
        attempts: mergeConflict.attempts,
      },
    });
  }

  for (const checkName of policy.checks) {
    if (checkName === 'pr-exists' || checkName === 'merge-conflict') {
      continue;
    }
    if (isMigrationRelatedCheck(checkName) && migrationBaseRefreshCheck === null) {
      migrationBaseRefreshCheck = await buildMigrationBaseRefreshCheck(repoDir, prContext.baseBranch);
      checks.push(migrationBaseRefreshCheck);
    }
    if (checkName === 'ci-status') {
      const ciCheck = await checkCIStatus(prNumber, repoDir);
      checks.push(ciCheck);
      const details = ciCheck.details ?? {};
      ciStatus = {
        conclusion: String(details.conclusion ?? 'unknown') as PrCiStatus['conclusion'],
        observed: Number(details.observed ?? 0),
        passing: Number(details.passing ?? 0),
        failing: Array.isArray(details.failingChecks) ? details.failingChecks.filter((item): item is string => typeof item === 'string') : [],
        pending: Array.isArray(details.pendingChecks) ? details.pendingChecks.filter((item): item is string => typeof item === 'string') : [],
        missingRequired: Array.isArray(details.missingRequired) ? details.missingRequired.filter((item): item is string => typeof item === 'string') : [],
        requiredContexts: Array.isArray(details.requiredContexts) ? details.requiredContexts.filter((item): item is string => typeof item === 'string') : [],
        checks: [],
        requiredSource: String(details.requiredSource ?? 'none') as PrCiStatus['requiredSource'],
        headSha: typeof details.headSha === 'string' ? details.headSha : undefined,
        mergeStateStatus: typeof details.mergeStateStatus === 'string' ? details.mergeStateStatus : undefined,
      };
      continue;
    }
    if (checkName === 'schema-migrations') {
      checks.push(checkSchemaMigrations(prContext.changedFiles, repoDir));
      continue;
    }
    if (checkName === 'migration-base-freshness') {
      checks.push(await checkMigrationBaseFreshness({
        repoDir,
        changedFiles: prContext.changedFiles,
        baseBranch: prContext.baseBranch,
        migrationPatternSources: policy.migrationPatterns,
        migrationKind: policy.migrationKind,
      }));
      continue;
    }
    if (checkName === 'migration-chain-integrity') {
      checks.push(await checkMigrationChainIntegrity(
        repoDir,
        policy.migrationPatterns,
        policy.migrationKind,
        { baseRef: prContext.baseBranch }
      ));
      continue;
    }
    if (checkName === 'forbidden-ddl') {
      checks.push(checkForbiddenDDL(prContext, repoDir));
      continue;
    }
    if (checkName === 'migration-reversibility') {
      checks.push(await checkMigrationReversibility(
        prContext.changedFiles,
        repoDir,
        prContext.labels,
        policy.migrationPatterns,
        policy.migrationKind
      ));
      continue;
    }
    if (checkName === 'deploy-paths') {
      checks.push(checkDeployPaths(prContext.changedFiles, deployConfig));
      continue;
    }
    if (checkName === 'release-requirements') {
      checks.push(checkReleaseRequirements(taskPacket, prContext, repoDir));
      continue;
    }
  }

  if (!policy.hasExplicitReadyConfig) {
    if (policy.migrationChainAutoEnabled) {
      checks.push({
        name: 'migration-chain-auto-enabled',
        status: 'pass',
        message: 'Auto-enabled Alembic migration chain integrity checks',
        details: {
          migrationKind: policy.migrationKind,
          migrationPatterns: policy.migrationPatterns,
        },
      });
    }
    checks.push(await checkBaselineDiscovery(repoDir, policy.migrationChainAutoEnabled));
  }

  // 4. Compute verdict
  const verdict = computeVerdict(checks, policy.requiredChecks);

  // 5. Generate summary
  let summary: string;
  if (verdict === 'pass') {
    summary = 'All checks passed - safe to merge';
  } else if (verdict === 'pending') {
    summary = 'CI checks still in progress - will retry';
  } else if (verdict === 'warn') {
    summary = 'Checks passed with warnings - review before merge';
  } else {
    summary = 'One or more checks failed - not safe to merge';
  }

  // 6. Return result
  return {
    prNumber,
    branch: prContext.branch,
    verdict,
    checks,
    timestamp: new Date().toISOString(),
    summary,
    mergeConflict,
    headSha: ciStatus?.headSha,
    ciConclusion: ciStatus?.conclusion,
    mergeStateStatus: ciStatus?.mergeStateStatus,
  };
}

async function checkBaselineDiscovery(repoDir: string, migrationChainAutoEnabled = false): Promise<ReadyCheck> {
  const suggestions: string[] = [];
  const alembicDir = path.join(repoDir, 'alembic', 'versions');
  if (await fileExists(alembicDir)) {
    if (migrationChainAutoEnabled) {
      suggestions.push(
        'ready.checks: schema-migrations, migration-base-freshness, migration-reversibility, forbidden-ddl',
        'ready.requiredChecks: schema-migrations, migration-base-freshness'
      );
    } else {
      suggestions.push(
        'ready.checks: schema-migrations, migration-base-freshness, migration-chain-integrity, migration-reversibility, forbidden-ddl',
        'ready.requiredChecks: schema-migrations, migration-base-freshness, migration-chain-integrity, migration-reversibility',
        'ready.migrationKind: alembic',
        'ready.migrationPatterns: alembic/versions/.*\\.py$'
      );
    }
  }

  const sqlMigrationsDir = path.join(repoDir, 'migrations');
  if (await fileExists(sqlMigrationsDir)) {
    const hasSql = await repoContainsSqlMigrations(sqlMigrationsDir);
    if (hasSql) {
      suggestions.push(
        'ready.checks: schema-migrations, forbidden-ddl',
        'ready.migrationKind: sql',
        'ready.migrationPatterns: migrations/.*\\.sql$'
      );
    }
  }

  if (suggestions.length === 0) {
    return {
      name: 'baseline-discovery',
      status: 'skip',
      message: 'Baseline discovery found no migration-specific suggestions',
      details: {},
    };
  }

  return {
    name: 'baseline-discovery',
    status: 'warn',
    message: 'Baseline discovery found optional readiness policy suggestions',
    details: { suggestions: uniqueOrdered(suggestions) },
  };
}

async function repoContainsSqlMigrations(rootDir: string): Promise<boolean> {
  const stack = [rootDir];
  let scannedFiles = 0;
  const maxFiles = 3000;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!MIGRATION_SCAN_IGNORED_DIRS.has(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }
      if (entry.isFile()) {
        scannedFiles += 1;
        if (entry.name.toLowerCase().endsWith('.sql')) {
          return true;
        }
        if (scannedFiles >= maxFiles) {
          return false;
        }
      }
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// Legacy Marker Compatibility
// ────────────────────────────────────────────────────────────────

/**
 * Known legacy workflow marker files and their phase semantics.
 */
const LEGACY_MARKERS = [
  { file: '.plan-approved', name: 'legacy-plan-approved', phase: 'planning' as const },
  { file: '.coding-complete', name: 'legacy-coding-complete', phase: 'coding' as const },
  { file: '.workflow-aborted', name: 'legacy-workflow-aborted', phase: 'aborted' as const },
] as const;

/**
 * Result of checking legacy marker files in a feature directory.
 */
export interface LegacyMarkerResult {
  /** Which markers were found */
  markers: { file: string; present: boolean }[];
  /** ReadyCheck entries for each detected marker */
  checks: ReadyCheck[];
}

/**
 * Check for legacy workflow marker files in a feature directory.
 *
 * Detects `.plan-approved`, `.coding-complete`, and `.workflow-aborted` files
 * and maps them to structured `ReadyCheck` entries that the controller readiness
 * engine can incorporate alongside new-style checks.
 *
 * @deprecated Phase resolution now reads stage result files exclusively.
 * Keep this helper only for explicit migration and compatibility callers.
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Marker presence and corresponding ReadyCheck entries
 */
export async function checkLegacyMarkers(featureDir: string): Promise<LegacyMarkerResult> {
  const markers: { file: string; present: boolean }[] = [];
  const checks: ReadyCheck[] = [];

  for (const marker of LEGACY_MARKERS) {
    const markerPath = path.join(featureDir, marker.file);
    let present = false;
    try {
      await fs.access(markerPath);
      present = true;
    } catch {
      // Marker not present — not an error
    }

    markers.push({ file: marker.file, present });

    if (present) {
      checks.push({
        name: marker.name,
        status: marker.name === 'legacy-workflow-aborted' ? 'fail' : 'pass',
        message: `Legacy marker ${marker.file} detected`,
        details: { phase: marker.phase },
      });
    }
  }

  return { markers, checks };
}

// ────────────────────────────────────────────────────────────────
// Stage Result Files (HOK-1177, extended by HOK-1192)
//
// Types and I/O helpers live in stage-result.ts. This module
// re-exports them for backward compatibility.
// ────────────────────────────────────────────────────────────────

export type { StageStatus, StageName, StageResult, StageResultMap } from './stage-result.ts';
export type {
  StageArtifacts,
  PlanningArtifacts,
  CodingArtifacts,
  ReviewArtifacts,
  ReadyArtifacts,
} from './stage-result.ts';

export {
  readStageResult,
  readAllStageResults,
  writeStageResult,
  updateStageResult,
  getResultFilePath,
  isValidStage,
  isValidStatus,
} from './stage-result.ts';

// Re-export readAllStageResults under the legacy name for existing callers.
// Also bind locally as readStageResults so controllerCheckReadiness can call it.
import { readAllStageResults } from './stage-result.ts';
const readStageResults = readAllStageResults;
export { readStageResults };

// ────────────────────────────────────────────────────────────────
// Controller-Owned Readiness Check
// ────────────────────────────────────────────────────────────────

/**
 * Result of a controller-owned readiness check on a feature directory.
 *
 * Unlike `ReadyResult` which is PR-oriented, this evaluates a feature
 * directory's phase state without requiring GitHub CLI or a PR number.
 */
export interface ControllerReadinessResult {
  /** Absolute path to the feature directory that was checked */
  featureDir: string;

  /** Whether the feature directory is ready to proceed to the next phase */
  ready: boolean;

  /** Detected workflow phase based on markers and artifacts */
  phase: 'planning' | 'coding' | 'review' | 'ready' | 'aborted' | 'unknown';

  /** Individual check results */
  checks: ReadyCheck[];

  /** ISO 8601 timestamp when checks were run */
  timestamp: string;

  /** Human-readable summary */
  summary: string;
}

/**
 * Run a controller-owned readiness check on a feature directory.
 *
 * This is the "pre-PR" readiness function that evaluates a feature directory's
 * phase state without requiring a PR number or GitHub CLI access. The controller
 * (shell orchestrator) uses this to determine phase transitions.
 *
 * Checks performed:
 * - Stage result files (`.planning-result.json`, etc.) — authoritative source
 * - Task packet presence
 * - Plan file presence
 *
 * @param featureDir - Absolute path to the feature directory
 * @returns Controller readiness result with phase detection and check details
 */
export async function controllerCheckReadiness(
  featureDir: string,
): Promise<ControllerReadinessResult> {
  const checks: ReadyCheck[] = [];

  // 1. Verify feature directory exists
  try {
    await fs.access(featureDir);
  } catch {
    return {
      featureDir,
      ready: false,
      phase: 'unknown',
      checks: [{
        name: 'feature-dir',
        status: 'fail',
        message: `Feature directory does not exist: ${featureDir}`,
      }],
      timestamp: new Date().toISOString(),
      summary: 'Feature directory not found',
    };
  }

  // 2. Read structured stage result files (HOK-1177)
  const stageResults = await readStageResults(featureDir);
  const hasStageResults = Object.keys(stageResults).length > 0;

  for (const [stage, result] of Object.entries(stageResults)) {
    checks.push({
      name: `stage-${stage}`,
      status: result.status === 'aborted' || result.status === 'failed' ? 'fail'
            : result.status === 'completed' ? 'pass'
            : 'warn',
      message: result.status === 'awaiting_user'
        ? `Stage ${stage}: awaiting_user — plan ready for approval`
        : `Stage ${stage}: ${result.status}`,
      details: { stage, status: result.status, agent: result.agent, model: result.model },
    });
  }

  // 3. Check for task packet
  const taskPacketPath = path.join(featureDir, 'task-packet.md');
  try {
    await fs.access(taskPacketPath);
    checks.push({
      name: 'task-packet',
      status: 'pass',
      message: 'Task packet found',
    });
  } catch {
    checks.push({
      name: 'task-packet',
      status: 'warn',
      message: 'No task packet found in feature directory',
    });
  }

  // 4. Check for plan
  const planPath = path.join(featureDir, 'plan.md');
  try {
    await fs.access(planPath);
    checks.push({
      name: 'plan',
      status: 'pass',
      message: 'Implementation plan found',
    });
  } catch {
    checks.push({
      name: 'plan',
      status: 'warn',
      message: 'No implementation plan found in feature directory',
    });
  }

  // 5. Determine phase from stage results only
  let phase: ControllerReadinessResult['phase'] = 'unknown';

  if (hasStageResults) {
    // Check for abort in any stage
    const abortedStage = Object.values(stageResults).find(r => r.status === 'aborted');
    if (abortedStage) {
      phase = 'aborted';
    } else if (stageResults.ready?.status === 'completed') {
      const verdict = stageResults.ready.artifacts?.type === 'ready'
        ? stageResults.ready.artifacts.verdict
        : undefined;
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: verdict === 'fail' ? 'fail' : verdict === 'warn' || verdict === 'pending' ? 'warn' : 'pass',
        message: verdict === 'fail'
          ? 'Ready stage failed - merge is blocked'
          : verdict === 'warn'
            ? 'Ready stage passed with warnings - merge may require manual follow-up'
            : verdict === 'pending'
              ? 'Ready stage is still waiting on CI checks'
            : 'Ready stage passed - merge is allowed',
        details: { verdict },
      });
    } else if (stageResults.ready?.status === 'running') {
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: 'warn',
        message: 'Ready remediation in progress',
      });
    } else if (stageResults.ready?.status === 'failed') {
      phase = 'ready';
      checks.push({
        name: 'ready-outcome',
        status: 'fail',
        message: 'Ready stage needs attention',
      });
    } else if (stageResults.ready) {
      phase = 'ready';
    } else if (stageResults.review?.status === 'completed') {
      phase = 'ready';
    } else if (stageResults.review?.status === 'running') {
      phase = 'review';
    } else if (stageResults.coding?.status === 'completed') {
      phase = 'review';
    } else if (stageResults.coding?.status === 'running') {
      phase = 'coding';
    } else if (stageResults.planning?.status === 'completed') {
      phase = 'coding';
    } else if (stageResults.planning?.status === 'awaiting_user') {
      phase = 'planning';
    } else if (stageResults.planning?.status === 'running') {
      phase = 'planning';
    }
  }

  // 6. Determine readiness — ready if no failures
  const hasFail = checks.some(c => c.status === 'fail');
  const ready = !hasFail;

  // 7. Build summary
  let summary: string;
  if (phase === 'aborted') {
    summary = 'Workflow was aborted';
  } else if (phase === 'unknown') {
    summary = 'No stage results detected - feature directory may be in initial state';
  } else if (stageResults.ready?.status === 'running') {
    summary = 'Feature is in ready phase (remediation in progress)';
  } else if (stageResults.ready?.status === 'failed') {
    summary = 'Feature is in ready phase (needs attention)';
  } else {
    const statusSuffix = ready ? '' : ' (blocked by failing checks)';
    summary = `Feature is in ${phase} phase${statusSuffix} (from stage results)`;
  }

  return {
    featureDir,
    ready,
    phase,
    checks,
    timestamp: new Date().toISOString(),
    summary,
  };
}
