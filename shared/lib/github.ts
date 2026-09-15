/**
 * GitHub CLI wrapper utilities for pull request operations.
 *
 * Provides type-safe wrappers around `gh` CLI commands for listing,
 * fetching, and diffing pull requests.
 *
 * @module github
 */

import { ensureCleanTree } from './git.ts';
import { runBuildCheck, type BuildCheckConfig } from './checks.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';

/**
 * Options for listing pull requests.
 */
export interface PullRequestListOptions {
  /** PR state filter */
  state?: 'open' | 'closed' | 'merged' | 'all';
  /** Filter by PR author username */
  author?: string;
  /** Maximum number of PRs to return */
  limit?: number;
  /** Repository in 'owner/name' format (defaults to current repo) */
  repo?: string;
}

/**
 * Options for getting a single pull request or diff.
 */
export interface PullRequestViewOptions {
  /** Repository in 'owner/name' format (defaults to current repo) */
  repo?: string;
}

/**
 * Options for PR label mutations.
 */
export interface PullRequestLabelOptions {
  /** Repository in 'owner/name' format (defaults to current repo) */
  repo?: string;
}

/**
 * Options for creating a pull request.
 */
export interface PullRequestCreateOptions {
  /** Repository in 'owner/name' format. */
  repo: string;
  /** Source branch name. */
  head: string;
  /** Target branch name. */
  base: string;
  /** PR title. */
  title: string;
  /** PR body/description. */
  body: string;
  /** Create as a draft PR. */
  draft?: boolean;
}

/**
 * Options for updating a pull request.
 */
export interface PullRequestUpdateOptions {
  /** Repository in 'owner/name' format. */
  repo: string;
  /** Updated PR title. */
  title?: string;
  /** Updated PR body/description. */
  body?: string;
}

/**
 * Minimal issue metadata used by label operations.
 */
export interface GitHubIssue {
  /** Issue number */
  number: number;
  /** Issue labels */
  labels: Array<{ name: string }>;
  /** Issue URL */
  url: string;
}

/**
 * Pull request metadata.
 */
export interface PullRequest {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body/description (only included in getPullRequest) */
  body?: string;
  /** PR state (OPEN, CLOSED, MERGED) */
  state: string;
  /** Author login */
  author: string;
  /** Head branch name */
  headRefName: string;
  /** Current head commit SHA */
  headRefOid?: string;
  /** Base branch name */
  baseRefName: string;
  /** PR labels */
  labels: Array<{ name: string }>;
  /** PR URL */
  url: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Merge timestamp (null if not merged) */
  mergedAt: string | null;
  /** Close timestamp (null if not closed) */
  closedAt: string | null;
}

/**
 * PR review from GitHub API.
 */
export interface PrReview {
  author: string;
  body: string;
  state: string;
  submittedAt: string;
}

/**
 * Pull request diff result.
 */
export interface PullRequestDiff {
  /** PR number */
  prNumber: number;
  /** Unified diff content */
  diff: string;
}

/**
 * Build a shell command from an array of arguments, properly escaping each one.
 *
 * @param args - Array of command arguments
 * @returns Escaped shell command string
 */
const buildShellCommand = (args: Array<string | number>): string => {
  return args.map((arg) => escapeShellArg(String(arg))).join(' ');
};

/**
 * Shared dependencies to allow focused unit tests without live gh calls.
 */
export const githubDeps = {
  execShellCommand,
  resolveOwnerRepo,
  getPullRequest: (prNumber: number | string, options: PullRequestViewOptions = {}) =>
    getPullRequest(prNumber, options),
  createPullRequest: (options: PullRequestCreateOptions) =>
    createPullRequest(options),
  updatePullRequest: (prNumber: number | string, options: PullRequestUpdateOptions) =>
    updatePullRequest(prNumber, options),
  getIssue: (issueNumber: number | string, options: PullRequestViewOptions = {}) =>
    getIssue(issueNumber, options),
  addLabelsToIssue: (issueNumber: number | string, labels: string[], options: PullRequestLabelOptions = {}) =>
    addLabelsToIssue(issueNumber, labels, options),
};

