#!/usr/bin/env -S npx tsx

import { getIntegrationReadyPolicy } from '../shared/lib/config.ts';
import { getPullRequest } from '../shared/lib/github.ts';
import { getIssueCompletionState } from '../shared/lib/linear.ts';
import { evaluateReady, type CheckReadResult, type ReadyVerdict } from '../shared/lib/ready-engine.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { checkMergeConflicts, ciStatusToReadyCheck, runReadyStage, type ReadyCheck, type ReadyResult } from '../shared/lib/ready-stage.ts';
import { readChallengeComparisons } from '../shared/lib/challenge-comparison.ts';
import {
  evaluateChallengeReadyEvidence,
  resolveChallengePairFromState,
  type ChallengeReadyEvidence,
} from '../shared/lib/challenge-ready-evidence.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { resolvePrIdentityMetadata } from '../shared/lib/pr-comparison.ts';
import { writePreflightDiagnostic } from '../shared/lib/ready-diagnostics.ts';
import { fetchPrCiStatus, type PrCiStatus } from '../shared/lib/pr-ci-status.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Build the lazy current-head challenge evidence resolver (HOK-2963). It is
 * invoked by the ready engine only for challenge PRs. Every failure mode
 * returns null so the engine falls back to the legacy fail-closed gate.
 */
function buildChallengeEvidenceResolver(input: {
  prNumber: number;
  prUrl: string;
  headSha?: string;
  repoDir: string;
  stateFile?: string;
}): () => Promise<ChallengeReadyEvidence | null> {
  return async () => {
    try {
      const headSha = input.headSha?.trim();
      if (!headSha || !input.stateFile) return null;
      const state = JSON.parse(readFileSync(input.stateFile, 'utf8')) as unknown;
      const pairing = resolveChallengePairFromState(state, input.prNumber);
      if (!pairing) return null;
      const sibling = resolvePrIdentityMetadata(String(pairing.siblingPr), input.repoDir);
      const self = { prUrl: input.prUrl, prNumber: String(input.prNumber), headSha };
      const siblingArm = {
        prUrl: sibling.url,
        prNumber: String(pairing.siblingPr),
        headSha: sibling.head_sha,
      };
      return evaluateChallengeReadyEvidence({
        pairId: pairing.pairId,
        side: pairing.side,
        primary: pairing.side === 'primary' ? self : siblingArm,
        challenger: pairing.side === 'primary' ? siblingArm : self,
        evalRecords: readEvalRecords({ dir: resolveEvalsDir(undefined, input.repoDir).dir }),
        comparisons: readChallengeComparisons(),
      });
    } catch {
      return null;
    }
  };
}

async function maybeWriteReadyDiagnostic(repoDir: string, diagnostic: {
  stateDir?: string;
  stage: string;
  tool: string;
  classification: 'preflight-failure' | 'ref-missing' | 'tool-error' | 'config-missing';
  reason: string;
  rawError?: string;
}): Promise<void> {
  const stateDir = diagnostic.stateDir ?? path.join(repoDir, 'features');
  try {
    await writePreflightDiagnostic(stateDir, {
      stage: diagnostic.stage,
      tool: diagnostic.tool,
      classification: diagnostic.classification,
      reason: diagnostic.reason,
      rawError: diagnostic.rawError,
    });
  } catch {
    // Diagnostics must never mask the original ready failure.
  }
}

