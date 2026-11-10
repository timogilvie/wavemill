import type { ToolDescriptor, WavemillToolResult } from '../tools/types.ts';
import { getRedactionConfig } from '../../config.ts';
import { buildTrustMetadata } from '../provenance.ts';
import { buildProfileFromConfig, redact } from '../../redaction-profiles.ts';
import {
  addLabelsToIssue,
  addLabelsToPullRequest,
  createPullRequest as createPullRequestViaGh,
  getIssue,
  getPullRequest,
  listPullRequests,
  updatePullRequest as updatePullRequestViaGh,
  type GitHubIssue,
  type PullRequest,
} from '../../github.ts';
import {
  githubAddLabelKey,
  githubCreatePrKey,
} from './dedupe.ts';
import {
  enforceNetworkPolicy,
  type NetworkDeniedDiagnostics,
  type NetworkPolicy,
} from '../network-policy.ts';
import {
  isMutationAllowed,
} from './mutation-policy.ts';
import type {
  GitHubAddLabelRequest,
  GitHubAddLabelResult,
  GitHubCreatePrRequest,
  GitHubCreatePrResult,
  GitHubLabelRef,
  GitHubPullRequestRef,
  WorkflowPhase,
} from './contracts.ts';

const DEFAULT_PHASE: WorkflowPhase = 'review';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

export interface GitHubToolPullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  url: string;
}

export interface GitHubToolLabelTarget {
  number: number;
  labels: string[];
  url: string;
}

export interface GitHubToolDeps {
  listOpenPullRequests(input: { repo: string; head: string; base: string }): Promise<GitHubToolPullRequest[]>;
  createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<GitHubToolPullRequest>;
  updatePullRequest(input: {
    repo: string;
    number: number;
    title: string;
    body: string;
  }): Promise<GitHubToolPullRequest>;
  getLabels(input: {
    repo: string;
    targetKind: 'pull_request' | 'issue';
    targetNumber: number;
  }): Promise<GitHubToolLabelTarget>;
  addLabel(input: {
    repo: string;
    targetKind: 'pull_request' | 'issue';
    targetNumber: number;
    label: string;
  }): Promise<GitHubToolLabelTarget>;
  sleep(ms: number): Promise<void>;
  maxAttempts: number;
  retryDelayMs: number;
  networkPolicy?: NetworkPolicy;
  repoDir?: string;
  getSecretEnvNames(repoDir?: string): string[];
}

interface ClassifiedError {
  code: 'invalid_input' | 'policy_denied' | 'not_found' | 'external_error' | 'conflict' | 'rate_limited';
  message: string;
  transient: boolean;
}

const defaultGitHubToolDeps: GitHubToolDeps = {
  async listOpenPullRequests({ repo, head, base }) {
    return listPullRequests({ state: 'open', repo })
      .filter((pr) => pr.headRefName === head && pr.baseRefName === base)
      .map(toToolPullRequest);
  },
  async createPullRequest(input) {
    return toToolPullRequest(createPullRequestViaGh(input));
  },
  async updatePullRequest({ repo, number, title, body }) {
    return toToolPullRequest(updatePullRequestViaGh(number, { repo, title, body }));
  },
  async getLabels({ repo, targetKind, targetNumber }) {
    if (targetKind === 'pull_request') {
      return toToolLabelTarget(getPullRequest(targetNumber, { repo }));
    }
    return toIssueLabelTarget(getIssue(targetNumber, { repo }));
  },
  async addLabel({ repo, targetKind, targetNumber, label }) {
    if (targetKind === 'pull_request') {
      return toToolLabelTarget(addLabelsToPullRequest(targetNumber, [label], { repo }));
    }
    return toIssueLabelTarget(addLabelsToIssue(targetNumber, [label], { repo }));
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  getSecretEnvNames(repoDir?: string) {
    return getRedactionConfig(repoDir).secretEnvNames;
  },
};

const githubCreatePrParameters = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    phase: { type: 'string', enum: ['planning', 'coding', 'review', 'ready'] },
    head: { type: 'string' },
    base: { type: 'string' },
    headSha: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    draft: { type: 'boolean' },
  },
  required: ['repo', 'head', 'base', 'headSha', 'title', 'body'],
  additionalProperties: false,
} as const;

