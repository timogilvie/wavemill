import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { buildTaskContract, type TaskContractField } from './task-contract.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  detectCrossPrReverts,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
  type CrossPrRevertFinding,
} from './cross-pr-revert-detector.ts';
import {
  INTEGRATION_DEFAULTS,
  getIntegrationConfig,
  getReviewMergeConfig,
  loadWavemillConfig,
} from './config.ts';
import { resolveDefaultBaseRef } from './git-base-resolver.ts';

type ShellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;

export const REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE =
  'No review commit may be created until every out-of-scope staged path is unstaged or reverted.';

/**
 * Remediation for violations that live in committed history rather than the
 * index. Telling the operator to "unstage" a committed path is an impossible
 * instruction on a clean index (HOK-2913) — the applicable actions are
 * reverting the offending commit or restoring the scoped file state.
 */
export const REVIEW_SCOPE_GUARD_COMMITTED_REMEDY_MESSAGE =
  'Out-of-scope changes are already committed on this branch (there is nothing staged to unstage): '
  + 'revert the offending commit(s) or restore the scoped file state before any further review progress.';

export const REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE =
  'No review commit may be created because the review scope guard could not verify staged scope.';

/**
 * Printed when scope passed but no PR exists for the branch yet. This is the
 * normal pre-PR state, never a policy violation: review-fix commits and PR
 * creation may proceed exactly as for a plain pass.
 */
export const REVIEW_SCOPE_GUARD_NO_PR_MESSAGE =
  'No PR exists for this branch yet (normal before PR creation — not a policy violation). '
  + 'Scope was fully evaluated; review-fix commits and PR creation may proceed.';

export const REVIEW_SCOPE_GUARD_EXIT_OK = 0;
export const REVIEW_SCOPE_GUARD_EXIT_POLICY = 1;
export const REVIEW_SCOPE_GUARD_EXIT_TOOL = 2;
/** Scope passed but no PR exists for the branch yet — proceed as for exit 0. */
export const REVIEW_SCOPE_GUARD_EXIT_NO_PR = 3;

/**
 * Registration files that a task may touch as a companion to a legitimate
 * test companion. `CLAUDE.md` mandates registering every new test in these
 * runner arrays, so they are permitted — but only when at least one in-scope
 * test companion is part of the same change set.
 */
const REGISTRATION_COMPANIONS = new Set([
  'tests/run-unit-tests.sh',
  'tests/run-shell-suite.sh',
]);

const TEST_COMPANION_PATTERN = /^(?<base>.+)\.(?:test|spec)\.(?<ext>ts|tsx|js|jsx|mjs|cjs|sh)$/;

export interface ReviewScopeGuardFinding {
  severity: 'blocker' | 'warning';
  /**
   * Machine-readable discriminant so callers can react differently to the
   * three failure classes without parsing messages:
   * - 'violation': positive evidence of an out-of-scope change (unexpected
   *   path, exceeded deletion budget, unacknowledged cross-PR revert).
   * - 'missing-authority': a scope authority (feature directory, baseline
   *   artifact, declared Files to Modify) could not be resolved, so the
   *   corresponding check could not run. Not evidence of a violation.
   * - 'error': infrastructure failure (git/contract collection threw); the
   *   check ran but could not complete, so its result is unknown.
   *
   * HOK-2887 derives scope from git merge-base, so 'missing-authority' should
   * now be rare -- but the distinction is kept because collapsing it into a
   * blocker is what stalled HOK-2884 for 18 hours (HOK-2889).
   */
  kind?: 'violation' | 'missing-authority' | 'error';
  /**
   * Where the offending change was observed. Drives remediation wording:
   * 'staged'/'working-tree' violations can be unstaged or reverted in place;
   * 'committed' violations already live in branch history, where "unstage" is
   * an impossible instruction (HOK-2913).
   */
  observedIn?: 'staged' | 'working-tree' | 'committed';
  category: 'review-scope' | 'deletion-budget' | 'cross-pr-revert';
  path?: string;
  status?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReviewScopeGuardToolError {
  commandClass: string;
  command: string;
  exitCode?: number;
  stderr: string;
}

export interface ReviewScopeGuardResult {
  /** True only when status is 'pass'. Kept for existing consumers. */
  ok: boolean;
  /**
   * Three-way outcome: 'pass' (no policy violations), 'fail' (at least one
   * blocker finding), 'error' (the guard could not verify scope — a tool or
   * git failure, never to be treated as a pass OR as a policy violation).
   */
  status: 'pass' | 'fail' | 'error';
  baselinePaths: string[];
  declaredScope: string[];
  baselineSource: string;
  /**
   * True only when a persisted baseline artifact supplied the scope. The
   * git-derived merge-base fallback also populates `baselineSource`, so that
   * string cannot be used to decide whether real scope authority exists.
   */
  baselineIsArtifact: boolean;
  featureDir: string | null;
  /** Integration ref used to derive the merge base. */
  integrationRef: string;
  /** Merge base between the integration ref and headRef (null on error). */
  mergeBase: string | null;
  /** Files this task has already touched (diff mergeBase..headRef). */
  taskPaths: string[];
  /** Files currently staged in the index. */
  stagedPaths: string[];
  /** Staged/working-tree companions admitted by the companion allowlist. */
  allowedCompanionPaths: string[];
  /** Paths that produced review-scope blocker findings. */
  outOfScopePaths: string[];
  findings: ReviewScopeGuardFinding[];
  crossPrReverts: CrossPrRevertFinding[];
  /**
   * Outcome of the branch PR lookup (REQ-F5, HOK-2913): 'found' when `gh pr
   * view` resolved a PR, 'none' when gh positively reported no PR for the
   * branch, 'unavailable' when the lookup could not run (gh missing, no
   * remote, network failure). Never influences pass/fail — "no PR yet" is the
   * normal pre-PR state, not a policy violation.
   */
  prLookup?: 'found' | 'none' | 'unavailable';
  /** PR number when prLookup is 'found'. */
  prNumber?: number | null;
  /** Human-readable one-line outcome summary. */
  message: string;
  /** Populated only when status is 'error'. */
  toolError?: ReviewScopeGuardToolError;
}

export interface ReviewScopeGuardOptions {
  repoDir: string;
  featureDir?: string;
  sinceCommit?: string;
  sinceCommitSource?: 'launch-base' | 'explicit';
  baseRef?: string;
  headRef?: string;
  /** Explicit integration ref override for merge-base derivation. */
  integrationRef?: string;
  includeWorkingTree?: boolean;
  acknowledgementText?: string;
  maxRecentMerges?: number;
  writeBaseline?: boolean;
  shellRunner?: ShellRunner;
}

interface NameStatusEntry {
  status: string;
  path: string;
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

export interface ReviewScopeBaseline {
  version: 1;
  createdAt: string;
  source: string;
  sinceCommit: string;
  headRef: string;
  paths: string[];
  provenance?: ReviewScopeBaselineProvenance;
  baseRef?: string;
}

export type ReviewScopeBaselineProvenance =
  | 'launch-base'
  | 'remote-merge-base'
  | 'local-merge-base-fallback'
  | 'explicit-since-commit';

const BASELINE_FILE = '.review-scope-baseline.json';
const DEFAULT_DELETION_RATIO = 3;
const DEFAULT_DELETION_FLOOR = 50;

export const reviewScopeGuardDeps = {
  buildTaskContract,
  detectCrossPrReverts,
  execShellCommand,
};

/**
 * Raised when a git/tool invocation on the scope-resolution critical path
 * fails. Distinct from a policy violation: callers surface it as "scope is
 * unverified" (exit 2), never as a pass and never as an out-of-scope finding.
 */
class ReviewScopeGuardToolFailure extends Error {
  readonly toolError: ReviewScopeGuardToolError;

