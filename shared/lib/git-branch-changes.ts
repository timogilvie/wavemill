/**
 * Helpers that describe a branch's *own* changes relative to a base ref via the
 * merge base, so a branch that is merely behind the base is never mistaken for
 * one that reverts base-side work (HOK-3091).
 *
 * The classic mistake is a 2-dot diff — `git diff <baseTip> <headTip>` — which
 * attributes every file the base gained after the branch point to the branch
 * as a deletion. The correct choke point is `merge-base..head`, which is
 * exactly the set of changes the branch's own commits introduced.
 *
 * These helpers **do not** perform origin-first ref resolution: every current
 * caller (`tools/check-cross-pr-reverts.ts`, `wavemill-monitor.sh`,
 * `review-runner`, `review-scope-guard`) already resolves refs upstream, and
 * doing it twice would make the recorded SHA evidence ambiguous.
 *
 * @module git-branch-changes
 */
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

export type ShellRunner = (
  cmd: string,
  opts?: { encoding?: string; cwd?: string },
) => string;

/**
 * A single `git diff --name-status` entry. `previousPath` is the pre-rename
 * source when the status is `R` (rename) or `C` (copy); `path` is always the
 * post-change name so downstream callers can key on the current tree.
 */
export interface NameStatusEntry {
  status: string;
  path: string;
  previousPath?: string;
}

/**
 * Concrete SHAs recorded for an operator to reproduce a branch-diff result.
 * `baseRef`/`headRef` are the refs the caller passed (already resolved
 * origin-first upstream); the SHAs are the three points the helper compared.
 */
export interface BranchDiffEvidence {
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
}

export interface BranchOwnChanges {
  entries: NameStatusEntry[];
  evidence: BranchDiffEvidence;
}

export interface GetBranchOwnChangesOptions {
  repoDir: string;
  baseRef: string;
  headRef: string;
  shellRunner?: ShellRunner;
}

/**
 * Resolve `baseRef`/`headRef` to concrete SHAs and derive their merge base.
 *
 * Throws with the underlying git stderr when any of the three commands fails
 * (unresolvable ref, unrelated histories, …). Callers already have their own
 * failure handlers for the surrounding operation, so this stays fail-fast.
 */
export function resolveBranchDiffBase(
  options: GetBranchOwnChangesOptions,
): BranchDiffEvidence {
  const shellRunner = options.shellRunner ?? defaultShellRunner;
  const baseSha = revParse(shellRunner, options.repoDir, options.baseRef);
  const headSha = revParse(shellRunner, options.repoDir, options.headRef);
  const mergeBaseSha = runGit(
    shellRunner,
    options.repoDir,
    `git merge-base ${escapeShellArg(baseSha)} ${escapeShellArg(headSha)}`,
  ).trim();
  if (!mergeBaseSha) {
    throw new Error(
      `git merge-base returned an empty base for ${options.baseRef} and ${options.headRef}`,
    );
  }
  return {
    baseRef: options.baseRef,
    headRef: options.headRef,
    baseSha,
    headSha,
    mergeBaseSha,
  };
}

/**
 * Return the branch's own name-status changes (merge-base..head) plus the
 * evidence SHAs. This is the correct input for any check that must
 * distinguish "the branch did X" from "the base evolved after the branch was
 * cut". A branch behind base returns entries drawn *only* from its own
 * commits; the extra files the base has since gained are not reported.
 */
export function getBranchOwnChanges(
  options: GetBranchOwnChangesOptions,
): BranchOwnChanges {
  const shellRunner = options.shellRunner ?? defaultShellRunner;
  const evidence = resolveBranchDiffBase({ ...options, shellRunner });
  const entries = parseNameStatusOutput(
    runGit(
      shellRunner,
      options.repoDir,
      `git diff --name-status ${escapeShellArg(evidence.mergeBaseSha)} ${escapeShellArg(evidence.headSha)}`,
    ),
  );
  return { entries, evidence };
}

/**
 * Parse the tab-separated output of `git diff --name-status`.
 *
 * Handles rename (`R`) and copy (`C`) entries by placing the post-change name
 * in `path` and preserving the pre-change name in `previousPath`, so callers
 * that care about both sides of a rename have them.
 */
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
        previousPath:
          normalizedStatus === 'R' || normalizedStatus === 'C'
            ? firstPath
            : undefined,
      };
    })
    .filter((entry) => entry.status && entry.path);
}

function revParse(
  shellRunner: ShellRunner,
  repoDir: string,
  ref: string,
): string {
  return runGit(
    shellRunner,
    repoDir,
    `git rev-parse --verify ${escapeShellArg(`${ref}^{commit}`)}`,
  ).trim();
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
