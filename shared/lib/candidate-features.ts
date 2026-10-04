/**
 * Repo-agnostic extractor for the frozen Arbiter S1 `candidate_features/v1`.
 *
 * The core accepts only a checkout plus PR number. Wavemill workflow state is
 * deliberately outside the boundary; callers that have a task contract may
 * pass the normalized, privacy-safe contract below to enrich Intent and bounded
 * Provenance fields. Without that contract, Intent fields are `null`, never
 * guessed defaults.
 *
 * The published `@hokusai/core@0.4.0` exports `deriveTaskDescriptor` but not
 * yet the candidate-feature schema fixture named by S1. Until that SDK fixture
 * lands, this module keeps a strict local mirror of the frozen 33-field shape.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveTaskDescriptor,
  normalizeComplexity,
  type TaskDescriptorSignals,
} from '@hokusai/core';
import { collectStaticFeatures, type StaticFeaturesResult } from './static-features.ts';
import { execArgvCommand } from './shell-utils.ts';

export const CANDIDATE_FEATURES_SCHEMA_VERSION = 'candidate_features/v1';

export type CandidateTaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'infra'
  | 'tests'
  | 'migration'
  | 'docs'
  | 'unknown';

export type CandidateLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'rust'
  | 'java'
  | 'bash'
  | 'multi'
  | 'unknown';

export type CandidateDomain =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'devops'
  | 'data'
  | 'ml'
  | 'mobile'
  | 'unknown';

export type CandidateRepoSizeBucket = 'small' | 'medium' | 'large' | 'xlarge';
export type CandidateFilesTouchedBucket = '1' | '2_5' | '6_15' | '16_plus';
export type CandidateDescriptionLengthBucket = 'short' | 'medium' | 'long';
export type CandidateRiskLevel = 'low' | 'medium' | 'high';

export interface CandidateFeaturesV1 {
  schema_version: typeof CANDIDATE_FEATURES_SCHEMA_VERSION;

  // Shape
  files_touched: number | null;
  lines_added: number | null;
  lines_deleted: number | null;
  loc_touched: number | null;
  dependency_depth: number | null;
  module_hotspot_score: number | null;
  diff_uncertain: boolean | null;

  // Static
  type_errors: number | null;
  lint_errors: number | null;
  build_ok: boolean | null;
  complexity_delta: number | null;

  // Test
  tests_changed: boolean | null;
  test_pass_rate: number | null;
  test_runtime_seconds: number | null;

  // Intent
  task_type: CandidateTaskType | null;
  language: CandidateLanguage | null;
  domain: CandidateDomain | null;
  complexity: number | null;
  repo_size_bucket: CandidateRepoSizeBucket | null;
  files_touched_bucket: CandidateFilesTouchedBucket | null;
  description_length_bucket: CandidateDescriptionLengthBucket | null;
  is_greenfield: boolean | null;
  is_migration: boolean | null;
  requires_tests: boolean | null;
  cross_service: boolean | null;
  ui_heavy: boolean | null;
  risk_level: CandidateRiskLevel | null;

  // Provenance
  touched_out_of_scope_files: number | null;
  human_intervention_count: number | null;
  review_rounds: number | null;
  change_requests: number | null;
  self_review_iterations: number | null;
  agent_iterations: number | null;
}

export type CandidateFeatureKey = Exclude<keyof CandidateFeaturesV1, 'schema_version'>;

export interface CandidateFeatureContract {
  /**
   * Local task text used only as input to `deriveTaskDescriptor`; never returned.
   */
  taskText?: string;
  repositorySignals?: TaskDescriptorSignals;
  intent?: Partial<Pick<
    CandidateFeaturesV1,
    | 'task_type'
    | 'language'
    | 'domain'
    | 'complexity'
    | 'repo_size_bucket'
    | 'files_touched_bucket'
    | 'description_length_bucket'
    | 'is_greenfield'
    | 'is_migration'
    | 'requires_tests'
    | 'cross_service'
    | 'ui_heavy'
    | 'risk_level'
  >>;
  scope?: {
    allowedFiles?: string[];
    allowedPrefixes?: string[];
  };
  provenance?: Partial<Pick<
    CandidateFeaturesV1,
    | 'human_intervention_count'
    | 'review_rounds'
    | 'change_requests'
    | 'self_review_iterations'
    | 'agent_iterations'
  >>;
}