/**
 * Lists pull requests for a GitHub repository.
 *
 * @param options - Filter options
 * @returns Array of PR objects with structured data
 * @throws {Error} If gh CLI is not available or authenticated
 *
 * @example
 * ```typescript
 * // List open PRs
 * const openPRs = listPullRequests();
 *
 * // List closed PRs by specific author
 * const authorPRs = listPullRequests({ state: 'closed', author: 'timogilvie' });
 *
 * // List first 10 PRs
 * const recentPRs = listPullRequests({ limit: 10 });
 * ```
 */
export const listPullRequests = (options: PullRequestListOptions = {}): PullRequest[] => {
  const {
    state = 'open',
    author,
    limit,
    repo,
  } = options;

  try {
    const args: Array<string | number> = ['gh', 'pr', 'list'];

    // Add state filter
    args.push('--state', state);

    // Add author filter if provided
    if (author) {
      args.push('--author', author);
    }

    // Add limit if provided
    if (limit) {
      args.push('--limit', limit.toString());
    }

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    // Request JSON output with all needed fields
    args.push(
      '--json',
      'number,title,state,author,headRefName,headRefOid,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();

    if (!output) {
      return [];
    }

    const prs = JSON.parse(output) as Array<{
      number: number;
      title: string;
      state: string;
      author?: { login?: string } | string;
      headRefName: string;
      headRefOid?: string;
      baseRefName: string;
      labels?: Array<{ name: string }>;
      url: string;
      createdAt: string;
      updatedAt: string;
      mergedAt?: string | null;
      closedAt?: string | null;
    }>;

    // Transform to structured format
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: typeof pr.author === 'object' && pr.author?.login
        ? pr.author.login
        : String(pr.author || ''),
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    }));
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to list pull requests: ${err.message}`);
  }
};

/**
 * Fetches detailed metadata for a specific pull request.
 *
 * @param prNumber - The PR number
 * @param options - Options
 * @returns PR metadata object
 * @throws {Error} If PR is not found or gh CLI fails
 *
 * @example
 * ```typescript
 * // Get PR #42
 * const pr = getPullRequest(42);
 * console.log(pr.title, pr.author, pr.labels);
 * ```
 */
export const getPullRequest = (prNumber: number | string, options: PullRequestViewOptions = {}): PullRequest => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args: Array<string | number> = ['gh', 'pr', 'view', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    // Request JSON output with all needed fields
    args.push(
      '--json',
      'number,title,body,state,author,headRefName,headRefOid,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' }).trim();
    const pr = JSON.parse(output) as {
      number: number;
      title: string;
      body?: string;
      state: string;
      author?: { login?: string } | string;
      headRefName: string;
      headRefOid?: string;
      baseRefName: string;
      labels?: Array<{ name: string }>;
      url: string;
      createdAt: string;
      updatedAt: string;
      mergedAt?: string | null;
      closedAt?: string | null;
    };

    // Transform to structured format
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      author: typeof pr.author === 'object' && pr.author?.login
        ? pr.author.login
        : String(pr.author || ''),
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    };
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('Could not resolve to a PullRequest') ||
        err.message.includes('no pull requests found')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get pull request #${prNumber}: ${err.message}`);
  }
};

/**
 * Fetches the diff content for a pull request.
 *
 * @param prNumber - The PR number
 * @param options - Options
 * @returns Object containing PR number and diff content
 * @throws {Error} If PR is not found or diff is unavailable
 *
 * @example
 * ```typescript
 * // Get diff for PR #42
 * const { diff } = getPullRequestDiff(42);
 * console.log(diff); // Unified diff format
 * ```
 */
export const getPullRequestDiff = (prNumber: number | string, options: PullRequestViewOptions = {}): PullRequestDiff => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args: Array<string | number> = ['gh', 'pr', 'diff', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    const diff = execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });

    return {
      prNumber: parseInt(prNumber.toString(), 10),
      diff,
    };
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('could not find pull request') ||
        err.message.includes('HTTP 404') ||
        err.message.includes('Could not resolve to a PullRequest')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get diff for pull request #${prNumber}: ${err.message}`);
  }
};

/**
 * Create a pull request and return the resulting PR metadata.
 *
 * @param options - Pull request creation options
 * @returns Created pull request metadata
 * @throws {Error} If creation fails or the PR cannot be resolved afterwards
 */
