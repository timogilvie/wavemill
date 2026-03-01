import { execSync } from "node:child_process";
import { ensureCleanTree } from './git.js';
import { runBuildCheck } from './checks.js';

/**
 * Lists pull requests for a GitHub repository.
 *
 * @param {Object} [options={}] - Filter options
 * @param {('open'|'closed'|'merged'|'all')} [options.state='open'] - PR state filter
 * @param {string} [options.author] - Filter by PR author username
 * @param {number} [options.limit] - Maximum number of PRs to return
 * @param {string} [options.repo] - Repository in 'owner/name' format (defaults to current repo)
 * @returns {Array<Object>} Array of PR objects with structured data
 * @throws {Error} If gh CLI is not available or authenticated
 *
 * @example
 * // List open PRs
 * const openPRs = listPullRequests();
 *
 * // List closed PRs by specific author
 * const authorPRs = listPullRequests({ state: 'closed', author: 'timogilvie' });
 *
 * // List first 10 PRs
 * const recentPRs = listPullRequests({ limit: 10 });
 */
export const listPullRequests = (options = {}) => {
  const {
    state = 'open',
    author,
    limit,
    repo,
  } = options;

  try {
    const args = ['gh', 'pr', 'list'];

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
      'number,title,state,author,headRefName,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = execSync(args.join(' '), { encoding: 'utf-8' }).trim();

    if (!output) {
      return [];
    }

    const prs = JSON.parse(output);

    // Transform to structured format
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.author?.login || pr.author,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    }));
  } catch (error) {
    if (error.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to list pull requests: ${error.message}`);
  }
};

/**
 * Fetches detailed metadata for a specific pull request.
 *
 * @param {number|string} prNumber - The PR number
 * @param {Object} [options={}] - Options
 * @param {string} [options.repo] - Repository in 'owner/name' format (defaults to current repo)
 * @returns {Object} PR metadata object
 * @throws {Error} If PR is not found or gh CLI fails
 *
 * @example
 * // Get PR #42
 * const pr = getPullRequest(42);
 * console.log(pr.title, pr.author, pr.labels);
 */
export const getPullRequest = (prNumber, options = {}) => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args = ['gh', 'pr', 'view', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    // Request JSON output with all needed fields
    args.push(
      '--json',
      'number,title,body,state,author,headRefName,baseRefName,labels,url,createdAt,updatedAt,mergedAt,closedAt'
    );

    const output = execSync(args.join(' '), { encoding: 'utf-8' }).trim();
    const pr = JSON.parse(output);

    // Transform to structured format
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      author: pr.author?.login || pr.author,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      labels: pr.labels || [],
      url: pr.url,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt || null,
      closedAt: pr.closedAt || null,
    };
  } catch (error) {
    if (error.message.includes('Could not resolve to a PullRequest') ||
        error.message.includes('no pull requests found')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (error.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get pull request #${prNumber}: ${error.message}`);
  }
};

/**
 * Fetches the diff content for a pull request.
 *
 * @param {number|string} prNumber - The PR number
 * @param {Object} [options={}] - Options
 * @param {string} [options.repo] - Repository in 'owner/name' format (defaults to current repo)
 * @returns {{ prNumber: number, diff: string }} Object containing PR number and diff content
 * @throws {Error} If PR is not found or diff is unavailable
 *
 * @example
 * // Get diff for PR #42
 * const { diff } = getPullRequestDiff(42);
 * console.log(diff); // Unified diff format
 */
export const getPullRequestDiff = (prNumber, options = {}) => {
  const { repo } = options;

  if (!prNumber) {
    throw new Error('PR number is required');
  }

  try {
    const args = ['gh', 'pr', 'diff', prNumber.toString()];

    // Add repo if provided
    if (repo) {
      args.push('--repo', repo);
    }

    const diff = execSync(args.join(' '), { encoding: 'utf-8' });

    return {
      prNumber: parseInt(prNumber.toString(), 10),
      diff,
    };
  } catch (error) {
    if (error.message.includes('could not find pull request') ||
        error.message.includes('HTTP 404') ||
        error.message.includes('Could not resolve to a PullRequest')) {
      throw new Error(`Pull request #${prNumber} not found`);
    }
    if (error.message.includes('gh:')) {
      throw new Error('GitHub CLI (gh) is not available or not authenticated. Please install and authenticate with: gh auth login');
    }
    throw new Error(`Failed to get diff for pull request #${prNumber}: ${error.message}`);
  }
};