export interface CandidateFeaturesOptions {
  checkoutDir: string;
  prNumber: string | number;
  repoDir?: string;
  baseRef?: string;
  contract?: CandidateFeatureContract;
  offline?: boolean;
  staticFeatures?: StaticFeaturesResult;
}

export interface CandidateFeatureValidationIssue {
  field: string;
  message: string;
}

type FeatureKind =
  | 'integer'
  | 'number'
  | 'boolean'
  | 'task_type'
  | 'language'
  | 'domain'
  | 'repo_size_bucket'
  | 'files_touched_bucket'
  | 'description_length_bucket'
  | 'risk_level';

const FEATURE_KINDS: Record<CandidateFeatureKey, FeatureKind> = {
  files_touched: 'integer',
  lines_added: 'integer',
  lines_deleted: 'integer',
  loc_touched: 'integer',
  dependency_depth: 'integer',
  module_hotspot_score: 'number',
  diff_uncertain: 'boolean',
  type_errors: 'integer',
  lint_errors: 'integer',
  build_ok: 'boolean',
  complexity_delta: 'number',
  tests_changed: 'boolean',
  test_pass_rate: 'number',
  test_runtime_seconds: 'number',
  task_type: 'task_type',
  language: 'language',
  domain: 'domain',
  complexity: 'number',
  repo_size_bucket: 'repo_size_bucket',
  files_touched_bucket: 'files_touched_bucket',
  description_length_bucket: 'description_length_bucket',
  is_greenfield: 'boolean',
  is_migration: 'boolean',
  requires_tests: 'boolean',
  cross_service: 'boolean',
  ui_heavy: 'boolean',
  risk_level: 'risk_level',
  touched_out_of_scope_files: 'integer',
  human_intervention_count: 'integer',
  review_rounds: 'integer',
  change_requests: 'integer',
  self_review_iterations: 'integer',
  agent_iterations: 'integer',
};

const TASK_TYPES = new Set<CandidateTaskType>([
  'bugfix',
  'feature',
  'refactor',
  'infra',
  'tests',
  'migration',
  'docs',
  'unknown',
]);
const LANGUAGES = new Set<CandidateLanguage>([
  'python',
  'typescript',
  'javascript',
  'go',
  'rust',
  'java',
  'bash',
  'multi',
  'unknown',
]);
const DOMAINS = new Set<CandidateDomain>([
  'backend',
  'frontend',
  'fullstack',
  'devops',
  'data',
  'ml',
  'mobile',
  'unknown',
]);
const REPO_SIZE_BUCKETS = new Set<CandidateRepoSizeBucket>(['small', 'medium', 'large', 'xlarge']);
const FILES_TOUCHED_BUCKETS = new Set<CandidateFilesTouchedBucket>(['1', '2_5', '6_15', '16_plus']);
const DESCRIPTION_LENGTH_BUCKETS = new Set<CandidateDescriptionLengthBucket>(['short', 'medium', 'long']);
const RISK_LEVELS = new Set<CandidateRiskLevel>(['low', 'medium', 'high']);