const githubAddLabelParameters = {
  type: 'object',
  properties: {
    repo: { type: 'string' },
    phase: { type: 'string', enum: ['planning', 'coding', 'review', 'ready'] },
    targetKind: { type: 'string', enum: ['pull_request', 'issue'] },
    targetNumber: { type: 'integer', minimum: 1 },
    label: { type: 'string' },
  },
  required: ['repo', 'targetKind', 'targetNumber', 'label'],
  additionalProperties: false,
} as const;

export async function githubCreatePr(
  request: GitHubCreatePrRequest,
  deps: Partial<GitHubToolDeps> = {},
): Promise<GitHubCreatePrResult> {
  const input = withGitHubDeps(deps);
  const validation = validateCreatePrRequest(request);
  if (validation) {
    return validation;
  }

  const phase = request.phase ?? DEFAULT_PHASE;
  const createPolicy = isMutationAllowed(phase, 'github_create_pr', 'create_pr');
  const updatePolicy = isMutationAllowed(phase, 'github_create_pr', 'update_pr');
  if (!createPolicy.allowed && !updatePolicy.allowed) {
    return createPrError('policy_denied', createPolicy.reason);
  }

  const network = enforceNetworkPolicy({
    policy: input.networkPolicy,
    phase,
    tool: 'github_create_pr',
    target: 'https://api.github.com',
  });
  if (network.kind === 'deny') {
    return createPrError(network.error, network.message, network.diagnostics);
  }

  // Redact secrets from title and body before any external exposure or comparison.
  const profile = buildProfileFromConfig(() => input.getSecretEnvNames(input.repoDir));
  const safeTitle = redact(request.title, profile);
  const safeBody = redact(request.body, profile);

  const idempotencyKey = githubCreatePrKey({
    repo: request.repo,
    head: request.head,
    base: request.base,
    headSha: request.headSha,
  });

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const existing = await input.listOpenPullRequests({
        repo: request.repo,
        head: request.head,
        base: request.base,
      });

      if (existing.length > 1) {
        return createPrError(
          'conflict',
          `Multiple open pull requests already exist for ${request.repo}:${request.head}->${request.base}`,
        );
      }

      const current = existing[0];
      if (current) {
        const ref = toPullRequestRef(current);
        if (request.ifExists === 'reuse' || (current.title === safeTitle && current.body === safeBody)) {
          return {
            ok: true,
            tool: 'github_create_pr',
            idempotency: {
              key: idempotencyKey,
              outcome: 'reused',
              ref,
            },
          };
        }

        if (!updatePolicy.allowed) {
          return createPrError('policy_denied', updatePolicy.reason);
        }

        const updated = await input.updatePullRequest({
          repo: request.repo,
          number: current.number,
          title: safeTitle,
          body: safeBody,
        });

        return {
          ok: true,
          tool: 'github_create_pr',
          idempotency: {
            key: idempotencyKey,
            outcome: 'updated',
            ref: toPullRequestRef(updated),
          },
        };
      }

      if (!createPolicy.allowed) {
        return createPrError('policy_denied', createPolicy.reason);
      }

      const created = await input.createPullRequest({
        repo: request.repo,
        head: request.head,
        base: request.base,
        title: safeTitle,
        body: safeBody,
        draft: request.draft,
      });

      return {
        ok: true,
        tool: 'github_create_pr',
        idempotency: {
          key: idempotencyKey,
          outcome: 'created',
          ref: toPullRequestRef(created),
        },
      };
    } catch (error: unknown) {
      const classified = classifyGitHubError(error);
      if (classified.transient && attempt < input.maxAttempts) {
        await input.sleep(input.retryDelayMs * attempt);
        continue;
      }
      return createPrError(classified.code, classified.message);
    }
  }

  return createPrError('external_error', 'Pull request operation exhausted retries');
}

