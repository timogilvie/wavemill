/**
 * GitHub CI check discovery engine.
 *
 * Discovers branch-protection required checks from GitHub without assuming
 * command mappings. Returns check names and workflow job provenance for
 * explicit recipe configuration.
 *
 * Does not execute workflow YAML locally — only discovers available checks.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cachedNameWithOwner, cachedRequiredChecks } from './session-gh-cache.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface GitHubDiscoveryResult {
  checks: string[];
  source: 'protection' | 'ruleset' | 'mixed';
  timestamp: string; // ISO 8601
  workflows?: WorkflowJob[];
}

export interface WorkflowJob {
  name: string;
  path: string; // Relative path to workflow file
  triggers: string[]; // Event triggers (push, pull_request, etc.)
}

export interface ParsedWorkflowJob {
  jobName: string;
  jobKey: string;
  workflowPath: string;
}

export class GitHubPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPermissionError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAPIError';
  }
}

// ────────────────────────────────────────────────────────────────
// Discovery Functions
// ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Retry a function on transient failures (network errors, rate limits).
 * Throws on persistent errors.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      // Don't retry permission errors
      if (err instanceof GitHubPermissionError) {
        throw err;
      }

      // Check if this is a transient error
      const isTransient =
        /timeout|ECONNRESET|ECONNREFUSED|rate limit/i.test((err as Error).message);

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      // Exponential backoff
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Unknown error in retryWithBackoff');
}

/**
 * Discover required checks from GitHub branch protection or rulesets.
 *
 * @param repo Repository in "owner/repo" format
 * @param branch Branch name (default: integration)
 * @returns Discovery result with check names and source
 * @throws GitHubPermissionError if auth is missing or insufficient
 * @throws GitHubNotFoundError if repo/branch not found
 */
export async function discoverGitHubRequiredChecks(
  repo: string,
  branch = 'auto/integration',
): Promise<GitHubDiscoveryResult> {
  const checks = new Set<string>();
  let source: 'protection' | 'ruleset' | 'mixed' = 'protection';

  // Try branch protection rules first. Do NOT redirect stderr into stdout;
  // gh writes API errors (HTTP 403/404) to stderr and we need to classify
  // them off err.stderr on failure. Redirecting also pollutes stdout on
  // success, which we split as a checks list.
  try {
    // HOK-3206: inside a mill session the protection contexts for this repo
    // are cached once per base branch; rulesets below are still read live.
    const cachedProtection = cachedNameWithOwner() === repo ? cachedRequiredChecks(branch) : undefined;
    const protection = cachedProtection ?? await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/branches/${branch}/protection/required_status_checks --jq '.contexts[]'`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return output.trim().split('\n').filter((line) => line.length > 0);
    });

    for (const check of protection) {
      checks.add(check);
    }
  } catch (err) {
    const classified = classifyGhError(err, `${repo}/${branch}`);
    if (classified) throw classified;
    // Other errors — try rulesets below
  }

  // Try rulesets (GitHub Enterprise / newer API)
  try {
    const rulesets = await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/rulesets --jq '.[] | select(.target == "branch") | .rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]'`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return output.trim().split('\n').filter((line) => line.length > 0);
    });

    const hadProtection = checks.size > 0;
    for (const check of rulesets) {
      checks.add(check);
    }
    if (rulesets.length > 0) {
      source = hadProtection ? 'mixed' : 'ruleset';
    }
  } catch (err) {
    // Rulesets not available is not an error
    if (!/not found|404|does not exist/i.test((err as Error).message)) {
      if (checks.size === 0) {
        // No checks from either source
        throw new GitHubAPIError(
          `Failed to discover checks from GitHub.\n` +
          `Ensure gh CLI is installed and authenticated: gh auth login\n` +
          `Error: ${(err as Error).message}`,
        );
      }
    }
  }

  if (checks.size === 0) {
    throw new GitHubAPIError(
      `No required checks found for ${repo}/${branch}\n` +
      `Repository may not have branch protection configured.`,
    );
  }

  return {
    checks: Array.from(checks).sort(),
    source,
    timestamp: new Date().toISOString(),
  };
}

/**
 * List all GitHub Actions workflow jobs in the repository.
 *
 * @param repo Repository in "owner/repo" format
 * @returns List of workflow jobs with names and triggers
 * @throws GitHubPermissionError if auth is missing
 */