export const createPullRequest = (options: PullRequestCreateOptions): PullRequest => {
  const { repo, head, base, title, body, draft = false } = options;

  if (!repo?.trim()) {
    throw new Error('Repository is required');
  }
  if (!head?.trim()) {
    throw new Error('Head branch is required');
  }
  if (!base?.trim()) {
    throw new Error('Base branch is required');
  }
  if (!title?.trim()) {
    throw new Error('Pull request title is required');
  }

  try {
    const args: Array<string> = [
      'gh',
      'pr',
      'create',
      '--repo',
      repo,
      '--head',
      head,
      '--base',
      base,
      '--title',
      title,
      '--body',
      body,
    ];

    if (draft) {
      args.push('--draft');
    }

    const output = githubDeps.execShellCommand(
      buildShellCommand(args),
      { encoding: 'utf-8' },
    ).trim();

    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
    if (urlMatch) {
      return githubDeps.getPullRequest(urlMatch[1], { repo });
    }

    const candidates = listPullRequests({ state: 'open', repo }).filter((pr) => (
      pr.headRefName === head && pr.baseRefName === base
    ));
    if (candidates.length > 0) {
      const created = candidates
        .slice()
        .sort((left, right) => right.number - left.number)[0];
      if (created) {
        return githubDeps.getPullRequest(created.number, { repo });
      }
    }

    throw new Error(`Created pull request could not be resolved for ${repo}:${head}->${base}`);
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('already exists') || err.message.includes('pull request for branch')) {
      throw new Error(`A pull request already exists for ${head} -> ${base}`);
    }
    if (err.message.includes('HTTP 404') || err.message.includes('not found')) {
      throw new Error(`Repository '${repo}' not found`);
    }
    if (err.message.includes('HTTP 422') || err.message.includes('No commits between')) {
      throw new Error(`Failed to create pull request: ${err.message}`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to create pull request: ${err.message}`);
  }
};

/**
 * Update an existing pull request and return refreshed metadata.
 *
 * @param prNumber - The PR number
 * @param options - Pull request update options
 * @returns Updated pull request metadata
 * @throws {Error} If the PR cannot be updated
 */
export const updatePullRequest = (
  prNumber: number | string,
  options: PullRequestUpdateOptions,
): PullRequest => {
  const { repo, title, body } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }
  if (!repo?.trim()) {
    throw new Error('Repository is required');
  }
  if (title === undefined && body === undefined) {
    throw new Error('At least one of title or body must be provided');
  }

  try {
    const args: Array<string> = ['gh', 'pr', 'edit', prNumber.toString(), '--repo', repo];

    if (title !== undefined) {
      args.push('--title', title);
    }
    if (body !== undefined) {
      args.push('--body', body);
    }

    githubDeps.execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });
    return githubDeps.getPullRequest(prNumber, { repo });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('Could not resolve to a PullRequest') ||
        err.message.includes('no pull requests found') ||
        err.message.includes('HTTP 404')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to update pull request #${prNumber}: ${err.message}`);
  }
};

/**
 * Fetch minimal issue metadata used by label mutations.
 *
 * @param issueNumber - The issue number
 * @param options - Options
 * @returns Issue metadata
 * @throws {Error} If the issue is not found or gh CLI fails
 */
export const getIssue = (
  issueNumber: number | string,
  options: PullRequestViewOptions = {},
): GitHubIssue => {
  const { repo } = options;

  if (!issueNumber) {
    throw new Error('Issue number is required');
  }

  try {
    const args: Array<string | number> = ['gh', 'issue', 'view', issueNumber.toString()];
    if (repo) {
      args.push('--repo', repo);
    }
    args.push('--json', 'number,labels,url');

    const output = githubDeps.execShellCommand(
      buildShellCommand(args),
      { encoding: 'utf-8' },
    ).trim();

    const issue = JSON.parse(output) as {
      number: number;
      labels?: Array<{ name: string }>;
      url: string;
    };

    return {
      number: issue.number,
      labels: issue.labels || [],
      url: issue.url,
    };
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('Could not resolve to an Issue') ||
        err.message.includes('HTTP 404') ||
        err.message.includes('no issue found')) {
      throw new Error(`Issue #${issueNumber} not found`);
    }
    if (err.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get issue #${issueNumber}: ${err.message}`);
  }
};