export async function githubAddLabel(
  request: GitHubAddLabelRequest,
  deps: Partial<GitHubToolDeps> = {},
): Promise<GitHubAddLabelResult> {
  const input = withGitHubDeps(deps);
  const validation = validateAddLabelRequest(request);
  if (validation) {
    return validation;
  }

  const phase = request.phase ?? DEFAULT_PHASE;
  const policy = isMutationAllowed(phase, 'github_add_label', 'add_label');
  if (!policy.allowed) {
    return addLabelError('policy_denied', policy.reason);
  }

  const network = enforceNetworkPolicy({
    policy: input.networkPolicy,
    phase,
    tool: 'github_add_label',
    target: 'https://api.github.com',
  });
  if (network.kind === 'deny') {
    return addLabelError(network.error, network.message, network.diagnostics);
  }

  const normalizedLabel = request.label.trim();
  const idempotencyKey = githubAddLabelKey({
    repo: request.repo,
    targetKind: request.targetKind,
    targetNumber: request.targetNumber,
    label: normalizedLabel,
  });

  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const current = await input.getLabels({
        repo: request.repo,
        targetKind: request.targetKind,
        targetNumber: request.targetNumber,
      });

      if (hasLabel(current.labels, normalizedLabel)) {
        return {
          ok: true,
          tool: 'github_add_label',
          idempotency: {
            key: idempotencyKey,
            outcome: 'skipped',
            ref: null,
            reason: `Label "${normalizedLabel}" already present on ${request.targetKind} #${request.targetNumber}`,
          },
        };
      }

      const updated = await input.addLabel({
        repo: request.repo,
        targetKind: request.targetKind,
        targetNumber: request.targetNumber,
        label: normalizedLabel,
      });

      return {
        ok: true,
        tool: 'github_add_label',
        idempotency: {
          key: idempotencyKey,
          outcome: 'created',
          ref: toLabelRef(request.repo, normalizedLabel, updated),
        },
      };
    } catch (error: unknown) {
      const classified = classifyGitHubError(error);
      if (classified.transient && attempt < input.maxAttempts) {
        await input.sleep(input.retryDelayMs * attempt);
        continue;
      }
      return addLabelError(classified.code, classified.message);
    }
  }

  return addLabelError('external_error', 'Label operation exhausted retries');
}

export function createGithubCreatePrTool(
  deps: Partial<GitHubToolDeps> = {},
): ToolDescriptor<GitHubCreatePrRequest, GitHubCreatePrResult> {
  return {
    metadata: {
      name: 'github_create_pr',
      description: 'Create or update a GitHub pull request idempotently for the current workflow.',
      class: 'mutation',
      allowedPhases: ['review'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: githubCreatePrParameters,
    async execute(_toolCallId, params) {
      const result = await githubCreatePr(params, deps);
      return toToolResult(result, describeCreatePrResult(result));
    },
  };
}

export function createGithubAddLabelTool(
  deps: Partial<GitHubToolDeps> = {},
): ToolDescriptor<GitHubAddLabelRequest, GitHubAddLabelResult> {
  return {
    metadata: {
      name: 'github_add_label',
      description: 'Add a GitHub label idempotently for the current workflow.',
      class: 'mutation',
      allowedPhases: ['review'],
      executionMode: 'sequential',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: githubAddLabelParameters,
    async execute(_toolCallId, params) {
      const result = await githubAddLabel(params, deps);
      return toToolResult(result, describeAddLabelResult(result));
    },
  };
}

function withGitHubDeps(overrides: Partial<GitHubToolDeps>): GitHubToolDeps {
  return {
    ...defaultGitHubToolDeps,
    ...overrides,
  };
}

function validateCreatePrRequest(request: GitHubCreatePrRequest): GitHubCreatePrResult | null {
  if (!request.repo?.trim()) {
    return createPrError('invalid_input', 'repo must be a non-empty owner/repo string');
  }
  if (!request.head?.trim()) {
    return createPrError('invalid_input', 'head must be a non-empty branch name');
  }
  if (!request.base?.trim()) {
    return createPrError('invalid_input', 'base must be a non-empty branch name');
  }
  if (!request.headSha?.trim()) {
    return createPrError('invalid_input', 'headSha must be a non-empty commit SHA');
  }
  if (!request.title?.trim()) {
    return createPrError('invalid_input', 'title must be a non-empty string');
  }
  if (typeof request.body !== 'string') {
    return createPrError('invalid_input', 'body must be a string');
  }
  return null;
}

function validateAddLabelRequest(request: GitHubAddLabelRequest): GitHubAddLabelResult | null {
  if (!request.repo?.trim()) {
    return addLabelError('invalid_input', 'repo must be a non-empty owner/repo string');
  }
  if (!Number.isInteger(request.targetNumber) || request.targetNumber < 1) {
    return addLabelError('invalid_input', 'targetNumber must be a positive integer');
  }
  if (!request.label?.trim()) {
    return addLabelError('invalid_input', 'label must be a non-empty string');
  }
  return null;
}

function classifyGitHubError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('rate-limited') || lower.includes('http 429')) {
    return { code: 'rate_limited', message, transient: true };
  }

  if (lower.includes('http 502') ||
      lower.includes('http 503') ||
      lower.includes('http 504') ||
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('econnreset') ||
      lower.includes('econnrefused') ||
      lower.includes('socket hang up') ||
      lower.includes('temporary failure') ||
      lower.includes('network error') ||
      lower.includes('network is unreachable') ||
      lower.includes('connection reset')) {
    return { code: 'external_error', message, transient: true };
  }

  if (lower.includes('not found') ||
      lower.includes('could not resolve to a pullrequest') ||
      lower.includes('could not resolve to an issue')) {
    return { code: 'not_found', message, transient: false };
  }

  if (lower.includes('already exists') ||
      lower.includes('multiple open pull requests') ||
      lower.includes('no commits between')) {
    return { code: 'conflict', message, transient: false };
  }

  if (lower.includes('invalid') || lower.includes('required')) {
    return { code: 'invalid_input', message, transient: false };
  }

  return { code: 'external_error', message, transient: false };
}

function hasLabel(labels: string[], requested: string): boolean {
  const normalized = requested.trim().toLowerCase();
  return labels.some((label) => label.trim().toLowerCase() === normalized);
}

function toToolPullRequest(pr: PullRequest): GitHubToolPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    head: pr.headRefName,
    base: pr.baseRefName,
    url: pr.url,
  };
}