const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|(\.|-)(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/i;

interface DiffStats {
  changedFiles: string[];
  filesTouched: number;
  linesAdded: number;
  linesDeleted: number;
  locTouched: number;
  diffUncertain: boolean;
}

interface PullRequestEvidence {
  baseRefName?: string;
}

export function extractCandidateFeatures(
  options: CandidateFeaturesOptions,
): CandidateFeaturesV1 {
  const checkoutDir = resolve(options.checkoutDir);
  const repoDir = resolve(options.repoDir ?? checkoutDir);
  const prNumber = String(options.prNumber);
  const prEvidence = options.offline
    ? null
    : safe(() => fetchPullRequestEvidence(prNumber, repoDir), null);
  const baseRef = resolveBaseRef(checkoutDir, prEvidence?.baseRefName, options.baseRef);
  const diffStats = safe(() => collectDiffStats(checkoutDir, baseRef), null);
  const staticFeatures = options.staticFeatures ?? collectStaticFeatures({
    checkoutDir,
    prNumber,
    repoDir,
    ...(baseRef ? { baseRef } : {}),
    offline: options.offline,
  });
  const reviewEvidence = options.offline
    ? null
    : safe(() => collectReviewEvidence(prNumber, repoDir), null);

  const candidate: CandidateFeaturesV1 = {
    schema_version: CANDIDATE_FEATURES_SCHEMA_VERSION,
    files_touched: diffStats?.filesTouched ?? null,
    lines_added: diffStats?.linesAdded ?? null,
    lines_deleted: diffStats?.linesDeleted ?? null,
    loc_touched: diffStats?.locTouched ?? null,
    dependency_depth: null,
    module_hotspot_score: null,
    diff_uncertain: diffStats?.diffUncertain ?? null,
    type_errors: staticFeatures.type_errors,
    lint_errors: staticFeatures.lint_errors,
    build_ok: staticFeatures.build_ok,
    complexity_delta: staticFeatures.complexity_delta,
    tests_changed: diffStats ? diffStats.changedFiles.some(isTestFile) : null,
    test_pass_rate: options.offline ? null : safe(() => collectTestPassRate(prNumber, repoDir), null),
    test_runtime_seconds: null,
    ...nullIntent(),
    touched_out_of_scope_files: collectTouchedOutOfScopeFiles(diffStats, options.contract),
    human_intervention_count: normalizeNonNegativeInteger(options.contract?.provenance?.human_intervention_count),
    review_rounds: normalizeNonNegativeInteger(
      options.contract?.provenance?.review_rounds ?? reviewEvidence?.reviewRounds,
    ),
    change_requests: normalizeNonNegativeInteger(
      options.contract?.provenance?.change_requests ?? reviewEvidence?.changeRequests,
    ),
    self_review_iterations: normalizeNonNegativeInteger(options.contract?.provenance?.self_review_iterations),
    agent_iterations: normalizeNonNegativeInteger(options.contract?.provenance?.agent_iterations),
  };

  const intent = deriveIntent(options.contract, diffStats);
  Object.assign(candidate, intent);

  const issues = validateCandidateFeatures(candidate);
  if (issues.length > 0) {
    const details = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
    throw new Error(`candidate_features/v1 validation failed: ${details}`);
  }

  return candidate;
}

export function validateCandidateFeatures(value: unknown): CandidateFeatureValidationIssue[] {
  const issues: CandidateFeatureValidationIssue[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ field: '<root>', message: 'must be an object' }];
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(['schema_version', ...Object.keys(FEATURE_KINDS)]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push({ field: key, message: 'unknown field' });
    }
  }

  if (record.schema_version !== CANDIDATE_FEATURES_SCHEMA_VERSION) {
    issues.push({
      field: 'schema_version',
      message: `must equal ${CANDIDATE_FEATURES_SCHEMA_VERSION}`,
    });
  }

  for (const [field, kind] of Object.entries(FEATURE_KINDS) as Array<[CandidateFeatureKey, FeatureKind]>) {
    if (!(field in record)) {
      issues.push({ field, message: 'required field is missing' });
      continue;
    }
    const fieldIssues = validateFieldValue(field, record[field], kind);
    issues.push(...fieldIssues);
  }

  return issues;
}

function validateFieldValue(
  field: CandidateFeatureKey,
  value: unknown,
  kind: FeatureKind,
): CandidateFeatureValidationIssue[] {
  if (value === null) return [];
  const issue = (message: string): CandidateFeatureValidationIssue => ({ field, message });
  if (kind === 'integer') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? []
      : [issue('must be a non-negative integer or null')];
  }
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [issue('must be a finite number or null')];
    }
    if (field === 'test_pass_rate' && (value < 0 || value > 1)) {
      return [issue('must be between 0 and 1 or null')];
    }
    if (field === 'module_hotspot_score' && (value < 0 || value > 100)) {
      return [issue('must be between 0 and 100 or null')];
    }
    if (field === 'complexity' && (value < 0 || value > 10)) {
      return [issue('must be between 0 and 10 or null')];
    }
    if (field === 'test_runtime_seconds' && value < 0) {
      return [issue('must be non-negative or null')];
    }
    return [];
  }
  if (kind === 'boolean') {
    return typeof value === 'boolean' ? [] : [issue('must be a boolean or null')];
  }
  if (kind === 'task_type') return TASK_TYPES.has(value as CandidateTaskType) ? [] : [issue('invalid task type')];
  if (kind === 'language') return LANGUAGES.has(value as CandidateLanguage) ? [] : [issue('invalid language')];
  if (kind === 'domain') return DOMAINS.has(value as CandidateDomain) ? [] : [issue('invalid domain')];
  if (kind === 'repo_size_bucket') {
    return REPO_SIZE_BUCKETS.has(value as CandidateRepoSizeBucket) ? [] : [issue('invalid repo size bucket')];
  }
  if (kind === 'files_touched_bucket') {
    return FILES_TOUCHED_BUCKETS.has(value as CandidateFilesTouchedBucket) ? [] : [issue('invalid files touched bucket')];
  }
  if (kind === 'description_length_bucket') {
    return DESCRIPTION_LENGTH_BUCKETS.has(value as CandidateDescriptionLengthBucket)
      ? []
      : [issue('invalid description length bucket')];
  }
  return RISK_LEVELS.has(value as CandidateRiskLevel) ? [] : [issue('invalid risk level')];
}