/**
 * Add labels to a pull request using GitHub's REST API.
 *
 * GitHub exposes pull requests as issues for label mutations. This path avoids
 * the deprecated GraphQL field used by `gh pr edit --add-label`.
 *
 * GitHub will create repository labels that do not already exist when the
 * authenticated user has permission to do so.
 *
 * @param prNumber - PR number to label
 * @param labels - Label names to add
 * @param options - Optional repo override
 * @returns Updated pull request metadata after labels are added
 * @throws {Error} If the PR cannot be found, the repo cannot be resolved, or the API call fails
 */
export const addLabelsToPullRequest = (
  prNumber: number | string,
  labels: string[],
  options: PullRequestLabelOptions = {},
): PullRequest => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const normalizedLabels = normalizePullRequestLabels(labels);
  const ownerRepo = repo || githubDeps.resolveOwnerRepo();

  if (!ownerRepo) {
    throw new Error('Unable to determine GitHub repository. Pass --repo owner/name or run from a GitHub checkout.');
  }

  try {
    const payload = JSON.stringify(normalizedLabels);
    const args: Array<string> = [
      'gh',
      'api',
      '--method',
      'POST',
      `repos/${ownerRepo}/issues/${prNumber.toString()}/labels`,
      '--input',
      '-',
    ];

    githubDeps.execShellCommand(
      `printf '%s' ${escapeShellArg(payload)} | ${buildShellCommand(args)}`,
      { encoding: 'utf-8' },
    );

    return githubDeps.getPullRequest(prNumber, { repo: ownerRepo });
  } catch (error) {
    throw wrapPullRequestLabelError(error, prNumber, 'add');
  }
};

/**
 * Remove a label from a pull request using GitHub's REST API.
 *
 * Missing labels are treated as a no-op so callers can safely retry cleanup.
 *
 * @param prNumber - PR number to update
 * @param label - Label name to remove
 * @param options - Optional repo override
 * @returns Updated pull request metadata after the removal attempt
 * @throws {Error} If the PR cannot be found, the repo cannot be resolved, or the API call fails
 */
export const removeLabelFromPullRequest = (
  prNumber: number | string,
  label: string,
  options: PullRequestLabelOptions = {},
): PullRequest => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  const normalizedLabel = normalizePullRequestLabel(label);
  const ownerRepo = repo || githubDeps.resolveOwnerRepo();

  if (!ownerRepo) {
    throw new Error('Unable to determine GitHub repository. Pass --repo owner/name or run from a GitHub checkout.');
  }

  try {
    const encodedLabel = encodeURIComponent(normalizedLabel);
    const args: Array<string> = [
      'gh',
      'api',
      '--method',
      'DELETE',
      `repos/${ownerRepo}/issues/${prNumber.toString()}/labels/${encodedLabel}`,
    ];

    githubDeps.execShellCommand(buildShellCommand(args), { encoding: 'utf-8' });
  } catch (error) {
    const err = error as Error;
    if (!isMissingPullRequestLabelError(err.message)) {
      throw wrapPullRequestLabelError(error, prNumber, 'remove');
    }
  }

  return githubDeps.getPullRequest(prNumber, { repo: ownerRepo });
};

/**
 * Add labels to an issue using GitHub's REST API.
 *
 * @param issueNumber - Issue number to label
 * @param labels - Label names to add
 * @param options - Optional repo override
 * @returns Updated issue metadata after labels are added
 * @throws {Error} If the issue cannot be found, the repo cannot be resolved, or the API call fails
 */
export const addLabelsToIssue = (
  issueNumber: number | string,
  labels: string[],
  options: PullRequestLabelOptions = {},
): GitHubIssue => {
  const { repo } = options;

  if (!issueNumber) {
    throw new Error('Issue number is required');
  }

  const normalizedLabels = normalizePullRequestLabels(labels);
  const ownerRepo = repo || githubDeps.resolveOwnerRepo();

  if (!ownerRepo) {
    throw new Error('Unable to determine GitHub repository. Pass --repo owner/name or run from a GitHub checkout.');
  }

  try {
    const payload = JSON.stringify(normalizedLabels);
    const args: Array<string> = [
      'gh',
      'api',
      '--method',
      'POST',
      `repos/${ownerRepo}/issues/${issueNumber.toString()}/labels`,
      '--input',
      '-',
    ];

    githubDeps.execShellCommand(
      `printf '%s' ${escapeShellArg(payload)} | ${buildShellCommand(args)}`,
      { encoding: 'utf-8' },
    );

    return githubDeps.getIssue(issueNumber, { repo: ownerRepo });
  } catch (error) {
    throw wrapIssueLabelError(error, issueNumber, 'add');
  }
};