function toToolLabelTarget(target: PullRequest): GitHubToolLabelTarget {
  return {
    number: target.number,
    labels: target.labels.map((label) => label.name),
    url: target.url,
  };
}

function toIssueLabelTarget(target: GitHubIssue): GitHubToolLabelTarget {
  return {
    number: target.number,
    labels: target.labels.map((label) => label.name),
    url: target.url,
  };
}

function toPullRequestRef(pr: GitHubToolPullRequest): GitHubPullRequestRef {
  return {
    system: 'github',
    kind: 'pull_request',
    id: String(pr.number),
    number: pr.number,
    url: pr.url,
  };
}

function toLabelRef(repo: string, label: string, target: GitHubToolLabelTarget): GitHubLabelRef {
  return {
    system: 'github',
    kind: 'label',
    id: `${repo}#${target.number}:${label}`,
    url: target.url,
  };
}

function createPrError(
  error: 'invalid_input' | 'policy_denied' | 'not_found' | 'external_error' | 'conflict' | 'rate_limited',
  message: string,
  diagnostics?: NetworkDeniedDiagnostics,
): GitHubCreatePrResult {
  return {
    ok: false,
    tool: 'github_create_pr',
    error,
    message,
    ...(diagnostics ? { diagnostics } : {}),
    metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: message }) },
  };
}

function addLabelError(
  error: 'invalid_input' | 'policy_denied' | 'not_found' | 'external_error' | 'conflict' | 'rate_limited',
  message: string,
  diagnostics?: NetworkDeniedDiagnostics,
): GitHubAddLabelResult {
  return {
    ok: false,
    tool: 'github_add_label',
    error,
    message,
    ...(diagnostics ? { diagnostics } : {}),
    metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details: message }) },
  };
}

function toToolResult<TDetails>(details: TDetails, text: string): WavemillToolResult<TDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
    metadata: { trust: buildTrustMetadata({ sourceKind: 'wavemill_artifact', details }) },
  };
}

function describeCreatePrResult(result: GitHubCreatePrResult): string {
  if (!result.ok) {
    return `github_create_pr failed: ${result.error}`;
  }
  const ref = result.idempotency.ref;
  return `github_create_pr ${result.idempotency.outcome}${ref ? ` #${ref.number}` : ''}`;
}

function describeAddLabelResult(result: GitHubAddLabelResult): string {
  if (!result.ok) {
    return `github_add_label failed: ${result.error}`;
  }
  return `github_add_label ${result.idempotency.outcome}`;
}