function collectDiffStats(checkoutDir: string, baseRef: string | null): DiffStats | null {
  if (!baseRef || !isExistingDir(checkoutDir)) return null;
  const mergeBase = runGit(checkoutDir, ['merge-base', baseRef, 'HEAD']);
  if (!mergeBase) return null;

  const numstat = runGit(checkoutDir, ['diff', '--numstat', '--find-renames', `${mergeBase}...HEAD`]);
  const names = runGit(checkoutDir, ['diff', '--name-only', '--find-renames', `${mergeBase}...HEAD`]);
  if (numstat === null || names === null) return null;

  const changedFiles = names.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  let linesAdded = 0;
  let linesDeleted = 0;

  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, deleted] = line.split('\t');
    linesAdded += parseNumstatCount(added);
    linesDeleted += parseNumstatCount(deleted);
  }

  return {
    changedFiles,
    filesTouched: changedFiles.length,
    linesAdded,
    linesDeleted,
    locTouched: linesAdded + linesDeleted,
    diffUncertain: changedFiles.length > 0 && numstat.trim().length === 0,
  };
}

function parseNumstatCount(value: string | undefined): number {
  if (!value || value === '-') return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function resolveBaseRef(
  checkoutDir: string,
  prBaseRefName: string | undefined,
  explicitBaseRef: string | undefined,
): string | null {
  const candidates = [
    explicitBaseRef,
    prBaseRefName ? `origin/${prBaseRefName}` : undefined,
    prBaseRefName,
    'origin/main',
    'main',
    'origin/HEAD',
    'HEAD^',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = runGit(checkoutDir, ['rev-parse', '--verify', candidate], { allowFailure: true });
    if (resolved) return candidate;
  }
  return null;
}

function fetchPullRequestEvidence(prNumber: string, repoDir: string): PullRequestEvidence | null {
  if (!/^\d+$/.test(prNumber) || !isExistingDir(repoDir)) return null;
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'baseRefName'],
    { cwd: repoDir, timeout: 15_000, encoding: 'utf-8' },
  );
  if (result.failed || result.exitCode !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { baseRefName?: unknown };
    return typeof parsed.baseRefName === 'string' && parsed.baseRefName.length > 0
      ? { baseRefName: parsed.baseRefName }
      : null;
  } catch {
    return null;
  }
}

