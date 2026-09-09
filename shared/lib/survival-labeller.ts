/**
 * Repo-agnostic Arbiter S2 survival labeller (HOK-2805).
 *
 * For each merged PR on an integration branch, looks forward 14/30/60 days
 * over the normalized line ranges the PR touched and emits one frozen
 * v1.0.0 survival label per elapsed horizon (see
 * `shared/lib/arbiter-survival-label.ts` and
 * `docs/arbiter/survival-label-contract.md`).
 *
 * Design constraints (Arbiter §11.3, HOK-2792/HOK-2944):
 * - Callable against ANY local Git checkout given
 *   `(owner, repo, integrationBranch)` plus an optional token. No wavemill
 *   state (`.wavemill/`, evals.jsonl) is read here; the evals join is a thin
 *   caller-side layer.
 * - Walks the integration branch's first-parent history only. `main` is
 *   rejected: in squash-promotion repos a `main` blame attributes every
 *   change to the promoter.
 * - Precision-biased: whitespace/formatter-only churn, rename/move-only
 *   changes, and unrelated same-file churn never create negative labels.
 * - Missing/ineligible labels are explicit all-null outcomes with exactly one
 *   typed missing reason; nothing is imputed. When no forward terminal can be
 *   resolved (unelapsed horizon, inaccessible history) the envelope's
 *   `horizon_terminal_sha` deterministically anchors at `merge_sha` — a
 *   zero-length forward window — so reruns at the same inputs are
 *   byte-equivalent apart from `computed_at` (run provenance, injectable).
 *
 * Substrate anchoring: the labelled change is the first-parent merge diff
 * (`merge^1 -> merge`) — the change the integration branch actually received,
 * valid for both true merge commits and squash commits. Old coordinates
 * anchor at `merge^1`, new coordinates at `merge_sha`.
 */

import { execArgvCommand } from './shell-utils.ts';
import { extractPrNumber, parseNameStatusOutput } from './cross-pr-revert-detector.ts';
import {
  HORIZONS,
  SUBSTANTIAL_REWRITE_THRESHOLD,
  buildArbiterSurvivalLabel,
  type ArbiterSurvivalLabelV1,
  type HorizonDays,
  type LineRange,
  type MissingReasonCode,
  type ReasonCode,
  type UndoneBy,
} from './arbiter-survival-label.ts';

/** Semver of this labeller implementation (envelope.labeller_version). */
export const SURVIVAL_LABELLER_VERSION = '1.0.0';
/**
 * Semver of the normalization rules: -U0 first-parent merge diff, `-w
 * --ignore-blank-lines` whitespace stripping, one-hop rename following,
 * rename/move-only exclusion, and {@link SUBSTANTIAL_REWRITE_THRESHOLD}.
 */
export const SURVIVAL_NORMALIZATION_VERSION = '1.0.0';

const DAY_SECONDS = 86_400;

// ── Injectable dependencies ────────────────────────────────────────────────

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (args: readonly string[]) => GitCommandResult;

export interface PrMetadata {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string | null;
}

export interface CrossReference {
  /** Epoch seconds the referencing PR/issue event was created. */
  createdAtEpoch: number;
  url: string;
}

export interface SurvivalGitHubClient {
  getPrMetadata(prUrl: string): PrMetadata | null;
  listCrossReferences(prNumber: number): CrossReference[];
}

export interface SurvivalLabellerDeps {
  runGit: GitRunner;
  github: SurvivalGitHubClient;
  now: () => Date;
  onDiagnostic?: (message: string) => void;
}

export interface SurvivalLabellerTarget {
  owner: string;
  repo: string;
  /** Branch whose first-parent history is walked. `main` is rejected. */
  integrationBranch: string;
  /** Local checkout of the repository. */
  repoDir: string;
  token?: string;
}

