import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  getBranchOwnChanges,
  parseNameStatusOutput,
  type BranchDiffEvidence,
  type NameStatusEntry,
} from './git-branch-changes.ts';

// Re-export the parser + entry type so existing importers keep working while
// the canonical definitions live in `git-branch-changes.ts`.
export { parseNameStatusOutput, type NameStatusEntry } from './git-branch-changes.ts';
export type { BranchDiffEvidence } from './git-branch-changes.ts';

type ShellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;

export interface CrossPrRevertDetectionOptions {
  repoDir: string;
  baseRef: string;
  headRef: string;
  integrationRef: string;
  maxRecentMerges?: number;
  shellRunner?: ShellRunner;
}

export interface CrossPrRevertFile {
  path: string;
  status: 'deleted' | 'modified';
  confidence: 'deleted' | 'reverted' | 'missing-survivor';
}

export interface CrossPrRevertFinding {
  prNumber: number;
  files: CrossPrRevertFile[];
  mergeCommit?: string;
  title?: string;
}

/**
 * Result of `detectCrossPrReverts`. The branch-diff evidence is exposed so an
 * operator can reproduce (or verify) a finding from the exact SHAs the guard
 * compared — the same evidence lands in `.ready-result.json` via the tool
 * wrapper.
 */
export interface CrossPrRevertDetection {
  findings: CrossPrRevertFinding[];
  evidence: BranchDiffEvidence;
}

interface RecentPrCommit {
  commit: string;
  parent: string;
  prNumber: number;
  title: string;
}

const DEFAULT_MAX_RECENT_MERGES = 50;

