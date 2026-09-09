import { escapeShellArg, execShellCommand } from './shell-utils.ts';

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

interface RecentPrCommit {
  commit: string;
  parent: string;
  prNumber: number;
  title: string;
}

export interface NameStatusEntry {
  status: string;
  path: string;
  previousPath?: string;
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

export function detectCrossPrReverts(
  options: CrossPrRevertDetectionOptions,
): CrossPrRevertFinding[] {
  const shellRunner = options.shellRunner ?? defaultShellRunner;
  const deletedPaths = new Set(
    parseNameStatusOutput(
      runGit(
        shellRunner,
        options.repoDir,
        `git diff --name-status ${escapeShellArg(options.baseRef)} ${escapeShellArg(options.headRef)}`,
      ),
    )
      .filter((entry) => entry.status === 'D')
      .map((entry) => entry.path),
  );

  return collectRecentPrCommits(shellRunner, options.repoDir, options.integrationRef, options.maxRecentMerges)
    .map((commit) => {
      const revertedFiles = parseNameStatusOutput(
        runGit(
          shellRunner,
          options.repoDir,
          `git diff --name-status ${escapeShellArg(commit.parent)} ${escapeShellArg(commit.commit)}`,
        ),
      )
        .map((entry) => classifyRevertedPrFile(shellRunner, options.repoDir, options.integrationRef, options.headRef, commit, entry, deletedPaths))
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

export function parseNameStatusOutput(output: string): NameStatusEntry[] {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [statusToken, firstPath = '', secondPath = ''] = line.split('\t');
      const status = statusToken?.trim() ?? '';
      const normalizedStatus = status[0] ?? '';
      const path = normalizedStatus === 'R' || normalizedStatus === 'C'
        ? secondPath
        : firstPath;

      return {
        status: normalizedStatus,
        path,
        previousPath: normalizedStatus === 'R' || normalizedStatus === 'C' ? firstPath : undefined,
      };
    })
    .filter((entry) => entry.status && entry.path);
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
    if (entry.status === 'A' || entry.status === 'M' || entry.status === 'R') {
      return {
        path: entry.path,
        status: 'deleted',
        confidence: 'deleted',
      };
    }
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