  constructor(toolError: ReviewScopeGuardToolError) {
    super(toolError.stderr || `${toolError.commandClass} failed`);
    this.toolError = toolError;
  }
}

/**
 * Validate that review-iteration changes stay within task scope.
 *
 * Scope is layered from every available signal (HOK-2887):
 *
 * - **Git-derived task paths** (always computed, no configuration needed):
 *   the merge base against the integration ref defines "files this task has
 *   already touched". This is the fallback that makes the guard evaluate in
 *   any worktree, with no task packet and no baseline artifact.
 * - **Baseline artifact paths** where a featureDir + baseline resolve; when a
 *   baseline exists it *narrows* the committed-diff check back to the
 *   task-owned set (the original #1242 behavior).
 * - **Declared scope matchers** from the task contract, where available —
 *   this is what still admits a legitimately new, packet-declared file.
 * - **Companion allowlist**: `foo.test.ts` when `foo.ts` is in scope, and
 *   only then the test-registration runner files.
 *
 * The staged index is where the git-derived scope bites: staged paths are not
 * yet in HEAD, so an out-of-scope staged change is refused *before* a commit
 * exists (the HOK-2880/#1243 failure was remediation after the commit).
 *
 * Git failures on the critical path (the staged index, or scope derivation
 * when no baseline/declared-scope fallback exists) return `status: 'error'`
 * with a `toolError` — unverified is never reported as a pass or as a
 * violation. When git-derived scope fails but a baseline or declared scope is
 * available, the guard degrades to those signals and notes it as a warning.
 */
export function validateReviewScope(options: ReviewScopeGuardOptions): ReviewScopeGuardResult {
  const repoDir = resolve(options.repoDir);
  const shellRunner = options.shellRunner ?? reviewScopeGuardDeps.execShellCommand;
  const headRef = options.headRef ?? 'HEAD';
  const findings: ReviewScopeGuardFinding[] = [];
  let integrationRef = options.integrationRef?.trim() || INTEGRATION_DEFAULTS.integrationBranch;

  try {
    // ── Staged index (critical path — failures are tool errors) ──
    const stagedPaths = normalizeGitPaths(
      splitNullDelimited(runGitChecked(
        shellRunner,
        repoDir,
        'git diff --cached --name-only -z',
        'git-diff-staged',
      )),
      'staged index',
    );

    // ── Git-derived scope: merge base against the integration ref ──
    // Best-effort when other scope signals exist; a failure here is only
    // fatal (status 'error') when no baseline/declared scope can stand in.
    let mergeBase: string | null = null;
    let taskPaths: string[] = [];
    let gitScopeFailure: ReviewScopeGuardToolFailure | null = null;
    try {
      integrationRef = resolveIntegrationRef(repoDir, options.integrationRef);
      mergeBase = runGitChecked(
        shellRunner,
        repoDir,
        `git merge-base ${escapeShellArg(integrationRef)} ${escapeShellArg(headRef)}`,
        'git-merge-base',
      ).trim();
      if (!mergeBase) {
        throw new ReviewScopeGuardToolFailure({
          commandClass: 'git-merge-base',
          command: `git merge-base ${integrationRef} ${headRef}`,
          stderr: `git merge-base returned an empty merge base for ${integrationRef} and ${headRef}`,
        });
      }
      taskPaths = normalizeGitPaths(
        splitNullDelimited(runGitChecked(
          shellRunner,
          repoDir,
          `git diff --name-only -z ${escapeShellArg(mergeBase)} ${escapeShellArg(headRef)}`,
          'git-diff-task-scope',
        )),
        'task scope',
      );
    } catch (error) {
      if (!(error instanceof ReviewScopeGuardToolFailure)) {
        throw error;
      }
      gitScopeFailure = error;
      mergeBase = null;
      taskPaths = [];
    }

    // ── Optional narrowing signals (featureDir / baseline / declared scope) ──
    const featureDir = resolveFeatureDir(repoDir, options.featureDir, shellRunner);
    const declaredScope = featureDir ? loadDeclaredScope(featureDir, findings) : [];
    const baseline = featureDir
      ? loadOrCreateBaseline({
        repoDir,
        featureDir,
        sinceCommit: options.sinceCommit,
        sinceCommitSource: options.sinceCommitSource,
        headRef,
        writeBaseline: options.writeBaseline ?? true,
        shellRunner,
      })
      : null;
    const baselinePaths = baseline?.paths ?? [];

    if (gitScopeFailure) {
      // No fallback signal at all: scope is genuinely unverifiable.
      if (!baseline && declaredScope.length === 0) {
        throw gitScopeFailure;
      }
      findings.push({
        severity: 'warning',
        category: 'review-scope',
        kind: 'error',
        message:
          'Git-derived task scope is unavailable ' +
          `(${gitScopeFailure.toolError.commandClass}: ${gitScopeFailure.toolError.stderr}); ` +
          'evaluating against the task baseline and declared scope only.',
      });
    }

    const baseRef = options.baseRef ?? options.sinceCommit ?? baseline?.sinceCommit ?? mergeBase ?? null;
    const baselineSource = baseline?.source
      ?? (mergeBase ? `git merge-base ${integrationRef} (${mergeBase})` : 'unresolved');

    const taskPathSet = new Set(taskPaths);
    const baselineSet = new Set(baselinePaths);
    const scopeMatchers = buildScopeMatchers(declaredScope);

    // When a baseline artifact exists it defines the committed-diff scope
    // (task-owned files recorded before review iterations); without one, the
    // git-derived task paths are the scope — which makes the committed check
    // pass by construction and leaves enforcement to the staged-index check.
    const committedScopeSet = baseline ? baselineSet : taskPathSet;

    const includeWorkingTree = options.includeWorkingTree ?? false;
    const committedEntries = baseRef
      ? collectCommittedEntries(repoDir, baseRef, headRef, shellRunner)
      : [];
    // Never []: with no baseline the committed check passes by construction, so
    // dropping the staged index too would leave the guard with nothing to
    // evaluate and every branch would pass unconditionally (HOK-2884).
    const uncommittedEntries = includeWorkingTree
      ? collectUncommittedEntries(repoDir, stagedPaths, shellRunner)
      : collectStagedEntries(repoDir, stagedPaths, shellRunner);

    const isInScope = (path: string): boolean =>
      taskPathSet.has(path)
      || baselineSet.has(path)
      || scopeMatchers.some((matcher) => matcher(path));
    const companionCandidates = [
      ...new Set([...stagedPaths, ...uncommittedEntries.map((entry) => entry.path)]),
    ];
    const allowedCompanionPaths = findAllowedCompanionPaths(companionCandidates, isInScope);
    const companionSet = new Set(allowedCompanionPaths);

    // When the packet declares "Files to Modify" and no baseline artifact
    // overrides it, that declaration governs the committed diff. Falling back
    // to `committedScopeSet` (the git-derived task paths) would admit every
    // committed path by construction and make the declaration unenforceable —
    // the fail-open at the heart of HOK-2884. Companion and support-file
    // allowances still apply, and support-file derivation keeps using the
    // git-derived set so test/fixture companions are not over-blocked.
    const declaredGovernsCommitted = declaredScope.length > 0 && !baseline;

    // Wavemill's own task context is never product code and is never listed in
    // "Files to Modify", so a declared scope must not turn the task's packet,
    // baseline, or repo config into out-of-scope violations.
    const featureDirRel = featureDir
      ? relative(repoDir, featureDir).split(sep).join('/')
      : null;
    const isTaskContextPath = (path: string): boolean =>
      path.startsWith('.wavemill/')
      || path.startsWith('.wavemill-config.')
      || path === '.wavemill-config.json'
      || (featureDirRel !== null
        && featureDirRel !== ''
        && !featureDirRel.startsWith('..')
        && (path === featureDirRel || path.startsWith(`${featureDirRel}/`)));

    const allowedCommitted = (path: string): boolean =>
      (declaredGovernsCommitted ? false : committedScopeSet.has(path))
      || scopeMatchers.some((matcher) => matcher(path))
      || companionSet.has(path)
      || isTaskContextPath(path)
      || isSupportFile(path, committedScopeSet);
    const allowedUncommitted = (path: string): boolean =>
      allowedCommitted(path) || taskPathSet.has(path) || baselineSet.has(path);

    const stagedPathSet = new Set(stagedPaths);
    const outOfScope = new Map<string, NameStatusEntry & { observedIn: 'staged' | 'working-tree' | 'committed' }>();
    // Uncommitted entries first: a path that is both committed and re-staged
    // still has an index-level remedy, so the staged classification wins.
    for (const entry of uncommittedEntries) {
      if (!allowedUncommitted(entry.path)) {
        outOfScope.set(entry.path, {
          ...entry,
          observedIn: stagedPathSet.has(entry.path) ? 'staged' : 'working-tree',
        });
      }
    }
    for (const entry of committedEntries) {
      if (!outOfScope.has(entry.path) && !allowedCommitted(entry.path)) {
        outOfScope.set(entry.path, { ...entry, observedIn: 'committed' });
      }
    }

    for (const entry of [...outOfScope.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      findings.push({
        severity: 'blocker',
        category: 'review-scope',
        path: entry.path,
        status: entry.status,
        kind: 'violation',
        observedIn: entry.observedIn,
        message:
          `Unexpected review change outside task scope: ${entry.path} (${entry.status}, ${entry.observedIn}). ` +
          `Baseline source: ${baselineSource}.`,
        details: {
          baselineSource,
          declaredScope,
        },
      });
    }

    if (baseRef) {
      findings.push(...collectDeletionBudgetFindings(
        repoDir,
        baseRef,
        headRef,
        committedScopeSet,
        shellRunner,
      ));
    }

    // ── Branch PR lookup (REQ-F5) — informational, never pass/fail ──
    // "No PR yet" is the normal pre-PR review state; it is surfaced as a
    // distinct outcome (exit 3 in the CLI), never folded into the blocking
    // path. The lookup result also supplies the acknowledgement text so gh is
    // consulted once.
    const prLookup = lookupBranchPr(repoDir, shellRunner);

    const crossPrReverts = baseRef
      ? collectCrossPrReverts({
        repoDir,
        baseRef,
        headRef,
        integrationRef,
        acknowledgementText: options.acknowledgementText ?? prLookup.acknowledgementText,
        maxRecentMerges: options.maxRecentMerges,
        shellRunner,
        findings,
      })
      : [];

    for (const revert of crossPrReverts) {
      findings.push({
        severity: 'blocker',
        category: 'cross-pr-revert',
        kind: 'violation' as const,
        observedIn: 'committed',
        message:
          `This branch appears to revert changes from PR #${revert.prNumber}` +
          `${revert.title ? ` (${revert.title})` : ''}. ` +
          `Acknowledge with "Reverts #${revert.prNumber}" only when intentional.`,
        details: {
          prNumber: revert.prNumber,
          files: revert.files,
          mergeCommit: revert.mergeCommit,
        },
      });
    }

    const outOfScopePaths = [...outOfScope.keys()].sort();
    const blockers = findings.filter((finding) => finding.severity === 'blocker');
    const failed = blockers.length > 0;

    return {
      ok: !failed,
      status: failed ? 'fail' : 'pass',
      baselinePaths,
      declaredScope,
      baselineSource,
      baselineIsArtifact: baseline !== null,
      featureDir,
      integrationRef,
      mergeBase,
      taskPaths,
      stagedPaths,
      allowedCompanionPaths,
      outOfScopePaths,
      findings,
      crossPrReverts,
      prLookup: prLookup.lookup,
      prNumber: prLookup.prNumber,
      message: failed
        ? selectFailureRemedyMessage(blockers)
        : 'Review scope guard passed: every changed path is in task scope or an allowed companion.',
    };
  } catch (error) {
    const toolError = error instanceof ReviewScopeGuardToolFailure
      ? error.toolError
      : {
        commandClass: 'internal',
        command: 'review-scope-guard',
        stderr: error instanceof Error ? error.message : String(error),
      };
    return {
      ok: false,
      status: 'error',
      baselinePaths: [],
      declaredScope: [],
      baselineSource: 'unresolved',
      baselineIsArtifact: false,
      featureDir: null,
      integrationRef,
      mergeBase: null,
      taskPaths: [],
      stagedPaths: [],
      allowedCompanionPaths: [],
      outOfScopePaths: [],
      findings: [],
      crossPrReverts: [],
      prLookup: 'unavailable',
      prNumber: null,
      message: REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
      toolError,
    };
  }
}

/**
 * Pick the remediation sentence(s) matching where the blocking findings were
 * actually observed (REQ-F3, HOK-2913). "Unstage" is only ever instructed when
 * a staged/working-tree violation exists; violations that live in committed
 * history get an action that is possible on a clean index.
 */
function selectFailureRemedyMessage(blockers: ReviewScopeGuardFinding[]): string {
  const hasIndexBlocker = blockers.some(
    (finding) => finding.observedIn === 'staged' || finding.observedIn === 'working-tree',
  );
  const hasCommittedBlocker = blockers.some(
    (finding) => finding.observedIn !== 'staged' && finding.observedIn !== 'working-tree',
  );
  const parts = [
    hasIndexBlocker ? REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE : null,
    hasCommittedBlocker ? REVIEW_SCOPE_GUARD_COMMITTED_REMEDY_MESSAGE : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE;
}

interface BranchPrLookup {
  lookup: 'found' | 'none' | 'unavailable';
  prNumber: number | null;
  /** PR title + body for revert acknowledgements; undefined when no PR resolved. */
  acknowledgementText?: string;
}

/**
 * Look up the PR for the current branch once. gh's stderr is folded into the
 * captured output so "no pull requests found" is classified instead of
 * leaking into the guard's report as if it were a finding (HOK-2913).
 */
function lookupBranchPr(repoDir: string, shellRunner: ShellRunner): BranchPrLookup {
  try {
    const output = String(shellRunner(
      'gh pr view --json number,title,body 2>&1',
      { cwd: repoDir, encoding: 'utf-8' },
    ));
    const parsed = JSON.parse(output) as { number?: unknown; title?: unknown; body?: unknown };
    if (typeof parsed.number !== 'number') {
      return { lookup: 'unavailable', prNumber: null };
    }
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    const body = typeof parsed.body === 'string' ? parsed.body : '';
    return { lookup: 'found', prNumber: parsed.number, acknowledgementText: `${title}\n${body}` };
  } catch (error) {
    const execError = error as { stdout?: unknown; stderr?: unknown; message?: string };
    const text = [execError.stdout, execError.stderr, execError.message]
      .map((chunk) => (chunk instanceof Buffer ? chunk.toString('utf-8') : typeof chunk === 'string' ? chunk : ''))
      .join('\n');
    if (/no pull requests found/i.test(text)) {
      return { lookup: 'none', prNumber: null };
    }
    return { lookup: 'unavailable', prNumber: null };
  }
}

/**
 * Resolve the integration ref used for merge-base derivation.
 *
 * Precedence: explicit option → configured `integration.integrationBranch`
 * (or `mill.baseBranch`) → the repository's default base ref when no wavemill
 * config file exists at all. When a config file explicitly names an
 * integration branch, a missing local ref is an honest tool error rather than
 * a silent fallback to `main`.
 */
/**
 * Report whether `ref` names a commit reachable in this repository, checking
 * the bare name and its `origin/` counterpart. Used to reject a configured
 * default-branch name that does not exist in the checkout at hand.
 */
function refExists(repoDir: string, ref: string): boolean {
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      reviewScopeGuardDeps.execShellCommand(
        `git rev-parse --verify --quiet ${candidate}^{commit}`,
        { cwd: repoDir, encoding: 'utf-8' },
      );
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

function resolveIntegrationRef(repoDir: string, explicitIntegrationRef: string | undefined): string {
  if (explicitIntegrationRef?.trim()) {
    return explicitIntegrationRef.trim();
  }

  const rawConfig = loadWavemillConfig(repoDir);
  const integrationConfig = getIntegrationConfig(repoDir);
  const hasLocalConfigFile = existsSync(join(repoDir, '.wavemill-config.json'))
    || existsSync(join(repoDir, '.wavemill-config.local.json'));

  if (
    integrationConfig.integrationBranch === INTEGRATION_DEFAULTS.integrationBranch
    && !rawConfig.integration?.integrationBranch
    && !hasLocalConfigFile
  ) {
    // `resolveDefaultBaseRef` can fall back to `init.defaultBranch` (commonly
    // "main"), which is a *name*, not a guarantee that the ref exists here.
    // Handing an unresolvable ref to merge-base turns every downstream check
    // into an infrastructure error, so only take it if it actually resolves.
    const probed = resolveDefaultBaseRef(repoDir);
    if (probed && refExists(repoDir, probed)) {
      return probed;
    }
    return integrationConfig.integrationBranch;
  }

  return integrationConfig.integrationBranch;
}

interface ResolvedBaselineBase {
  sinceCommit: string;
  provenance: ReviewScopeBaselineProvenance;
  baseRef?: string;
}

function validateSinceCommit(input: {
  repoDir: string;
  sinceCommit: string;
  headRef: string;
  source: 'launch-base' | 'explicit';
  shellRunner: ShellRunner;
}): ResolvedBaselineBase {
  const label = input.source === 'launch-base' ? 'recorded launch base' : 'explicit since commit';
  const sinceCommit = input.sinceCommit.trim();
  if (!commitExists(input.repoDir, sinceCommit, input.shellRunner)) {
    throw new Error(
      `review-scope baseline: ${label} ${sinceCommit} could not be resolved as a commit; refusing to widen scope`,
    );
  }
  if (!isAncestor(input.repoDir, sinceCommit, input.headRef, input.shellRunner)) {
    throw new Error(
      `review-scope baseline: ${label} ${sinceCommit} is not an ancestor of ${input.headRef}; refusing to widen scope`,
    );
  }
  return {
    sinceCommit,
    provenance: input.source === 'launch-base' ? 'launch-base' : 'explicit-since-commit',
    baseRef: sinceCommit,
  };
}

function resolveBaselineBase(input: {
  repoDir: string;
  sinceCommit?: string;
  sinceCommitSource?: 'launch-base' | 'explicit';
  headRef: string;
  integrationRef?: string;
  shellRunner: ShellRunner;
}): ResolvedBaselineBase {
  const sinceCommit = input.sinceCommit?.trim();
  if (sinceCommit) {
    return validateSinceCommit({
      repoDir: input.repoDir,
      sinceCommit,
      headRef: input.headRef,
      source: input.sinceCommitSource ?? 'explicit',
      shellRunner: input.shellRunner,
    });
  }

  const resolvedRef = resolveIntegrationBaseRef(input.repoDir, input.integrationRef, input.shellRunner);
  const mergeBase = runGitChecked(
    input.shellRunner,
    input.repoDir,
    `git merge-base ${escapeShellArg(resolvedRef.ref)} ${escapeShellArg(input.headRef)}`,
    'git-merge-base',
  ).trim();
  if (!mergeBase) {
    throw new Error(`git merge-base returned an empty base for ${resolvedRef.ref} and ${input.headRef}`);
  }
  return {
    sinceCommit: mergeBase,
    provenance: resolvedRef.kind === 'remote' ? 'remote-merge-base' : 'local-merge-base-fallback',
    baseRef: resolvedRef.ref,
  };
}

function resolveIntegrationBaseRef(
  repoDir: string,
  explicitIntegrationRef: string | undefined,
  shellRunner: ShellRunner,
): { ref: string; kind: 'remote' | 'local' } {
  const integrationRef = resolveIntegrationRef(repoDir, explicitIntegrationRef);
  if (isRemoteIntegrationRef(integrationRef)) {
    return { ref: integrationRef, kind: 'remote' };
  }

  const remoteRef = `origin/${stripLocalBranchPrefix(integrationRef)}`;
  bestEffortFetch(repoDir, stripLocalBranchPrefix(integrationRef), shellRunner);
  if (commitExists(repoDir, remoteRef, shellRunner)) {
    return { ref: remoteRef, kind: 'remote' };
  }

  return { ref: integrationRef, kind: 'local' };
}

function isRemoteIntegrationRef(ref: string): boolean {
  return ref.startsWith('origin/') || ref.startsWith('refs/remotes/origin/');
}

function stripLocalBranchPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^origin\//, '').replace(/^refs\/remotes\/origin\//, '');
}

function commitExists(repoDir: string, ref: string, shellRunner: ShellRunner): boolean {
  try {
    runGit(shellRunner, repoDir, `git rev-parse --verify --quiet ${escapeShellArg(`${ref}^{commit}`)}`);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(repoDir: string, ancestor: string, descendant: string, shellRunner: ShellRunner): boolean {
  try {
    runGit(shellRunner, repoDir, `git merge-base --is-ancestor ${escapeShellArg(ancestor)} ${escapeShellArg(descendant)}`);
    return true;
  } catch {
    return false;
  }
}

function bestEffortFetch(repoDir: string, branch: string, shellRunner: ShellRunner): boolean {
  const trimmedBranch = branch.trim();
  if (!trimmedBranch || trimmedBranch.includes('..') || trimmedBranch.startsWith('-')) {
    return false;
  }
  try {
    runGit(
      shellRunner,
      repoDir,
      `if command -v timeout >/dev/null 2>&1; then timeout 10s git fetch --quiet origin ${escapeShellArg(trimmedBranch)} 2>/dev/null; else false; fi`,
    );
    return true;
  } catch {
    return false;
  }
}


/**
 * Resolve the feature directory owning the current task.
 *
 * Resolution order:
 * 1. `explicit` — returned as-is (resolved to an absolute path) with no
 *    existence check, preserving the historical semantics for callers that
 *    already know the directory.
 * 2. `WAVEMILL_FEATURE_DIR` env var, when it points at an existing directory.
 * 3. `WAVEMILL_FEATURE_SLUG` / `WAVEMILL_SLUG` env vars (exported by the mill
 *    into every agent shell), joined under `features/` then `bugs/` in
 *    `repoDir`; the first existing candidate wins. This keeps scope resolvable
 *    on detached HEAD (e.g. mid-rebase) where branch derivation fails.
 * 4. Branch-name derivation: `task|feature|bugfix|bug/<slug>` mapped to
 *    `features/<slug>` then `bugs/<slug>` under `repoDir`.
 *
 * Every derived (non-explicit) candidate must exist on disk, so stale env vars
 * from another task cannot resolve to a directory this worktree does not have.
 *
 * @returns Absolute path to the feature directory, or null when none resolves.
 */
export function resolveTaskFeatureDir(
  repoDir: string,
  explicit?: string,
  shellRunner: ShellRunner = reviewScopeGuardDeps.execShellCommand,
): string | null {
  const resolvedRepoDir = resolve(repoDir);
  if (explicit) {
    return resolve(explicit);
  }

  const envDir = process.env.WAVEMILL_FEATURE_DIR;
  if (envDir) {
    const candidate = resolve(envDir);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const slug of [process.env.WAVEMILL_FEATURE_SLUG, process.env.WAVEMILL_SLUG]) {
    if (!slug) {
      continue;
    }
    for (const root of ['features', 'bugs']) {
      const candidate = join(resolvedRepoDir, root, slug);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  let branch = '';
  try {
    branch = runGit(shellRunner, resolvedRepoDir, 'git rev-parse --abbrev-ref HEAD').trim();
  } catch {
    return null;
  }
  const match = branch.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return null;
  }

  for (const root of ['features', 'bugs']) {
    const candidate = join(resolvedRepoDir, root, match[1]);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Whether `repoDir` looks like a wavemill-managed task workspace: it has a
 * `features/` or `bugs/` root. Callers use this to distinguish "scope-less
 * repo, degrade gracefully" from "task workspace where an unresolvable feature
 * directory is a configuration error".
 */
export function hasTaskWorkspaceRoots(repoDir: string): boolean {
  const resolvedRepoDir = resolve(repoDir);
  return ['features', 'bugs'].some((root) => existsSync(join(resolvedRepoDir, root)));
}

function resolveFeatureDir(repoDir: string, explicit: string | undefined, shellRunner: ShellRunner): string | null {
  if (explicit) {
    return resolve(explicit);
  }

  let branch = '';
  try {
    branch = runGit(shellRunner, repoDir, 'git rev-parse --abbrev-ref HEAD').trim();
  } catch {
    return null;
  }
  const match = branch.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return null;
  }

  for (const root of ['features', 'bugs']) {
    const candidate = join(repoDir, root, match[1]);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadDeclaredScope(featureDir: string, findings: ReviewScopeGuardFinding[]): string[] {
  try {
    const { contract } = reviewScopeGuardDeps.buildTaskContract({ featureDir });
    return normalizeScopeEntries(contract.fields.allowedPaths);
  } catch (error) {
    // Declared scope is a best-effort narrowing signal; failing to parse it
    // must not fail the guard now that git-derived scope always evaluates.
    findings.push({
      severity: 'warning',
      category: 'review-scope',
      kind: 'error',
      message: `Unable to build task contract for review scope: ${(error as Error).message}`,
    });
    return [];
  }
}

function normalizeScopeEntries(field: TaskContractField<string[]>): string[] {
  if (!field.present || !field.value) {
    return [];
  }

  const entries: string[] = [];
  for (const item of field.value) {
    const candidates = extractPathCandidates(item);
    entries.push(...(candidates.length > 0 ? candidates : [item.trim()]));
  }

  return [...new Set(entries.map(normalizeRepoPath).filter(Boolean))].sort();
}

function extractPathCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    candidates.push(...splitPathList(match[1]));
  }
  if (candidates.length > 0) {
    return candidates;
  }
  return splitPathList(text).filter((part) => /[/.]|[*]/.test(part));
}

function splitPathList(text: string): string[] {
  return text
    .split(/(?:,|\s+and\s+|\s+or\s+)/i)
    .map((part) => part.trim())
    .map((part) => part.replace(/\s+\(.+\)$/u, '').replace(/[:.;]$/u, ''))
    .filter(Boolean);
}

function loadOrCreateBaseline(input: {
  repoDir: string;
  featureDir: string;
  sinceCommit?: string;
  sinceCommitSource?: 'launch-base' | 'explicit';
  provenance?: ReviewScopeBaselineProvenance;
  baseRef?: string;
  headRef: string;
  writeBaseline: boolean;
  shellRunner: ShellRunner;
}): ReviewScopeBaseline | null {
  const baselinePath = join(input.featureDir, BASELINE_FILE);
  const existing = readBaseline(baselinePath);
  if (existing) {
    return existing;
  }

  if (!input.sinceCommit) {
    return null;
  }

  const resolvedBase = input.provenance
    ? {
      sinceCommit: input.sinceCommit,
      provenance: input.provenance,
      baseRef: input.baseRef,
    }
    : validateSinceCommit({
      repoDir: input.repoDir,
      sinceCommit: input.sinceCommit,
      headRef: input.headRef,
      source: input.sinceCommitSource ?? 'explicit',
      shellRunner: input.shellRunner,
    });
  const paths = collectNameOnly(input.repoDir, resolvedBase.sinceCommit, input.headRef, input.shellRunner);
  const baseline: ReviewScopeBaseline = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: `git diff --name-only ${resolvedBase.sinceCommit} ${input.headRef}`,
    sinceCommit: resolvedBase.sinceCommit,
    headRef: input.headRef,
    paths,
    provenance: resolvedBase.provenance,
    baseRef: resolvedBase.baseRef,
  };

  if (input.writeBaseline) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  }

  return baseline;
}

export interface EnsureReviewScopeBaselineResult {
  /** False when a valid baseline artifact already existed and was kept as-is. */
  created: boolean;
  baselinePath: string;
  baseline: ReviewScopeBaseline;
}

/**
 * Materialize the review-scope baseline artifact at the coding→review handoff
 * (REQ-F2, HOK-2913).
 *
 * Create-if-absent: an existing valid baseline is never regenerated, so
 * review-fix commits made after the handoff cannot widen the recorded scope.
 * When no `sinceCommit` is supplied, the task's start point is derived as the
 * merge base against the integration ref — at handoff time the branch diff is
 * exactly the committed coding deliverable.
 *
 * @throws Error when the base SHA cannot be derived or the artifact cannot be
 * written; callers degrade to the guard's merge-base fallback with a warning.
 */
export function ensureReviewScopeBaseline(options: {
  repoDir: string;
  featureDir: string;
  sinceCommit?: string;
  sinceCommitSource?: 'launch-base' | 'explicit';
  headRef?: string;
  integrationRef?: string;
  shellRunner?: ShellRunner;
}): EnsureReviewScopeBaselineResult {
  const repoDir = resolve(options.repoDir);
  const featureDir = resolve(options.featureDir);
  const shellRunner = options.shellRunner ?? reviewScopeGuardDeps.execShellCommand;
  const headRef = options.headRef ?? 'HEAD';
  const baselinePath = join(featureDir, BASELINE_FILE);

  const existing = readBaseline(baselinePath);
  if (existing) {
    return { created: false, baselinePath, baseline: existing };
  }

  const resolvedBase = resolveBaselineBase({
    repoDir,
    sinceCommit: options.sinceCommit,
    sinceCommitSource: options.sinceCommitSource,
    headRef,
    integrationRef: options.integrationRef,
    shellRunner,
  });

  const baseline = loadOrCreateBaseline({
    repoDir,
    featureDir,
    sinceCommit: resolvedBase.sinceCommit,
    provenance: resolvedBase.provenance,
    baseRef: resolvedBase.baseRef,
    headRef,
    writeBaseline: true,
    shellRunner,
  });
  if (!baseline) {
    throw new Error(`failed to materialize review-scope baseline at ${baselinePath}`);
  }
  return { created: true, baselinePath, baseline };
}

export function readBaseline(path: string): ReviewScopeBaseline | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewScopeBaseline>;
    if (parsed.version !== 1 || !Array.isArray(parsed.paths) || typeof parsed.sinceCommit !== 'string') {
      return null;
    }
    return {
      version: 1,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      source: typeof parsed.source === 'string' ? parsed.source : BASELINE_FILE,
      sinceCommit: parsed.sinceCommit,
      headRef: typeof parsed.headRef === 'string' ? parsed.headRef : 'HEAD',
      paths: [...new Set(parsed.paths.map(normalizeRepoPath).filter(Boolean))].sort(),
      provenance: isReviewScopeBaselineProvenance(parsed.provenance) ? parsed.provenance : undefined,
      baseRef: typeof parsed.baseRef === 'string' ? parsed.baseRef : undefined,
    };
  } catch {
    return null;
  }
}

function isReviewScopeBaselineProvenance(value: unknown): value is ReviewScopeBaselineProvenance {
  return value === 'launch-base'
    || value === 'remote-merge-base'
    || value === 'local-merge-base-fallback'
    || value === 'explicit-since-commit';
}

function collectNameOnly(
  repoDir: string,
  baseRef: string,
  headRef: string,
  shellRunner: ShellRunner,
): string[] {
  return runGitChecked(
    shellRunner,
    repoDir,
    `git diff --name-only ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
    'git-diff-baseline',
  )
    .split(/\r?\n/)
    .map(normalizeRepoPath)
    .filter(Boolean)
    .sort();
}

function collectCommittedEntries(
  repoDir: string,
  baseRef: string,
  headRef: string,
  shellRunner: ShellRunner,
): NameStatusEntry[] {
  const output = runGitChecked(
    shellRunner,
    repoDir,
    `git diff --name-status ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
    'git-diff-committed',
  );
  return parseNameStatusOutput(output);
}

/**
 * Collect only what is staged. This is the enforcement surface for callers
 * that do not opt into the working tree: without a baseline the committed
 * check passes by construction, so the staged index is the sole place an
 * out-of-scope review edit can still be caught. Untracked files are
 * deliberately excluded — task packets and verification artifacts live
 * untracked in the repo and are not review edits.
 */
function collectStagedEntries(
  repoDir: string,
  stagedPaths: string[],
  shellRunner: ShellRunner,
): NameStatusEntry[] {
  const entries = new Map<string, NameStatusEntry>();

  const stagedOutput = runGitChecked(shellRunner, repoDir, 'git diff --name-status --cached', 'git-diff-staged');
  for (const entry of parseNameStatusOutput(stagedOutput)) {
    entries.set(entry.path, entry);
  }
  // The strict NUL-delimited staged collection is authoritative; make sure
  // every staged path is evaluated even if the name-status parse missed one.
  for (const path of stagedPaths) {
    if (!entries.has(path)) {
      entries.set(path, { status: 'M', path });
    }
  }

  return [...entries.values()];
}

function collectUncommittedEntries(
  repoDir: string,
  stagedPaths: string[],
  shellRunner: ShellRunner,
): NameStatusEntry[] {
  const entries = new Map<string, NameStatusEntry>();
  for (const entry of collectStagedEntries(repoDir, stagedPaths, shellRunner)) {
    entries.set(entry.path, entry);
  }

  const worktreeOutput = runGitChecked(shellRunner, repoDir, 'git diff --name-status', 'git-diff-worktree');
  for (const entry of parseNameStatusOutput(worktreeOutput)) {
    if (!entries.has(entry.path)) {
      entries.set(entry.path, entry);
    }
  }

  const untrackedOutput = runGitChecked(
    shellRunner,
    repoDir,
    'git ls-files --others --exclude-standard',
    'git-ls-untracked',
  );
  for (const path of untrackedOutput.split(/\r?\n/)) {
    const normalized = normalizeRepoPath(path);
    if (normalized && !entries.has(normalized)) {
      entries.set(normalized, { status: 'A', path: normalized });
    }
  }

  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collectDeletionBudgetFindings(
  repoDir: string,
  baseRef: string,
  headRef: string,
  scopeSet: ReadonlySet<string>,
  shellRunner: ShellRunner,
): ReviewScopeGuardFinding[] {
  const entries = parseNumstatOutput(runGitChecked(
    shellRunner,
    repoDir,
    `git diff --numstat ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
    'git-diff-numstat',
  ));

  return entries
    .filter((entry) => !scopeSet.has(entry.path))
    .filter((entry) => entry.deletions >= DEFAULT_DELETION_FLOOR)
    .filter((entry) => entry.deletions > Math.max(DEFAULT_DELETION_FLOOR, entry.additions * DEFAULT_DELETION_RATIO))
    .map((entry) => ({
      severity: 'blocker' as const,
      category: 'deletion-budget' as const,
      kind: 'violation' as const,
      observedIn: 'committed' as const,
      path: entry.path,
      message:
        `Deletion budget exceeded outside task baseline: ${entry.path} ` +
        `(+${entry.additions}/-${entry.deletions}).`,
      details: {
        additions: entry.additions,
        deletions: entry.deletions,
        ratio: DEFAULT_DELETION_RATIO,
      },
    }));
}

function collectCrossPrReverts(input: {
  repoDir: string;
  baseRef: string;
  headRef: string;
  integrationRef: string;
  acknowledgementText?: string;
  maxRecentMerges?: number;
  shellRunner: ShellRunner;
  findings: ReviewScopeGuardFinding[];
}): CrossPrRevertFinding[] {
  const reviewMergeConfig = getReviewMergeConfig(input.repoDir);
  if (!reviewMergeConfig.crossPrRevertCheck.enabled) {
    return [];
  }

  try {
    const reverts = reviewScopeGuardDeps.detectCrossPrReverts({
      repoDir: input.repoDir,
      baseRef: input.baseRef,
      headRef: input.headRef,
      integrationRef: input.integrationRef,
      maxRecentMerges: input.maxRecentMerges ?? reviewMergeConfig.crossPrRevertCheck.maxRecentMerges,
      shellRunner: input.shellRunner,
    });
    const acknowledgements = parseRevertAcknowledgements(input.acknowledgementText ?? loadAcknowledgementText(input.repoDir, input.shellRunner));
    const unacknowledged = filterUnacknowledgedReverts(reverts, acknowledgements);
    return filterRevertsAlreadyOnIntegration(
      unacknowledged,
      input.repoDir,
      input.integrationRef,
      input.headRef,
      input.shellRunner,
    );
  } catch (error) {
    input.findings.push({
      severity: 'blocker',
      category: 'cross-pr-revert',
      kind: 'violation' as const,
      message:
        `Unable to prove the branch does not revert recent integration work: ${(error as Error).message}`,
    });
    return [];
  }
}

/**
 * Drop revert findings the branch did not introduce: when HEAD's blob for a
 * flagged path matches the integration tip's blob, the "revert" already
 * lives in the integration branch's own history (e.g. integration itself
 * reverted the PR), so merging this branch cannot regress that path. Without
 * this filter, every branch that is simply up to date with integration is
 * flagged for any PR that integration later reverted.
 */
function filterRevertsAlreadyOnIntegration(
  reverts: CrossPrRevertFinding[],
  repoDir: string,
  integrationRef: string,
  headRef: string,
  shellRunner: ShellRunner,
): CrossPrRevertFinding[] {
  return reverts
    .map((revert) => ({
      ...revert,
      files: revert.files.filter((file) =>
        blobIdAtRef(repoDir, integrationRef, file.path, shellRunner)
        !== blobIdAtRef(repoDir, headRef, file.path, shellRunner)),
    }))
    .filter((revert) => revert.files.length > 0);
}

function blobIdAtRef(
  repoDir: string,
  ref: string,
  path: string,
  shellRunner: ShellRunner,
): string | null {
  try {
    const blob = runGit(
      shellRunner,
      repoDir,
      `git rev-parse --verify --quiet ${escapeShellArg(`${ref}:${path}`)}`,
    ).trim();
    return blob || null;
  } catch {
    return null;
  }
}

/**
 * Fallback acknowledgement source when no PR body is available (the PR lookup
 * already supplies title+body when a PR exists): recent commit messages.
 */
function loadAcknowledgementText(repoDir: string, shellRunner: ShellRunner): string {
  try {
    return String(shellRunner(
      'git log --format=%B -n 20 HEAD',
      { cwd: repoDir, encoding: 'utf-8' },
    ));
  } catch {
    return '';
  }
}

function buildScopeMatchers(entries: string[]): Array<(path: string) => boolean> {
  return entries.map((entry) => {
    if (entry.includes('*')) {
      const re = new RegExp(`^${entry.split('*').map(escapeRegex).join('.*')}$`);
      return (path: string) => re.test(path);
    }
    if (entry.endsWith('/')) {
      return (path: string) => path.startsWith(entry);
    }
    return (path: string) => path === entry || path.startsWith(`${entry}/`);
  });
}

/**
 * Compute the companion allowlist for a candidate change set.
 *
 * A `foo.test.ts` / `foo.spec.ts` file is a companion iff its source file
 * (`foo.ts`) is in scope; the test-registration runner files are companions
 * only when at least one legitimate test companion is in the same change set.
 * This matches the "add a test, then register it" workflow `CLAUDE.md`
 * mandates without opening the registration files to arbitrary edits.
 */
function findAllowedCompanionPaths(
  candidatePaths: string[],
  isInScope: (path: string) => boolean,
): string[] {
  const companionPaths = new Set<string>();
  let hasAllowedTestCompanion = false;

  for (const candidatePath of candidatePaths) {
    if (isTestCompanionForScopedSource(candidatePath, isInScope)) {
      companionPaths.add(candidatePath);
      hasAllowedTestCompanion = true;
    }
  }

  if (hasAllowedTestCompanion) {
    for (const candidatePath of candidatePaths) {
      if (REGISTRATION_COMPANIONS.has(candidatePath)) {
        companionPaths.add(candidatePath);
      }
    }
  }

  return [...companionPaths].sort();
}

function isTestCompanionForScopedSource(
  candidatePath: string,
  isInScope: (path: string) => boolean,
): boolean {
  const match = candidatePath.match(TEST_COMPANION_PATTERN);
  if (!match?.groups) {
    return false;
  }
  const sourcePath = `${match.groups.base}.${match.groups.ext}`;
  return isInScope(sourcePath);
}

function isSupportFile(path: string, scopeSet: ReadonlySet<string>): boolean {
  const base = basename(path);
  if (!/\.(?:test|spec)\.[^.]+$/.test(base) && !path.includes('/fixtures/')) {
    return false;
  }

  for (const ownedPath of scopeSet) {
    if (dirname(path) === dirname(ownedPath)) {
      return true;
    }
    const ownedStem = basename(ownedPath).replace(/\.[^.]+$/, '');
    if (base.startsWith(`${ownedStem}.`) || base.startsWith(`${ownedStem}-`)) {
      return true;
    }
  }

  return false;
}

function parseNameStatusOutput(output: string): NameStatusEntry[] {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [statusToken = '', firstPath = '', secondPath = ''] = line.split('\t');
      const status = statusToken[0] ?? '';
      const path = status === 'R' || status === 'C' ? secondPath : firstPath;
      return { status, path: normalizeRepoPath(path) };
    })
    .filter((entry) => entry.status && entry.path);
}

function parseNumstatOutput(output: string): NumstatEntry[] {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [additions = '0', deletions = '0', path = ''] = line.split('\t');
      return {
        path: normalizeRepoPath(path),
        additions: additions === '-' ? 0 : Number.parseInt(additions, 10),
        deletions: deletions === '-' ? 0 : Number.parseInt(deletions, 10),
      };
    })
    .filter((entry) => entry.path && Number.isFinite(entry.additions) && Number.isFinite(entry.deletions));
}

function splitNullDelimited(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function normalizeGitPaths(paths: string[], context: string): string[] {
  const normalized = paths.map((gitPath) => normalizeGitPath(gitPath, context));
  return [...new Set(normalized)].sort();
}

/**
 * Strictly validate a path reported by git. Ambiguity (absolute paths,
 * `.`/`..` segments, embedded NULs) is a tool error, never silently accepted:
 * an allowlist decision made on a mangled path could fail open.
 */
function normalizeGitPath(gitPath: string, context: string): string {
  if (!gitPath || gitPath.includes('\0') || isAbsolute(gitPath)) {
    throw new ReviewScopeGuardToolFailure({
      commandClass: 'git-path-normalization',
      command: `normalize-git-path (${context})`,
      stderr: `Ambiguous ${context} path from Git: ${JSON.stringify(gitPath)}`,
    });
  }

  const normalized = posix.normalize(gitPath);
  const segments = gitPath.split('/');
  if (
    normalized !== gitPath
    || normalized === '.'
    || segments.some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    throw new ReviewScopeGuardToolFailure({
      commandClass: 'git-path-normalization',
      command: `normalize-git-path (${context})`,
      stderr: `Ambiguous ${context} path from Git: ${JSON.stringify(gitPath)}`,
    });
  }

  return gitPath;
}

function normalizeRepoPath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGit(shellRunner: ShellRunner, repoDir: string, command: string): string {
  return String(shellRunner(command, { cwd: repoDir, encoding: 'utf-8' }));
}

/**
 * Run a git command on the scope-resolution critical path, wrapping any
 * failure as a ReviewScopeGuardToolFailure so it surfaces as `status: 'error'`
 * (unverified) instead of masquerading as a policy finding.
 */
function runGitChecked(
  shellRunner: ShellRunner,
  repoDir: string,
  command: string,
  commandClass: string,
): string {
  try {
    return runGit(shellRunner, repoDir, command);
  } catch (error) {
    const execError = error as { status?: number | null; stderr?: unknown; message?: string };
    const stderr = typeof execError.stderr === 'string'
      ? execError.stderr
      : execError.stderr instanceof Buffer
        ? execError.stderr.toString('utf-8')
        : '';
    throw new ReviewScopeGuardToolFailure({
      commandClass,
      command,
      exitCode: typeof execError.status === 'number' ? execError.status : undefined,
      stderr: stderr.trim() || (error instanceof Error ? error.message : String(error)),
    });
  }
}

export function formatReviewScopeGuardResult(result: ReviewScopeGuardResult): string {
  if (result.status === 'pass') {
    return [
      'Review scope guard passed.',
      `Integration ref: ${result.integrationRef}`,
      result.mergeBase ? `Merge base: ${result.mergeBase}` : undefined,
      `Baseline source: ${result.baselineSource}`,
      `Staged paths checked: ${result.stagedPaths.length}`,
      result.prLookup === 'none' ? REVIEW_SCOPE_GUARD_NO_PR_MESSAGE : undefined,
      result.prLookup === 'found' && result.prNumber != null ? `PR: #${result.prNumber}` : undefined,
    ].filter(Boolean).join('\n');
  }

  if (result.status === 'fail') {
    return [
      'Review scope guard failed:',
      ...result.findings.map((finding) => {
        const location = finding.path ? ` ${finding.path}` : '';
        return `- [${finding.category}]${location} ${finding.message}`;
      }),
      '',
      result.message,
    ].join('\n');
  }

  return [
    'Review scope guard could not verify scope (tool error — treat as unverified, not as a pass):',
    REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
    '',
    `Integration ref: ${result.integrationRef}`,
    result.toolError ? `Failure class: ${result.toolError.commandClass}` : undefined,
    result.toolError ? `Command: ${result.toolError.command}` : undefined,
    result.toolError?.exitCode !== undefined ? `Exit code: ${result.toolError.exitCode}` : undefined,
    result.toolError?.stderr ? `Error: ${result.toolError.stderr}` : undefined,
  ].filter((line) => line !== undefined).join('\n');
}
