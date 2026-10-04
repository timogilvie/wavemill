#!/usr/bin/env -S npx tsx

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReviewFlow } from '../shared/lib/native-agent/workflow-tools/review-flow.ts';
import type {
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
  LinearClient,
} from '../shared/lib/native-agent/workflow-tools/linear-tools.ts';
import { DEFAULT_NETWORK_POLICY, type NetworkPolicy } from '../shared/lib/native-agent/network-policy.ts';
import { resolveOwnerRepo } from '../shared/lib/github.ts';
import { getMillConfig } from '../shared/lib/config.ts';
import { createComment, getIssue, updateComment } from '../shared/lib/linear.ts';
import { renderPrMetadata } from '../shared/lib/pr-metadata.ts';
import { resolveLinearIssueId } from '../shared/lib/task-identity.ts';
import { readTaskIdentityMeta } from '../shared/lib/linear-write-gate.ts';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return firstNonEmpty(process.argv[index + 1]);
}

/** Treat empty launcher exports as omitted values so they cannot suppress defaults. */
export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function appendJsonLine(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(payload)}\n`, 'utf-8');
}

/**
 * Resolve the Linear issue a review task reads from, through the task
 * identity contract (HOK-3115). Replaces the old `_c` suffix stripping and
 * issue-JSON fallback so a challenger cannot alias its primary for mutation:
 * writes are gated separately by linear_comment's identity check.
 *
 * @throws Error for an invalid task ID or a conflicting recorded linearIssueId.
 */
function readLinearIdentifier(issue: string): string {
  const resolved = resolveLinearIssueId(issue, readTaskIdentityMeta(issue));
  if (!resolved.ok) {
    throw new Error(`Cannot resolve Linear issue for ${issue}: ${resolved.message}`);
  }
  return resolved.linearId;
}

function readOptional(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    return null;
  }
}

function truncateText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= maxBytes) {
    return text;
  }
  return `${Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8')}\n[truncated ${bytes - maxBytes} bytes]`;
}

export function buildNativeCodingHandoff(featureDir: string): string {
  const sections: string[] = [];
  const codingResult = readOptional(join(featureDir, '.coding-result.json'));
  const codingComplete = readOptional(join(featureDir, '.coding-complete'));
  const blockedCompletion = readOptional(join(featureDir, '.coding-blocked-completion.json'));

  if (codingResult?.trim()) {
    sections.push([
      '### Coding Stage Result',
      '```json',
      truncateText(codingResult.trim(), 8_000),
      '```',
    ].join('\n'));
  }

  if (codingComplete?.trim()) {
    let confidenceLine: string | null = null;
    try {
      const parsed = JSON.parse(codingComplete) as { confidence?: unknown };
      if (typeof parsed.confidence === 'string') {
        confidenceLine = `Confidence: ${parsed.confidence}`;
      }
    } catch {
      confidenceLine = null;
    }
    sections.push([
      '### Coding Completion Marker',
      ...(confidenceLine ? [confidenceLine] : []),
      '```json',
      truncateText(codingComplete.trim(), 2_000),
      '```',
    ].join('\n'));
  }

  if (blockedCompletion?.trim()) {
    sections.push([
      '### Blocked Completion Handoff',
      '```json',
      truncateText(blockedCompletion.trim(), 8_000),
      '```',
    ].join('\n'));
  }

  return sections.join('\n\n');
}

export function buildPrBody(input: {
  issue: string;
  title: string;
  reviewerModel: string;
  baseBranch: string;
  headBranch: string;
  codingHandoff?: string;
}): string {
  return [
    '## Summary',
    '',
    `- ${input.title}`,
    `- Native review flow executed for ${input.issue} using ${input.reviewerModel || 'the configured native reviewer'}.`,
    '',
    '## Changes',
    '',
    `- Branch: \`${input.headBranch}\``,
    `- Base: \`${input.baseBranch}\``,
    '',
    input.codingHandoff?.trim()
      ? [
        '## Native Coding Handoff',
        '',
        input.codingHandoff.trim(),
        '',
      ].join('\n')
      : '',
    '## Test plan',
    '',
    '- Native review flow ran `review_changes` and attached the structured findings below.',
    '',
    renderPrMetadata({ task: input.issue }),
  ].join('\n');
}

/**
 * Resolve the base branch a native review PR should target.
 *
 * Precedence: explicit --base-branch, then WAVEMILL_BASE_BRANCH, then the
 * repository's configured mill baseBranch. Only when none of those yield a
 * value do we fall back to 'main'. Reading mill config matters because mill
 * repos commonly target an integration branch; defaulting straight to 'main'
 * opened PRs against the wrong base (hundreds of unrelated commits) whenever
 * the launcher env was not populated.
 */