function collectTestPassRate(prNumber: string, repoDir: string): number | null {
  if (!/^\d+$/.test(prNumber) || !isExistingDir(repoDir)) return null;
  const result = execArgvCommand(
    'gh',
    ['pr', 'checks', prNumber, '--json', 'name,state,bucket'],
    { cwd: repoDir, timeout: 15_000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.failed || result.exitCode < 0 || !result.stdout.trim()) return null;
  let checks: Array<{ name?: string; bucket?: string; state?: string }>;
  try {
    checks = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(checks)) return null;
  // Aggregate across every check whose name matches a test tool. Sharded
  // pipelines (e.g. `unit-shard-3/7`) expose per-shard checks; taking only
  // the first would report the pass rate of one shard as if it were the
  // whole suite. Skipped/cancelled/pending shards are excluded from the
  // denominator so the rate reflects only checks that reported a verdict.
  const testChecks = checks.filter((check) => /test|spec|jest|vitest|pytest/i.test(check.name ?? ''));
  if (testChecks.length === 0) return null;
  let passed = 0;
  let scored = 0;
  for (const check of testChecks) {
    if (check.bucket === 'pass') { passed += 1; scored += 1; }
    else if (check.bucket === 'fail') { scored += 1; }
  }
  if (scored === 0) return null;
  return passed / scored;
}

function collectReviewEvidence(
  prNumber: string,
  repoDir: string,
): { reviewRounds: number; changeRequests: number } | null {
  if (!/^\d+$/.test(prNumber) || !isExistingDir(repoDir)) return null;
  const result = execArgvCommand(
    'gh',
    ['pr', 'view', prNumber, '--json', 'reviews'],
    { cwd: repoDir, timeout: 15_000, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.failed || result.exitCode !== 0 || !result.stdout.trim()) return null;
  let reviews: Array<{ state?: string; submittedAt?: string }>;
  try {
    const parsed = JSON.parse(result.stdout) as { reviews?: unknown };
    reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  } catch {
    return null;
  }
  if (reviews.length === 0) return { reviewRounds: 0, changeRequests: 0 };
  const roundHours = new Set<number>();
  let changeRequests = 0;
  for (const review of reviews) {
    if (typeof review.submittedAt === 'string') {
      const time = new Date(review.submittedAt).getTime();
      if (Number.isFinite(time)) roundHours.add(Math.floor(time / (1000 * 60 * 60)));
    }
    if ((review.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
      changeRequests += 1;
    }
  }
  return { reviewRounds: roundHours.size, changeRequests };
}

function deriveIntent(
  contract: CandidateFeatureContract | undefined,
  diffStats: DiffStats | null,
): Pick<
  CandidateFeaturesV1,
  | 'task_type'
  | 'language'
  | 'domain'
  | 'complexity'
  | 'repo_size_bucket'
  | 'files_touched_bucket'
  | 'description_length_bucket'
  | 'is_greenfield'
  | 'is_migration'
  | 'requires_tests'
  | 'cross_service'
  | 'ui_heavy'
  | 'risk_level'
> {
  if (!contract) return nullIntent();
  const descriptor = deriveTaskDescriptor({
    taskText: contract.taskText,
    repositorySignals: contract.repositorySignals,
  });
  const intent = nullIntent();

  intent.task_type = normalizeTaskType(contract.intent?.task_type ?? descriptor.task_type);
  intent.language = normalizeLanguage(contract.intent?.language ?? descriptor.language);
  intent.domain = normalizeDomain(contract.intent?.domain);
  intent.complexity = normalizeComplexityValue(contract.intent?.complexity ?? descriptor.complexity);
  intent.repo_size_bucket = normalizeRepoSizeBucket(contract.intent?.repo_size_bucket ?? descriptor.repo_size_bucket);
  intent.files_touched_bucket = normalizeFilesTouchedBucket(
    contract.intent?.files_touched_bucket ?? bucketFilesTouched(diffStats?.filesTouched),
  );
  intent.description_length_bucket = normalizeDescriptionLengthBucket(
    contract.intent?.description_length_bucket ?? bucketDescription(contract.taskText),
  );
  intent.is_greenfield = normalizeBoolean(contract.intent?.is_greenfield);
  intent.is_migration = normalizeBoolean(contract.intent?.is_migration);
  intent.requires_tests = normalizeBoolean(contract.intent?.requires_tests);
  intent.cross_service = normalizeBoolean(contract.intent?.cross_service);
  intent.ui_heavy = normalizeBoolean(contract.intent?.ui_heavy);
  intent.risk_level = normalizeRiskLevel(contract.intent?.risk_level);
  return intent;
}

function nullIntent(): Pick<
  CandidateFeaturesV1,
  | 'task_type'
  | 'language'
  | 'domain'
  | 'complexity'
  | 'repo_size_bucket'
  | 'files_touched_bucket'
  | 'description_length_bucket'
  | 'is_greenfield'
  | 'is_migration'
  | 'requires_tests'
  | 'cross_service'
  | 'ui_heavy'
  | 'risk_level'
> {
  return {
    task_type: null,
    language: null,
    domain: null,
    complexity: null,
    repo_size_bucket: null,
    files_touched_bucket: null,
    description_length_bucket: null,
    is_greenfield: null,
    is_migration: null,
    requires_tests: null,
    cross_service: null,
    ui_heavy: null,
    risk_level: null,
  };
}

function collectTouchedOutOfScopeFiles(
  diffStats: DiffStats | null,
  contract: CandidateFeatureContract | undefined,
): number | null {
  if (!diffStats || !contract?.scope) return null;
  const allowedFiles = new Set((contract.scope.allowedFiles ?? []).map(normalizeRepoPath).filter(Boolean));
  const allowedPrefixes = (contract.scope.allowedPrefixes ?? [])
    .map(normalizeRepoPath)
    .filter((path): path is string => Boolean(path))
    .map((path) => path.endsWith('/') ? path : `${path}/`);
  if (allowedFiles.size === 0 && allowedPrefixes.length === 0) return null;

  let outOfScope = 0;
  for (const file of diffStats.changedFiles) {
    const normalized = normalizeRepoPath(file);
    if (!normalized) {
      outOfScope += 1;
      continue;
    }
    const allowed = allowedFiles.has(normalized)
      || allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
    if (!allowed) outOfScope += 1;
  }
  return outOfScope;
}

function normalizeRepoPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
}

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeTaskType(value: unknown): CandidateTaskType | null {
  if (value === 'test') return 'tests';
  return typeof value === 'string' && TASK_TYPES.has(value as CandidateTaskType)
    ? value as CandidateTaskType
    : null;
}

function normalizeLanguage(value: unknown): CandidateLanguage | null {
  return typeof value === 'string' && LANGUAGES.has(value as CandidateLanguage)
    ? value as CandidateLanguage
    : null;
}

function normalizeDomain(value: unknown): CandidateDomain | null {
  if (value === 'full-stack') return 'fullstack';
  if (value === 'infrastructure' || value === 'devtools') return 'devops';
  if (value === 'data-pipeline') return 'data';
  return typeof value === 'string' && DOMAINS.has(value as CandidateDomain)
    ? value as CandidateDomain
    : null;
}

function normalizeComplexityValue(value: unknown): number | null {
  const normalized = normalizeComplexity(
    typeof value === 'string' || typeof value === 'number' ? value : undefined,
  );
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return null;
  return Math.max(0, Math.min(10, normalized));
}

function normalizeRepoSizeBucket(value: unknown): CandidateRepoSizeBucket | null {
  return typeof value === 'string' && REPO_SIZE_BUCKETS.has(value as CandidateRepoSizeBucket)
    ? value as CandidateRepoSizeBucket
    : null;
}

function normalizeFilesTouchedBucket(value: unknown): CandidateFilesTouchedBucket | null {
  return typeof value === 'string' && FILES_TOUCHED_BUCKETS.has(value as CandidateFilesTouchedBucket)
    ? value as CandidateFilesTouchedBucket
    : null;
}

function normalizeDescriptionLengthBucket(value: unknown): CandidateDescriptionLengthBucket | null {
  return typeof value === 'string' && DESCRIPTION_LENGTH_BUCKETS.has(value as CandidateDescriptionLengthBucket)
    ? value as CandidateDescriptionLengthBucket
    : null;
}

function normalizeRiskLevel(value: unknown): CandidateRiskLevel | null {
  return typeof value === 'string' && RISK_LEVELS.has(value as CandidateRiskLevel)
    ? value as CandidateRiskLevel
    : null;
}

function bucketFilesTouched(count: number | null | undefined): CandidateFilesTouchedBucket | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 15) return '6_15';
  return '16_plus';
}

function bucketDescription(taskText: string | undefined): CandidateDescriptionLengthBucket | null {
  const trimmed = taskText?.trim();
  if (!trimmed) return null;
  const tokens = Math.ceil(trimmed.length / 4);
  if (tokens < 50) return 'short';
  if (tokens < 200) return 'medium';
  return 'long';
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): string | null {
  const result = execArgvCommand(
    'git',
    args,
    { cwd, timeout: 30_000, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.failed) return null;
  if (result.exitCode !== 0 && !options.allowFailure) return null;
  if (result.exitCode !== 0 && options.allowFailure) return null;
  return result.stdout.trimEnd();
}