export async function getWorkflowJobs(repo: string): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];

  try {
    const workflows = await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/actions/workflows --jq '[.workflows[] | {path: .path, name: .name}]'`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return JSON.parse(output);
    });

    for (const workflow of workflows) {
      try {
        const content = await retryWithBackoff(async () => {
          return execSync(
            `gh api repos/${repo}/contents/${workflow.path} --jq '.content | @base64d'`,
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
        });

        // Parse YAML to extract jobs and triggers (simplified)
        // In production, use a YAML parser library
        const triggers = parseWorkflowTriggers(content);
        const workflowJobs = parseWorkflowJobsFromYaml(content, workflow.path);

        for (const job of workflowJobs) {
          jobs.push({
            name: job.jobName,
            path: workflow.path,
            triggers,
          });
        }
      } catch {
        // Skip workflows we can't read
      }
    }
  } catch (err) {
    const classified = classifyGhError(err, `${repo}/actions/workflows`);
    if (classified instanceof GitHubPermissionError) {
      throw classified;
    }
    // Other errors are non-fatal for workflow listing
  }

  return jobs;
}

/**
 * Read local GitHub Actions workflow job names without executing workflow YAML.
 *
 * @param repoDir Repository root.
 * @param workflowFiles Optional repo-relative workflow file allowlist.
 */
export function readLocalWorkflowJobs(
  repoDir: string,
  workflowFiles?: string[],
): { jobs: ParsedWorkflowJob[]; skipped: string[] } {
  const files = workflowFiles?.length
    ? workflowFiles
    : listLocalWorkflowFiles(repoDir);
  const jobs: ParsedWorkflowJob[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const absolutePath = resolve(repoDir, file);
    try {
      const yaml = readFileSync(absolutePath, 'utf-8');
      jobs.push(...parseWorkflowJobsFromYaml(yaml, normalizeWorkflowPath(repoDir, absolutePath)));
    } catch {
      skipped.push(file);
    }
  }

  return { jobs, skipped };
}

/**
 * Classify a failed `gh api` invocation. Inspects both err.message (Node's
 * synthesized "Command failed …") AND err.stderr (where gh writes HTTP
 * status messages like "HTTP 403" and "gh: Not Found (HTTP 404)"). Returns
 * a typed error to throw, or null if the caller should treat this as
 * recoverable / try-next-strategy.
 */
function classifyGhError(err: unknown, context: string): Error | null {
  const raw = err as any;
  const stderr = typeof raw?.stderr === 'string' ? raw.stderr : (raw?.stderr?.toString?.() ?? '');
  const message = typeof raw?.message === 'string' ? raw.message : String(raw);
  const combined = `${message}\n${stderr}`;

  if (/HTTP 404|Not Found|does not exist/i.test(combined)) {
    return new GitHubNotFoundError(
      `GitHub resource not found: ${context}\n${stderr || message}`,
    );
  }
  if (/HTTP 401|HTTP 403|permission denied|unauthorized|requires authentication/i.test(combined)) {
    return new GitHubPermissionError(
      `GitHub API permission denied for ${context}. Authenticate with: gh auth login\n${stderr || message}`,
    );
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Extract trigger events from GitHub Actions workflow YAML.
 * Simplified parser — uses regex to find 'on:' section.
 */
function parseWorkflowTriggers(yaml: string): string[] {
  const triggers: string[] = [];

  const onContent = collectTopLevelSection(yaml, 'on');
  if (onContent) {
    // Extract trigger names (push, pull_request, etc.)
    const lines = onContent.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([a-z_]+):\s*(?:$|#)/);
      if (match) {
        triggers.push(match[1]);
      }
    }
  }

  return triggers.length > 0 ? triggers : ['unknown'];
}

/**
 * Extract job names from GitHub Actions workflow YAML.
 * Simplified parser — uses regex to find 'jobs:' section.
 */
export function parseWorkflowJobsFromYaml(yaml: string, workflowPath: string): ParsedWorkflowJob[] {
  const jobs: ParsedWorkflowJob[] = [];

  const jobsContent = collectTopLevelSection(yaml, 'jobs');
  if (jobsContent) {
    const lines = jobsContent.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      const match = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_-]*):\s*(?:$|#)/);
      if (match && match[1].length === 2) {
        const jobKey = match[2];
        const block = collectIndentedBlock(lines, index + 1, 2);
        const configuredName = extractJobName(block) ?? jobKey;
        for (const jobName of expandMatrixJobNames(configuredName, block)) {
          jobs.push({
            jobName,
            jobKey,
            workflowPath,
          });
        }
      }
    }
  }

  return jobs;
}

function collectTopLevelSection(yaml: string, key: string): string | null {
  const lines = yaml.split('\n');
  const startIndex = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegExp(key)}:\\s*(?:$|#)`)));
  if (startIndex === -1) return null;

  const section: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line)) break;
    section.push(line);
  }
  return section.join('\n');
}

function listLocalWorkflowFiles(repoDir: string): string[] {
  const workflowDir = resolve(repoDir, '.github', 'workflows');
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir)
    .filter((entry) => /\.(ya?ml)$/i.test(entry))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => join('.github', 'workflows', entry));
}

function normalizeWorkflowPath(repoDir: string, absolutePath: string): string {
  return relative(repoDir, absolutePath).replaceAll('\\', '/');
}

function collectIndentedBlock(lines: string[], startIndex: number, parentIndent: number): string[] {
  const block: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    block.push(line);
  }
  return block;
}

function extractJobName(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/^\s{4}name:\s*(.+?)\s*$/);
    if (match) {
      return unquoteYamlScalar(match[1]);
    }
  }
  return undefined;
}

function expandMatrixJobNames(jobName: string, jobBlock: string[]): string[] {
  const matrixVariables = extractInlineMatrixVariables(jobBlock);
  let names = [jobName];

  for (const [variable, values] of matrixVariables) {
    const pattern = new RegExp(`\\$\\{\\{\\s*matrix\\.${escapeRegExp(variable)}\\s*\\}\\}`);
    const globalPattern = new RegExp(`\\$\\{\\{\\s*matrix\\.${escapeRegExp(variable)}\\s*\\}\\}`, 'g');
    names = names.flatMap((name) => (
      pattern.test(name)
        ? values.map((value) => name.replace(globalPattern, value))
        : [name]
    ));
  }

  return uniqueStable(names);
}

function extractInlineMatrixVariables(jobBlock: string[]): Map<string, string[]> {
  const variables = new Map<string, string[]>();
  for (const line of jobBlock) {
    const match = line.match(/^\s{8}([A-Za-z_][A-Za-z0-9_-]*):\s*\[(.+)]\s*$/);
    if (!match) continue;
    const values = match[2]
      .split(',')
      .map((value) => unquoteYamlScalar(value.trim()))
      .filter(Boolean);
    if (values.length > 0) {
      variables.set(match[1], values);
    }
  }
  return variables;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function uniqueStable(values: string[]): string[] {
  return Array.from(new Set(values));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