export function resolveBaseBranch(
  optionValue: string | undefined,
  envValue: string | undefined,
  repoDir: string,
): string {
  const configured = (() => {
    try {
      return getMillConfig(repoDir).baseBranch;
    } catch {
      return undefined;
    }
  })();
  return firstNonEmpty(optionValue, envValue, configured) ?? 'main';
}

async function main(): Promise<void> {
  const session = firstNonEmpty(readOption('session'), process.env.WAVEMILL_SESSION) ?? '';
  const issue = firstNonEmpty(readOption('issue'), process.env.WAVEMILL_ISSUE) ?? '';
  const slug = firstNonEmpty(readOption('slug'), process.env.WAVEMILL_FEATURE_SLUG, process.env.WAVEMILL_SLUG) ?? '';
  const wtDir = resolve(firstNonEmpty(readOption('wt-dir'), process.env.WAVEMILL_WT_DIR) ?? process.cwd());
  const repoDir = resolve(firstNonEmpty(readOption('repo-dir'), process.env.WAVEMILL_MILLED_REPO_DIR) ?? process.cwd());
  const featureDir = resolve(firstNonEmpty(readOption('feature-dir')) ?? join(wtDir, 'features', slug));
  const title = firstNonEmpty(readOption('title'), process.env.WAVEMILL_TITLE) ?? issue;
  const baseBranch = resolveBaseBranch(readOption('base-branch'), process.env.WAVEMILL_BASE_BRANCH, repoDir);
  const reviewerModel = firstNonEmpty(process.env.WAVEMILL_RESOLVED_MODEL) ?? '';

  if (!session || !issue || !slug) {
    throw new Error('session, issue, and slug are required');
  }

  const repo = resolveOwnerRepo(wtDir);
  if (!repo) {
    throw new Error(`could not resolve GitHub owner/repo from ${wtDir}`);
  }

  const headBranch = firstNonEmpty(readOption('branch'), process.env.WAVEMILL_BRANCH) ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], wtDir);
  const headSha = git(['rev-parse', 'HEAD'], wtDir);
  const prTitle = title.includes(issue) ? title : `${issue}: ${title}`;
  const linearIssue = readLinearIdentifier(issue);
  const workflowLogPath = join(featureDir, '.native-review-workflow.jsonl');
  const codingHandoff = buildNativeCodingHandoff(featureDir);

  const transcript = {
    append(event: WorkflowToolTranscriptEvent) {
      appendJsonLine(workflowLogPath, { kind: 'transcript', ...event });
    },
  };
  const stageArtifact = {
    append(entry: WorkflowToolStageArtifactEntry) {
      appendJsonLine(workflowLogPath, { kind: 'stage-artifact', ...entry });
    },
  };
  const linearClient: LinearClient = {
    async getIssue(identifier) {
      return await getIssue(identifier === issue ? linearIssue : identifier);
    },
    async createComment(issueId, body) {
      return await createComment(issueId, body);
    },
    async updateComment(commentId, body) {
      return await updateComment(commentId, body);
    },
  };
  const networkPolicy: NetworkPolicy = {
    ...DEFAULT_NETWORK_POLICY,
    review: {
      ...DEFAULT_NETWORK_POLICY.review,
      review_changes: { kind: 'allow' },
    },
  };

  const result = await runReviewFlow({
    issueId: issue,
    featureDir,
    repo,
    base: baseBranch,
    head: headBranch,
    headSha,
    title: prTitle,
    body: buildPrBody({
      issue,
      title,
      reviewerModel,
      baseBranch,
      headBranch,
      codingHandoff,
    }),
    worktreeDir: wtDir,
    reviewContextAppendix: codingHandoff
      ? [
        'Native coding handoff artifacts from the completed coding phase:',
        codingHandoff,
      ].join('\n\n')
      : undefined,
    labels: ['wavemill'],
    sessionId: session,
    phase: 'review',
    transcript,
    stageArtifact,
    linearClient,
    networkPolicy,
  });

  if (!result.ok) {
    throw new Error(result.warnings.join('; ') || 'native review flow failed');
  }

  appendJsonLine(workflowLogPath, {
    kind: 'summary',
    haltedBeforeMerge: result.haltedBeforeMerge,
    merged: result.merged,
    warningCount: result.warnings.length,
  });

  if (linearIssue !== issue) {
    appendJsonLine(workflowLogPath, {
      kind: 'linear-issue-alias',
      issue,
      linearIssue,
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