export function parseRevertAcknowledgements(text?: string | null): Set<number> {
  const acknowledgements = new Set<number>();
  if (!text) {
    return acknowledgements;
  }

  for (const match of text.matchAll(/\b(?:reverts|intentionally reverts)\s+#(\d+)\b/gi)) {
    acknowledgements.add(Number(match[1]));
  }

  return acknowledgements;
}

export function filterUnacknowledgedReverts(
  findings: CrossPrRevertFinding[],
  acknowledgements: ReadonlySet<number>,
): CrossPrRevertFinding[] {
  return findings.filter((finding) => !acknowledgements.has(finding.prNumber));
}

/**
 * Detect cross-PR reverts, gating every classification on the branch's own
 * commits.
 *
 * The detector self-normalizes: `baseRef` may be the caller-provided branch
 * point *or* a plain integration tip. Both work, because the classification
 * facts are derived from `merge-base(baseRef, headRef)..headRef` — i.e. only
 * changes the branch itself introduced. This protects every caller (the ready
 * gate in `wavemill-monitor.sh`, `review-runner`, `review-scope-guard`, and
 * the CLI wrapper) from the "branch behind base is treated as reverting"
 * failure mode (HOK-3091, HOK-2788).
 *
 * The returned `evidence` records the concrete SHAs used so a finding can be
 * reproduced without re-deriving them from mutable refs.
 */
export function detectCrossPrReverts(
  options: CrossPrRevertDetectionOptions,
): CrossPrRevertDetection {
  const shellRunner = options.shellRunner ?? defaultShellRunner;
  const { entries: branchOwnEntries, evidence } = getBranchOwnChanges({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    headRef: options.headRef,
    shellRunner,
  });

  const deletedPaths = new Set(
    branchOwnEntries.filter((entry) => entry.status === 'D').map((entry) => entry.path),
  );
  const branchTouchedPaths = new Set<string>();
  for (const entry of branchOwnEntries) {
    branchTouchedPaths.add(entry.path);
    if (entry.previousPath) {
      branchTouchedPaths.add(entry.previousPath);
    }
  }

  const findings = collectRecentPrCommits(
    shellRunner,
    options.repoDir,
    options.integrationRef,
    options.maxRecentMerges,
  )
    .map((commit) => {
      const revertedFiles = parseNameStatusOutput(
        runGit(
          shellRunner,
          options.repoDir,
          `git diff --name-status ${escapeShellArg(commit.parent)} ${escapeShellArg(commit.commit)}`,
        ),
      )
        .map((entry) => classifyRevertedPrFile(
          shellRunner,
          options.repoDir,
          options.integrationRef,
          options.headRef,
          commit,
          entry,
          deletedPaths,
          branchTouchedPaths,
        ))
        .filter((entry): entry is CrossPrRevertFile => entry !== null);

      if (revertedFiles.length === 0) {
        return null;
      }

      return {
        prNumber: commit.prNumber,
        files: revertedFiles,
        mergeCommit: commit.commit,
        title: commit.title,
      } satisfies CrossPrRevertFinding;
    })
    .filter((finding): finding is CrossPrRevertFinding => finding !== null);

  return { findings, evidence };
}

export function detectSurvivingChangeWarnings(
  options: CrossPrRevertDetectionOptions,
): CrossPrRevertFinding[] {
  const shellRunner = options.shellRunner ?? defaultShellRunner;

  return collectRecentPrCommits(
    shellRunner,
    options.repoDir,
    `${options.baseRef}..${options.integrationRef}`,
    options.maxRecentMerges,
  )
    .map((commit) => {
      const missingFiles = parseNameStatusOutput(
        runGit(
          shellRunner,
          options.repoDir,
          `git diff --name-status ${escapeShellArg(commit.parent)} ${escapeShellArg(commit.commit)}`,
        ),
      )
        .filter((entry) => entry.status === 'A' && !fileExistsAtRef(shellRunner, options.repoDir, options.headRef, entry.path))
        .map((entry) => ({
          path: entry.path,
          status: 'deleted' as const,
          confidence: 'missing-survivor' as const,
        }));

      if (missingFiles.length === 0) {
        return null;
      }

      return {
        prNumber: commit.prNumber,
        files: missingFiles,
        mergeCommit: commit.commit,
        title: commit.title,
      } satisfies CrossPrRevertFinding;
    })
    .filter((finding): finding is CrossPrRevertFinding => finding !== null);
}

function collectRecentPrCommits(
  shellRunner: ShellRunner,
  repoDir: string,
  revisionRange: string,
  maxRecentMerges?: number,
): RecentPrCommit[] {
  const limit = maxRecentMerges ?? DEFAULT_MAX_RECENT_MERGES;
  const output = runGit(
    shellRunner,
    repoDir,
    `git log --first-parent --merges --max-count=${limit} --pretty=format:%H%x09%P%x09%s ${escapeShellArg(revisionRange)}`,
  ).trim();

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map(parseRecentPrCommit)
    .filter((commit): commit is RecentPrCommit => commit !== null);
}

function parseRecentPrCommit(line: string): RecentPrCommit | null {
  const [commit, parentsText = '', subject = ''] = line.split('\t');
  if (!commit || !subject) {
    return null;
  }

  const parents = parentsText.trim().split(/\s+/).filter(Boolean);
  if (parents.length < 2) {
    return null;
  }

  const prNumber = extractPrNumber(subject);
  if (prNumber === null) {
    return null;
  }

  const parent = parents[0];
  if (!parent) {
    return null;
  }

  return {
    commit,
    parent,
    prNumber,
    title: subject.trim(),
  };
}

export function extractPrNumber(subject: string): number | null {
  const match = subject.match(/merge pull request #(\d+)\b/i)
    ?? subject.match(/\(#(\d+)\)\s*$/i);
  if (!match) {
    return null;
  }

  const prNumber = Number(match[1]);
  return Number.isInteger(prNumber) ? prNumber : null;
}

function fileExistsAtRef(
  shellRunner: ShellRunner,
  repoDir: string,
  ref: string,
  path: string,
): boolean {
  try {
    runGit(
      shellRunner,
      repoDir,
      `git cat-file -e ${escapeShellArg(`${ref}:${path}`)} 2>/dev/null`,
    );
    return true;
  } catch {
    return false;
  }
}

function classifyRevertedPrFile(
  shellRunner: ShellRunner,
  repoDir: string,
  integrationRef: string,
  headRef: string,
  commit: RecentPrCommit,
  entry: NameStatusEntry,
  deletedPaths: ReadonlySet<string>,
  branchTouchedPaths: ReadonlySet<string>,
): CrossPrRevertFile | null {
  const headBlob = blobIdAtRef(shellRunner, repoDir, headRef, entry.path);

  // The guard's question is whether merging this branch undoes work that is still on
  // the integration branch. When the integration tip and the head agree on a path
  // (including both missing it), the merge changes nothing there — the deletion or
  // rollback already landed upstream. Without this, one upstream revert commit blocks
  // every PR branched off that integration tip until the merge leaves the scan window.
  if (blobIdAtRef(shellRunner, repoDir, integrationRef, entry.path) === headBlob) {
    return null;
  }

  if (entry.status === 'A' && deletedPaths.has(entry.path)) {
    return {
      path: entry.path,
      status: 'deleted',
      confidence: 'deleted',
    };
  }

  const prBlob = blobIdAtRef(shellRunner, repoDir, commit.commit, entry.path);
  if (!headBlob) {
    // A missing head blob is not proof the branch deleted this path — a branch
    // that is simply behind base never had the file. Only flag it when the
    // branch's own merge-base..head diff records a matching delete (HOK-3091).
    if (
      (entry.status === 'A' || entry.status === 'M' || entry.status === 'R')
      && deletedPaths.has(entry.path)
    ) {
      return {
        path: entry.path,
        status: 'deleted',
        confidence: 'deleted',
      };
    }
    return null;
  }

  // The blob-equality "reverted" case is only meaningful when the branch's own
  // commits touched this path — a behind-base branch that never modified the
  // file still has the pre-PR blob at head, and that is inherited staleness,
  // not a revert (HOK-3091).
  if (!branchTouchedPaths.has(entry.path)) {
    return null;
  }

  const parentPath = entry.previousPath ?? entry.path;
  const parentBlob = blobIdAtRef(shellRunner, repoDir, commit.parent, parentPath);
  if (parentBlob && prBlob && headBlob === parentBlob && headBlob !== prBlob) {
    return {
      path: entry.path,
      status: 'modified',
      confidence: 'reverted',
    };
  }

  return null;
}

function blobIdAtRef(
  shellRunner: ShellRunner,
  repoDir: string,
  ref: string,
  path: string,
): string | null {
  try {
    return runGit(
      shellRunner,
      repoDir,
      `git rev-parse ${escapeShellArg(`${ref}:${path}`)} 2>/dev/null`,
    ).trim() || null;
  } catch {
    return null;
  }
}

function runGit(
  shellRunner: ShellRunner,
  repoDir: string,
  cmd: string,
): string {
  return String(shellRunner(cmd, { encoding: 'utf-8', cwd: repoDir }));
}

function defaultShellRunner(
  cmd: string,
  opts?: { encoding?: string; cwd?: string },
): string {
  return String(execShellCommand(cmd, opts));
}