function normalizePullRequestLabels(labels: string[]): string[] {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error('At least one label name is required');
  }

  const normalized = labels
    .map(normalizePullRequestLabel)
    .filter((label, index, all) => all.indexOf(label) === index);

  if (normalized.length === 0) {
    throw new Error('At least one label name is required');
  }

  return normalized;
}

function normalizePullRequestLabel(label: string): string {
  const normalized = String(label).trim();
  if (!normalized) {
    throw new Error('Label name is required');
  }
  return normalized;
}

function wrapPullRequestLabelError(
  error: unknown,
  prNumber: number | string,
  action: 'add' | 'remove',
): Error {
  const err = error as Error;
  const prefix = action === 'add' ? 'add labels to' : 'remove label from';

  if (err.message.includes('HTTP 404') ||
      err.message.includes('Could not resolve to an Issue') ||
      err.message.includes('Could not resolve to a PullRequest') ||
      err.message.includes('Not Found')) {
    return new Error(`Pull request #${prNumber} not found`);
  }

  if (err.message.includes('HTTP 403') || err.message.includes('Resource not accessible')) {
    return new Error(`Failed to ${prefix} pull request #${prNumber}: GitHub access denied. Check repository write permissions and gh auth status.`);
  }

  if (err.message.includes('gh:')) {
    return new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
  }

  return new Error(`Failed to ${prefix} pull request #${prNumber}: ${err.message}`);
}

function isMissingPullRequestLabelError(message: string): boolean {
  return message.includes('HTTP 404') ||
    message.includes('Label does not exist') ||
    message.includes('label does not exist') ||
    message.includes('Not Found');
}

function wrapIssueLabelError(
  error: unknown,
  issueNumber: number | string,
  action: 'add',
): Error {
  const err = error as Error;
  const prefix = `${action} labels to`;

  if (err.message.includes('HTTP 404') ||
      err.message.includes('Could not resolve to an Issue') ||
      err.message.includes('Not Found')) {
    return new Error(`Issue #${issueNumber} not found`);
  }

  if (err.message.includes('HTTP 403') || err.message.includes('Resource not accessible')) {
    return new Error(`Failed to ${prefix} issue #${issueNumber}: GitHub access denied. Check repository write permissions and gh auth status.`);
  }

  if (err.message.includes('gh:')) {
    return new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
  }

  return new Error(`Failed to ${prefix} issue #${issueNumber}: ${err.message}`);
}

/**
 * Resolve the GitHub owner/repo string (e.g. "timogilvie/wavemill") from
 * the git remote in the given directory.
 */
export function resolveOwnerRepo(repoDir?: string): string | undefined {
  const cwd = repoDir || process.cwd();

  try {
    const nwo = execShellCommand(
      'gh repo view --json nameWithOwner --jq .nameWithOwner',
      { encoding: 'utf-8', cwd, timeout: 10_000 },
    ).trim();
    return nwo || undefined;
  } catch {
    try {
      const remoteUrl = execShellCommand('git remote get-url origin', {
        encoding: 'utf-8',
        cwd,
        timeout: 5_000,
      }).trim();
      const match = remoteUrl.match(
        /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/,
      );
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

/**
 * Fetch normalized top-level PR reviews from GitHub.
 */
export function fetchPrReviews(
  prNumber: string,
  repoDir?: string,
  nwo?: string,
): PrReview[] {
  const cwd = repoDir || process.cwd();
  const repo = nwo || resolveOwnerRepo(cwd);

  if (!repo) {
    return [];
  }

  const reviewsRaw = githubDeps.execShellCommand(
    `gh api repos/${escapeShellArg(repo)}/pulls/${escapeShellArg(prNumber)}/reviews --jq '[.[] | {author: .user.login, state: .state, body: (.body // ""), submittedAt: (.submitted_at // "")}]'`,
    { encoding: 'utf-8', cwd, timeout: 15_000 },
  ).trim();

  if (!reviewsRaw) {
    return [];
  }

  const reviews = JSON.parse(reviewsRaw) as unknown;
  return Array.isArray(reviews) ? (reviews as PrReview[]) : [];
}

// Re-export for backward compatibility
export { ensureCleanTree, runBuildCheck };
export type { BuildCheckConfig };