/** Forward diffs over 60-day windows can be large; never let maxBuffer truncate them. */
export const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/** Default deps: local `git`, `gh` for PR metadata/cross-references, wall clock. */
export function createDefaultDeps(target: SurvivalLabellerTarget): SurvivalLabellerDeps {
  const env = target.token ? { ...process.env, GH_TOKEN: target.token } : process.env;
  const runGit: GitRunner = (args) =>
    execArgvCommand('git', ['-C', target.repoDir, ...args], {
      env,
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
  const runGh = (args: readonly string[]): GitCommandResult =>
    execArgvCommand('gh', [...args], { env, cwd: target.repoDir });
  const github: SurvivalGitHubClient = {
    getPrMetadata(prUrl) {
      const result = runGh([
        'pr', 'view', prUrl,
        '--json', 'number,title,state,mergedAt,mergeCommit,headRefOid',
      ]);
      if (result.exitCode !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as {
          number?: number;
          title?: string;
          state?: string;
          mergedAt?: string | null;
          mergeCommit?: { oid?: string } | null;
          headRefOid?: string | null;
        };
        if (typeof parsed.number !== 'number') return null;
        return {
          number: parsed.number,
          title: parsed.title ?? '',
          state: parsed.state ?? '',
          mergedAt: parsed.mergedAt ?? null,
          mergeCommitSha: parsed.mergeCommit?.oid ?? null,
          headSha: parsed.headRefOid ?? null,
        };
      } catch {
        return null;
      }
    },
    listCrossReferences(prNumber) {
      const result = runGh([
        'api',
        `repos/${target.owner}/${target.repo}/issues/${prNumber}/timeline?per_page=100`,
        '-H', 'Accept: application/vnd.github+json',
      ]);
      if (result.exitCode !== 0) return [];
      try {
        const events = JSON.parse(result.stdout) as Array<{
          event?: string;
          created_at?: string;
          source?: { issue?: { html_url?: string } };
        }>;
        return events
          .filter((event) => event.event === 'cross-referenced' && event.created_at)
          .map((event) => ({
            createdAtEpoch: Math.floor(Date.parse(event.created_at as string) / 1000),
            url: event.source?.issue?.html_url ?? '',
          }))
          .filter((ref) => Number.isFinite(ref.createdAtEpoch));
      } catch {
        return [];
      }
    },
  };
  return { runGit, github, now: () => new Date() };
}

// ── Merged-PR enumeration ──────────────────────────────────────────────────

/** One merged PR anchored on the integration branch's first-parent history. */
export interface MergedPrRef {
  prNumber: number;
  prUrl: string;
  /** First-parent commit that landed the PR (merge commit or squash commit). */
  mergeSha: string;
  /** First parent of mergeSha: the pre-change integration state. */
  parentSha: string;
  /** PR branch head (second parent), or the squash commit itself. */
  headSha: string;
  /** Committer time of mergeSha, epoch seconds. */
  mergedAtEpoch: number;
  subject: string;
}

function assertIntegrationBranch(target: SurvivalLabellerTarget): void {
  if (target.integrationBranch === 'main') {
    throw new Error(
      'survival-labeller: integrationBranch "main" is rejected (v1.0.0 contract): squash promotion rewrites the SHA lineage the labeller needs',
    );
  }
}

/**
 * Walk the integration branch's first-parent history and return every commit
 * that landed a PR: true merge commits ("Merge pull request #N") and squash
 * commits ("... (#N)"). Newest first, up to `maxCount` commits inspected.
 */
export function enumerateMergedPrs(
  target: SurvivalLabellerTarget,
  deps: SurvivalLabellerDeps,
  options: { maxCount?: number } = {},
): MergedPrRef[] {
  assertIntegrationBranch(target);
  const maxCount = options.maxCount ?? 1000;
  const result = deps.runGit([
    'log', '--first-parent', `--max-count=${maxCount}`,
    '--pretty=format:%H%x09%P%x09%ct%x09%s',
    target.integrationBranch,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`survival-labeller: cannot walk ${target.integrationBranch}: ${result.stderr.trim()}`);
  }
  const refs: MergedPrRef[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, parentsText = '', epochText = '', ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t').trim();
    const parents = parentsText.trim().split(/\s+/).filter(Boolean);
    const mergedAtEpoch = Number(epochText);
    if (!sha || parents.length === 0 || !Number.isFinite(mergedAtEpoch)) continue;
    const prNumber = extractPrNumber(subject);
    if (prNumber === null) continue;
    refs.push({
      prNumber,
      prUrl: `https://github.com/${target.owner}/${target.repo}/pull/${prNumber}`,
      mergeSha: sha,
      parentSha: parents[0] as string,
      headSha: parents.length >= 2 ? (parents[1] as string) : sha,
      mergedAtEpoch,
      subject,
    });
  }
  return refs;
}

/** A PR that cannot yield any schema-valid row (no integration-branch anchor). */
export interface SkippedPr {
  prUrl: string;
  reason: 'unmerged_pr' | 'inaccessible_history';
  detail: string;
}

/**
 * Resolve one PR URL to its integration-branch anchor for a focused/replay
 * run. Prefers the first-parent enumeration match; falls back to gh's merge
 * commit when it is an ancestor of the integration branch.
 */
export function resolveMergedPr(
  target: SurvivalLabellerTarget,
  deps: SurvivalLabellerDeps,
  prUrl: string,
  options: { searchLimit?: number } = {},
): MergedPrRef | SkippedPr {
  assertIntegrationBranch(target);
  const numberMatch = prUrl.match(/\/pull\/(\d+)\b/);
  const prNumber = numberMatch ? Number(numberMatch[1]) : null;
  if (prNumber !== null) {
    const enumerated = enumerateMergedPrs(target, deps, { maxCount: options.searchLimit ?? 5000 });
    const match = enumerated.find((ref) => ref.prNumber === prNumber);
    if (match) return { ...match, prUrl };
  }
  const metadata = deps.github.getPrMetadata(prUrl);
  if (!metadata) {
    return { prUrl, reason: 'inaccessible_history', detail: 'PR metadata unavailable' };
  }
  if (!metadata.mergedAt || !metadata.mergeCommitSha) {
    return { prUrl, reason: 'unmerged_pr', detail: `PR state ${metadata.state || 'unknown'} has no merge commit` };
  }
  const ancestor = deps.runGit([
    'merge-base', '--is-ancestor', metadata.mergeCommitSha, target.integrationBranch,
  ]);
  if (ancestor.exitCode !== 0) {
    return {
      prUrl,
      reason: 'inaccessible_history',
      detail: `merge commit ${metadata.mergeCommitSha} is not on ${target.integrationBranch}`,
    };
  }
  const info = deps.runGit(['log', '-1', '--pretty=format:%H%x09%P%x09%ct%x09%s', metadata.mergeCommitSha]);
  const [sha, parentsText = '', epochText = '', ...subjectParts] = info.stdout.split('\t');
  const parents = parentsText.trim().split(/\s+/).filter(Boolean);
  if (info.exitCode !== 0 || !sha || parents.length === 0) {
    return { prUrl, reason: 'inaccessible_history', detail: 'cannot read merge commit' };
  }
  return {
    prNumber: metadata.number,
    prUrl,
    mergeSha: sha,
    parentSha: parents[0] as string,
    headSha: metadata.headSha ?? (parents.length >= 2 ? (parents[1] as string) : sha),
    mergedAtEpoch: Number(epochText),
    subject: subjectParts.join('\t').trim() || metadata.title,
  };
}

export function isSkippedPr(value: MergedPrRef | SkippedPr): value is SkippedPr {
  return (value as SkippedPr).reason !== undefined;
}

// ── Diff parsing ───────────────────────────────────────────────────────────

interface HunkRange {
  start: number;
  end: number;
}

interface DiffHunk {
  old: HunkRange | null;
  new: HunkRange | null;
}

interface DiffFileEntry {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

function stripDiffPathPrefix(raw: string): string | null {
  const trimmed = raw.replace(/\t.*$/, '').trim();
  if (trimmed === '/dev/null') return null;
  return trimmed.replace(/^[ab]\//, '');
}

/** Parse `git diff -U0` output into per-file 1-based inclusive hunk ranges. */
export function parseZeroContextDiff(diffText: string): DiffFileEntry[] {
  const entries: DiffFileEntry[] = [];
  let current: DiffFileEntry | null = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = { oldPath: null, newPath: null, hunks: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('--- ')) {
      current.oldPath = stripDiffPathPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPath = stripDiffPathPrefix(line.slice(4));
      continue;
    }
    // Pure renames carry no ---/+++ header; recover paths for mapping.
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length).trim();
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      current.hunks.push({
        old: oldCount > 0 ? { start: oldStart, end: oldStart + oldCount - 1 } : null,
        new: newCount > 0 ? { start: newStart, end: newStart + newCount - 1 } : null,
      });
    }
  }
  return entries.filter((entry) => entry.oldPath !== null || entry.newPath !== null);
}

function rangeLineCount(range: HunkRange): number {
  return range.end - range.start + 1;
}

function countCoveredLines(range: HunkRange, covered: readonly HunkRange[]): number {
  let count = 0;
  for (const cover of covered) {
    const start = Math.max(range.start, cover.start);
    const end = Math.min(range.end, cover.end);
    if (end >= start) count += end - start + 1;
  }
  return count;
}

// ── Substrate ──────────────────────────────────────────────────────────────

interface SubstrateFile {
  /** Post-change path at mergeSha. */
  path: string;
  /** Pre-change path at parentSha (differs for renamed-with-edits files). */
  oldPath: string;
  hunks: DiffHunk[];
}

interface Substrate {
  files: SubstrateFile[];
  lineRanges: LineRange[];
  totalLines: number;
}

const WHITESPACE_DIFF_ARGS = ['-U0', '-w', '--ignore-blank-lines', '--find-renames', '--no-color'];

/**
 * Normalize a PR's first-parent merge diff into anchored line ranges.
 * Whitespace/formatter-only hunks and rename/move-only files drop out here.
 */
function buildSubstrate(deps: SurvivalLabellerDeps, pr: MergedPrRef): Substrate | null {
  const result = deps.runGit(['diff', ...WHITESPACE_DIFF_ARGS, pr.parentSha, pr.mergeSha]);
  if (result.exitCode !== 0) return null;
  const files: SubstrateFile[] = [];
  for (const entry of parseZeroContextDiff(result.stdout)) {
    if (entry.hunks.length === 0) continue; // rename/move-only or whitespace-only
    const path = entry.newPath ?? entry.oldPath;
    if (!path) continue;
    files.push({ path, oldPath: entry.oldPath ?? path, hunks: entry.hunks });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lineRanges: LineRange[] = [];
  let totalLines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      lineRanges.push({
        path: file.path,
        old: hunk.old ? { start: hunk.old.start, end: hunk.old.end, sha: pr.parentSha } : null,
        new: hunk.new ? { start: hunk.new.start, end: hunk.new.end, sha: pr.mergeSha } : null,
      });
      totalLines += hunk.new ? rangeLineCount(hunk.new) : hunk.old ? rangeLineCount(hunk.old) : 0;
    }
  }
  return { files, lineRanges, totalLines };
}