runTool({
  name: 'ready',
  description: 'Check PR merge-readiness (CI, approvals, conflicts)',
  positional: {
    name: 'pr',
    description: 'PR number or URL',
  },
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    'state-dir': {
      type: 'string',
      description: 'Ready state directory for structured diagnostics',
    },
    'state-file': {
      type: 'string',
      description: 'Monitor workflow-state.json for challenge pair identity (HOK-2963)',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON output',
    },
  },
  examples: [
    '# Check PR 42 in current repo',
    'npx tsx tools/ready.ts 42',
    '',
    '# Check PR from URL',
    'npx tsx tools/ready.ts https://github.com/org/repo/pull/42',
  ],
  async run({ positional, args }) {
    if (positional.length === 0) {
      throw new Error('PR number or URL required');
    }

    // Parse PR number from URL or direct number
    const prInput = positional[0];
    const prNumber = extractPrNumber(prInput);

    const repoDir = args['repo-dir'] || process.cwd();
    const stateDir = args['state-dir'] ? String(args['state-dir']) : undefined;
    const stateFile = args['state-file'] ? String(args['state-file']) : undefined;
    const readyPolicy = getIntegrationReadyPolicy(repoDir);
    let verdict: ReadyVerdict;
    let output: ReadyResult;
    let ciStatus: PrCiStatus | undefined;

    if (readyPolicy.enabled) {
      const pr = getPullRequest(prNumber);
      ciStatus = await fetchPrCiStatus(prNumber, repoDir, {}, {
        baseBranch: pr.baseRefName,
      });
      const requiredCheckRead: CheckReadResult = ciStatus.conclusion === 'unknown'
        ? {
            ok: false,
            reason: ciStatus.readError?.reason ?? 'GitHub check status unavailable',
            errorType: ciStatus.readError?.errorType ?? 'unknown',
          }
        : {
            ok: true,
            checks: ciStatus.checks,
            requiredContexts: ciStatus.requiredContexts,
            requiredSource: ciStatus.requiredSource,
          };
      try {
        verdict = await evaluateReady({
          pr: {
            number: pr.number,
            url: pr.url,
            baseBranch: pr.baseRefName,
            body: pr.body || '',
            labels: pr.labels.map((label) => label.name),
            mergedAt: pr.mergedAt,
          },
          config: {
            ...readyPolicy,
            integrationBranch: readyPolicy.integrationBranch || 'auto/integration',
          },
          async fetchPrState(dependencyPrNumber) {
            try {
              const dependencyPr = getPullRequest(dependencyPrNumber);
              const state = dependencyPr.mergedAt ? 'MERGED' : dependencyPr.state === 'OPEN' ? 'OPEN' : 'CLOSED';
              return { state, mergedAt: dependencyPr.mergedAt };
            } catch (error) {
              if ((error as Error).message.includes('not found')) {
                return null;
              }
              throw error;
            }
          },
          async fetchLinearIssueState(identifier) {
            try {
              const issue = await getIssueCompletionState(identifier);
              return { completedAt: issue.completedAt ?? null, canceledAt: issue.canceledAt ?? null };
            } catch (error) {
              if ((error as Error).message.includes('Issue not found')) {
                return null;
              }
              throw error;
            }
          },
          readChallengeComparisons,
          requiredCheckRead,
          resolveChallengeEvidence: buildChallengeEvidenceResolver({
            prNumber: pr.number,
            prUrl: pr.url,
            headSha: ciStatus.headSha,
            repoDir,
            stateFile,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await maybeWriteReadyDiagnostic(repoDir, {
          stateDir,
          stage: 'ready',
          tool: 'evaluateReady',
          classification: 'tool-error',
          reason: 'Ready policy evaluation failed',
          rawError: message,
        });
        throw error;
      }

      output = {
        prNumber,
        verdict: verdict.status,
        checks: [ciStatusToReadyCheck(ciStatus), ...buildPolicyChecks(verdict)],
        summary: verdict.reasons[0] ?? summarizeVerdict(verdict.status),
        timestamp: new Date().toISOString(),
        mergeConflict: await checkMergeConflicts(prNumber, repoDir),
        headSha: ciStatus.headSha,
        ciConclusion: ciStatus.conclusion,
        mergeStateStatus: ciStatus.mergeStateStatus,
        // Additive typed challenge-wait fields (HOK-2963).
        ...(verdict.implementationReady !== undefined
          ? { implementationReady: verdict.implementationReady }
          : {}),
        ...(verdict.pendingReason ? { pendingReason: verdict.pendingReason } : {}),
        ...(verdict.pendingReasons && verdict.pendingReasons.length > 0
          ? { pendingReasons: verdict.pendingReasons }
          : {}),
        ...(verdict.challenge
          ? { challenge: verdict.challenge as unknown as Record<string, unknown> }
          : {}),
      };
    } else {
      try {
        output = await runReadyStage({ prNumber, repoDir });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await maybeWriteReadyDiagnostic(repoDir, {
          stateDir,
          stage: 'ready',
          tool: 'runReadyStage',
          classification: 'tool-error',
          reason: 'Ready stage execution failed',
          rawError: message,
        });
        throw error;
      }
      verdict = {
        status: output.verdict,
        reasons: output.summary ? [output.summary] : [],
        output: { labels: [], comment: '' },
      };
    }

    console.log(JSON.stringify(output));

    if (verdict.status === 'fail') {
      process.exit(1);
    } else if (verdict.status === 'pending') {
      process.exit(2);
    }
  },
});

function extractPrNumber(input: string): number {
  // Try direct number first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  // Try GitHub PR URL pattern
  const match = input.match(/\/pull\/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  throw new Error(`Invalid PR number or URL: ${input}`);
}

function buildPolicyChecks(verdict: ReadyVerdict): ReadyCheck[] {
  // Structured typed-wait details keep shell parsing and tests stable
  // without depending on human-readable reason text (HOK-2963).
  const details: Record<string, unknown> = {
    ...(verdict.pendingReason ? { pendingReason: verdict.pendingReason } : {}),
    ...(verdict.pendingReasons && verdict.pendingReasons.length > 0
      ? { pendingReasons: verdict.pendingReasons }
      : {}),
    ...(verdict.implementationReady !== undefined
      ? { implementationReady: verdict.implementationReady }
      : {}),
    ...(verdict.challenge ? { challenge: verdict.challenge } : {}),
  };

  if (verdict.reasons.length === 0) {
    return [{
      name: 'ready-policy',
      status: verdict.status,
      message: summarizeVerdict(verdict.status),
      details,
    }];
  }

  return verdict.reasons.map((reason) => ({
    name: 'ready-policy',
    status: verdict.status,
    message: reason,
    details,
  }));
}

function summarizeVerdict(status: ReadyVerdict['status']): string {
  if (status === 'pass') {
    return 'All ready policy checks passed';
  }
  if (status === 'pending') {
    return 'Ready policy checks are still pending';
  }
  if (status === 'warn') {
    return 'Ready policy checks passed with warnings';
  }
  return 'Ready policy checks failed';
}