// ── Forward analysis ───────────────────────────────────────────────────────

interface ForwardAnalysis {
  survivingLines: number;
  totalLines: number;
  reverted: boolean;
  rangeFollowup: boolean;
  touchedPaths: string[];
}

function blobAt(deps: SurvivalLabellerDeps, sha: string, path: string): string | null {
  const result = deps.runGit(['rev-parse', '-q', '--verify', `${sha}:${path}`]);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

function analyseForward(
  deps: SurvivalLabellerDeps,
  pr: MergedPrRef,
  substrate: Substrate,
  terminalSha: string,
): ForwardAnalysis | null {
  const nameStatus = deps.runGit(['diff', '--name-status', '--find-renames', pr.mergeSha, terminalSha]);
  if (nameStatus.exitCode !== 0) return null;

  const fate = new Map<string, { status: string; newPath: string }>();
  for (const entry of parseNameStatusOutput(nameStatus.stdout)) {
    fate.set(entry.previousPath ?? entry.path, { status: entry.status, newPath: entry.path });
  }

  // Scope the (potentially huge) forward line diff to the substrate's paths
  // and their rename targets; the fate map keeps rename pairing intact.
  const substratePathspec = new Set<string>();
  for (const file of substrate.files) {
    substratePathspec.add(file.path);
    const mapped = fate.get(file.path);
    if (mapped && mapped.status !== 'D') substratePathspec.add(mapped.newPath);
  }
  const unified = deps.runGit([
    'diff', ...WHITESPACE_DIFF_ARGS, pr.mergeSha, terminalSha,
    '--', ...[...substratePathspec].sort(),
  ]);
  if (unified.exitCode !== 0) return null;
  const forwardByOldPath = new Map<string, HunkRange[]>();
  for (const entry of parseZeroContextDiff(unified.stdout)) {
    const key = entry.oldPath ?? entry.newPath;
    if (!key) continue;
    const ranges = forwardByOldPath.get(key) ?? [];
    for (const hunk of entry.hunks) {
      if (hunk.old) ranges.push(hunk.old);
    }
    forwardByOldPath.set(key, ranges);
  }

  let survivingLines = 0;
  let rangeFollowup = false;
  let allFilesReverted = substrate.files.length > 0;
  const touchedPaths = new Set<string>();

  for (const file of substrate.files) {
    const fileFate = fate.get(file.path);
    const mappedPath = fileFate?.status === 'D' ? null : (fileFate?.newPath ?? file.path);
    const parentBlob = blobAt(deps, pr.parentSha, file.oldPath);
    const mergeBlob = blobAt(deps, pr.mergeSha, file.path);
    const terminalBlob = mappedPath ? blobAt(deps, terminalSha, mappedPath) : null;
    const fileReverted = parentBlob !== mergeBlob && terminalBlob === parentBlob;
    if (!fileReverted) allFilesReverted = false;

    touchedPaths.add(file.path);
    if (mappedPath && mappedPath !== file.path) touchedPaths.add(mappedPath);

    const covered = forwardByOldPath.get(file.path) ?? [];
    const fileDeleted = mappedPath === null;
    for (const hunk of file.hunks) {
      if (hunk.new) {
        const total = rangeLineCount(hunk.new);
        const undone = fileDeleted ? total : countCoveredLines(hunk.new, covered);
        survivingLines += total - undone;
        if (undone > 0) rangeFollowup = true;
      } else if (hunk.old) {
        // Pure deletion: the change survives while the deletion persists.
        // Precise re-addition detection is out of scope; only an exact
        // file-level restoration counts against it (precision bias).
        const total = rangeLineCount(hunk.old);
        if (fileReverted) {
          rangeFollowup = true;
        } else {
          survivingLines += total;
        }
      }
    }
  }

  return {
    survivingLines,
    totalLines: substrate.totalLines,
    reverted: allFilesReverted,
    rangeFollowup,
    touchedPaths: [...touchedPaths].sort(),
  };
}

// ── Undoer attribution ─────────────────────────────────────────────────────

const AGENT_ACTOR_PATTERN = /\[bot\]|claude|codex|copilot|devin|aider|anthropic|openai/i;
const AGENT_TRAILER_PATTERN = /co-authored-by:.*(claude|codex|copilot|devin|\[bot\])/i;

/** Classify one commit's actor. Exported for reuse/tests. */
export function classifyCommitActor(commit: {
  authorName: string;
  authorEmail: string;
  body: string;
}): 'human' | 'agent' {
  if (AGENT_ACTOR_PATTERN.test(`${commit.authorName} ${commit.authorEmail}`)) return 'agent';
  if (AGENT_TRAILER_PATTERN.test(commit.body)) return 'agent';
  return 'human';
}

function attributeUndoers(
  deps: SurvivalLabellerDeps,
  pr: MergedPrRef,
  terminalSha: string,
  touchedPaths: readonly string[],
  extraVotes: readonly ('human' | 'agent')[],
): UndoneBy {
  const votes = new Set<'human' | 'agent'>(extraVotes);
  if (touchedPaths.length > 0) {
    const result = deps.runGit([
      'log', '--first-parent', '--pretty=format:%H%x1f%an%x1f%ae%x1f%B%x1e',
      `${pr.mergeSha}..${terminalSha}`, '--', ...touchedPaths,
    ]);
    if (result.exitCode === 0) {
      for (const record of result.stdout.split('\x1e')) {
        if (!record.trim()) continue;
        const [, authorName = '', authorEmail = '', body = ''] = record.split('\x1f');
        votes.add(classifyCommitActor({ authorName, authorEmail, body }));
      }
    }
  }
  if (votes.size === 1) return [...votes][0] as UndoneBy;
  return null; // no undoer, or ambiguous/mixed attribution
}

// ── Per-PR labelling ───────────────────────────────────────────────────────

export interface LabelMergedPrOptions {
  horizons?: readonly HorizonDays[];
  /**
   * Pre-merge human intervention supplied by the caller as an input
   * feature/provenance record (HOK-2944). Sets `followup` +
   * `pre_merge_human_edit`; never touches post-merge survival evidence.
   */
  preMergeHumanEdit?: boolean;
  /** Skip the gh cross-reference lookup (offline/bulk runs). */
  includeLinkedReferences?: boolean;
  /** Full enumeration, used for same-task redispatch detection. */
  allMergedPrs?: readonly MergedPrRef[];
}

const ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

function extractIssueKeys(text: string): Set<string> {
  return new Set(text.match(ISSUE_KEY_PATTERN) ?? []);
}

/** Deterministic reason-code emission order. */
const REASON_CODE_ORDER: readonly ReasonCode[] = [
  'exact_revert',
  'line_range_followup',
  'linked_issue_or_pr',
  'pre_merge_human_edit',
  'task_redispatch',
  'substantial_rewrite',
  'no_evidence',
];

function missingLabel(
  pr: MergedPrRef,
  target: SurvivalLabellerTarget,
  deps: SurvivalLabellerDeps,
  horizon: HorizonDays,
  reason: MissingReasonCode,
  options: { terminalSha?: string; lineRanges?: LineRange[] } = {},
): ArbiterSurvivalLabelV1 {
  return buildArbiterSurvivalLabel({
    prUrl: pr.prUrl,
    horizon_days: horizon,
    label_provenance: 'harvested',
    line_ranges: options.lineRanges ?? [],
    outcome: {
      survived: null,
      survival_ratio: null,
      reverted: null,
      undone_by: null,
      followup: null,
      reason_codes: [reason],
    },
    envelope: {
      labeller_version: SURVIVAL_LABELLER_VERSION,
      normalization_version: SURVIVAL_NORMALIZATION_VERSION,
      pr_head_sha: pr.headSha,
      merge_sha: pr.mergeSha,
      horizon_terminal_sha: options.terminalSha ?? pr.mergeSha,
      integration_branch: target.integrationBranch,
      computed_at: deps.now().toISOString(),
    },
  });
}

function resolveHorizonTerminal(
  deps: SurvivalLabellerDeps,
  target: SurvivalLabellerTarget,
  cutoffEpoch: number,
): string | null {
  const cutoffIso = new Date(cutoffEpoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const result = deps.runGit([
    'log', '--first-parent', '--max-count=1', `--until=${cutoffIso}`,
    '--pretty=format:%H', target.integrationBranch,
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Compute the survival label(s) for one merged PR: one label per requested
 * horizon, missing rows included. Deterministic for fixed deps at a fixed
 * horizon terminal SHA.
 */
export function labelMergedPr(
  target: SurvivalLabellerTarget,
  deps: SurvivalLabellerDeps,
  pr: MergedPrRef,
  options: LabelMergedPrOptions = {},
): ArbiterSurvivalLabelV1[] {
  assertIntegrationBranch(target);
  const horizons = options.horizons ?? HORIZONS;
  const nowEpoch = Math.floor(deps.now().getTime() / 1000);
  const substrate = buildSubstrate(deps, pr);

  let crossReferences: CrossReference[] | null = null;
  const linkedReferencesAt = (cutoffEpoch: number): boolean => {
    if (options.includeLinkedReferences === false) return false;
    if (crossReferences === null) {
      try {
        crossReferences = deps.github.listCrossReferences(pr.prNumber);
      } catch (error) {
        deps.onDiagnostic?.(`cross-reference lookup failed for #${pr.prNumber}: ${String(error)}`);
        crossReferences = [];
      }
    }
    return crossReferences.some(
      (ref) => ref.createdAtEpoch > pr.mergedAtEpoch && ref.createdAtEpoch <= cutoffEpoch,
    );
  };

  const issueKeys = extractIssueKeys(pr.subject);
  const redispatchAt = (cutoffEpoch: number): boolean => {
    if (issueKeys.size === 0 || !options.allMergedPrs) return false;
    return options.allMergedPrs.some(
      (other) =>
        other.mergeSha !== pr.mergeSha &&
        other.mergedAtEpoch > pr.mergedAtEpoch &&
        other.mergedAtEpoch <= cutoffEpoch &&
        [...extractIssueKeys(other.subject)].some((key) => issueKeys.has(key)),
    );
  };

  const labels: ArbiterSurvivalLabelV1[] = [];
  for (const horizon of horizons) {
    const cutoffEpoch = pr.mergedAtEpoch + horizon * DAY_SECONDS;
    if (cutoffEpoch > nowEpoch) {
      labels.push(missingLabel(pr, target, deps, horizon, 'missing_horizon', {
        lineRanges: substrate?.lineRanges,
      }));
      continue;
    }
    if (!substrate) {
      labels.push(missingLabel(pr, target, deps, horizon, 'inaccessible_history'));
      continue;
    }
    if (substrate.totalLines === 0) {
      labels.push(missingLabel(pr, target, deps, horizon, 'insufficient_line_range_substrate'));
      continue;
    }
    const terminalSha = resolveHorizonTerminal(deps, target, cutoffEpoch);
    if (!terminalSha) {
      labels.push(missingLabel(pr, target, deps, horizon, 'inaccessible_history', {
        lineRanges: substrate.lineRanges,
      }));
      continue;
    }
    const analysis = analyseForward(deps, pr, substrate, terminalSha);
    if (!analysis) {
      labels.push(missingLabel(pr, target, deps, horizon, 'inaccessible_history', {
        terminalSha,
        lineRanges: substrate.lineRanges,
      }));
      continue;
    }

    const survivalRatio = analysis.totalLines === 0
      ? 1
      : analysis.survivingLines / analysis.totalLines;
    const linked = linkedReferencesAt(cutoffEpoch);
    const redispatched = redispatchAt(cutoffEpoch);
    const preMergeHumanEdit = options.preMergeHumanEdit === true;
    const followup =
      analysis.rangeFollowup || linked || redispatched || preMergeHumanEdit;
    const survived = !(analysis.reverted || followup);

    const undoneBy = analysis.rangeFollowup || analysis.reverted || preMergeHumanEdit
      ? attributeUndoers(
          deps, pr, terminalSha,
          analysis.rangeFollowup || analysis.reverted ? analysis.touchedPaths : [],
          preMergeHumanEdit ? ['human'] : [],
        )
      : null;

    const codes = new Set<ReasonCode>();
    if (analysis.reverted) codes.add('exact_revert');
    if (analysis.rangeFollowup) codes.add('line_range_followup');
    if (linked) codes.add('linked_issue_or_pr');
    if (preMergeHumanEdit) codes.add('pre_merge_human_edit');
    if (redispatched) codes.add('task_redispatch');
    if (!analysis.reverted && survivalRatio < SUBSTANTIAL_REWRITE_THRESHOLD) {
      codes.add('substantial_rewrite');
    }
    if (codes.size === 0) codes.add('no_evidence');

    labels.push(buildArbiterSurvivalLabel({
      prUrl: pr.prUrl,
      horizon_days: horizon,
      label_provenance: 'harvested',
      line_ranges: substrate.lineRanges,
      outcome: {
        survived,
        survival_ratio: survivalRatio,
        reverted: analysis.reverted,
        undone_by: undoneBy,
        followup,
        reason_codes: REASON_CODE_ORDER.filter((code) => codes.has(code)),
      },
      envelope: {
        labeller_version: SURVIVAL_LABELLER_VERSION,
        normalization_version: SURVIVAL_NORMALIZATION_VERSION,
        pr_head_sha: pr.headSha,
        merge_sha: pr.mergeSha,
        horizon_terminal_sha: terminalSha,
        integration_branch: target.integrationBranch,
        computed_at: deps.now().toISOString(),
      },
    }));
  }
  return labels;
}

// ── Base-rate summary ──────────────────────────────────────────────────────

export interface HorizonBaseRate {
  rows: number;
  missing: number;
  survived: number;
  followup: number;
  substantially_rewritten: number;
  reverted: number;
  /** survived / (rows - missing); null when no labelled rows. */
  survival_rate: number | null;
}

export interface SurvivalSummary {
  repo: string;
  totalRows: number;
  horizons: Record<string, HorizonBaseRate>;
}

/**
 * Per-repository, per-horizon base rates. A uniformly extreme rate (e.g.
 * ~98% survived everywhere) is a finding to report, not a bug to hide — the
 * summary is always emitted alongside the rows.
 */
export function summarizeLabels(
  repo: string,
  labels: readonly ArbiterSurvivalLabelV1[],
): SurvivalSummary {
  const horizons: Record<string, HorizonBaseRate> = {};
  for (const label of labels) {
    const key = String(label.horizon_days);
    const bucket = horizons[key] ?? {
      rows: 0, missing: 0, survived: 0, followup: 0,
      substantially_rewritten: 0, reverted: 0, survival_rate: null,
    };
    bucket.rows += 1;
    const outcome = label.outcome.report_outcome;
    if (outcome === null) bucket.missing += 1;
    else bucket[outcome] += 1;
    horizons[key] = bucket;
  }
  for (const bucket of Object.values(horizons)) {
    const labelled = bucket.rows - bucket.missing;
    bucket.survival_rate = labelled > 0 ? bucket.survived / labelled : null;
  }
  return { repo, totalRows: labels.length, horizons };
}
