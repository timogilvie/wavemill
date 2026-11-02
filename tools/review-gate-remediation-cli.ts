/**
 * CLI wrapper for review-gate remediation disposition (HOK-2890).
 * Called from shell monitor paths to decide how to handle review refusals.
 *
 * Usage: npx tsx tools/review-gate-remediation-cli.ts decide --state-dir /path/to/state [--review-model MODEL]
 *
 * Prints the disposition class on stdout: `terminal`, `code-failure`, or `retryable`.
 *
 * When `.review-result.json` carries typed `findings[]` (the post-D7a shape),
 * disposition is the categorical switch in decideReviewGateRemediation.
 *
 * Otherwise (today's production shape), disposition preserves the
 * pre-HOK-2890 pre-Ready branch: a review artifact whose `failureCategory`
 * is in the shared infra-failure taxonomy maps to `retryable`; any other
 * refusing verdict maps to `terminal` (operator attention / park). This is
 * the same split `review_result_infra_failure` + `review_gate_refusal_is_terminal`
 * used before this change — kept here so the CLI never collapses an
 * un-typed failing verdict to `retryable`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  decideReviewGateRemediation,
  dispositionFromReviewArtifactSignals,
  type ReviewArtifactSignals,
  type ReviewGateEvidence,
  type ReviewGateFinding,
} from '../shared/lib/review-gate-remediation.ts';

interface CliOptions {
  stateDir?: string;
  reviewModel?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {};

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case '--state-dir':
        options.stateDir = args[++i];
        break;
      case '--review-model':
        options.reviewModel = args[++i];
        break;
      default:
        break;
    }
    i++;
  }

  return options;
}

interface ReviewResult extends ReviewArtifactSignals {
  reviewerModel?: string;
  exitCode?: number;
  findings?: Array<{
    category: string;
    offendingPath?: string;
    message: string;
  }>;
  artifact?: { kind?: string; identity?: string };
}

function readUnwrapped(review: ReviewResult, key: 'failureCategory' | 'verdict'): string {
  const artifacts = review.artifacts ?? {};
  if (artifacts.type === 'review') {
    return (artifacts[key] ?? review[key] ?? '') as string;
  }
  return (
    (artifacts.review?.[key] ?? artifacts[key] ?? review[key] ?? '') as string
  );
}

async function main() {
  const command = process.argv[2];

  if (command !== 'decide') {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  const options = parseArgs();

  if (!options.stateDir) {
    console.error('--state-dir is required');
    process.exit(1);
  }

  try {
    const reviewResultPath = join(options.stateDir, '.review-result.json');
    let reviewResult: ReviewResult = {};
    let haveReviewResult = false;
    try {
      const content = readFileSync(reviewResultPath, 'utf-8');
      reviewResult = JSON.parse(content);
      haveReviewResult = true;
    } catch {
      // Review result may not exist yet.
    }

    const scopeStopPath = join(options.stateDir, '.review-scope-stop.json');
    let scopeStop: { findings?: ReviewGateFinding[] } = {};
    let haveScopeStop = false;
    try {
      const content = readFileSync(scopeStopPath, 'utf-8');
      scopeStop = JSON.parse(content);
      haveScopeStop = true;
    } catch {
      // Scope stop may not exist (D7a producer not yet landed).
    }

    const typedFindings: ReviewGateFinding[] = [
      ...((reviewResult.findings as ReviewGateFinding[] | undefined) || []),
      ...(scopeStop.findings || []),
    ].filter((f) => f && f.category && f.message);

    if (typedFindings.length > 0) {
      const verdict = readUnwrapped(reviewResult, 'verdict');
      const failureCategory = readUnwrapped(reviewResult, 'failureCategory');
      const evidence: ReviewGateEvidence = {
        stage: 'review',
        stateDir: options.stateDir,
        headSha: process.env.HEAD_SHA || 'unknown',
        reviewerModel: options.reviewModel || reviewResult.reviewerModel,
        verdict,
        findings: typedFindings,
        artifact: {
          kind: 'review-result',
          identity:
            reviewResult.artifact?.identity ||
            `${failureCategory || verdict || 'review'}-${process.env.HEAD_SHA || 'unknown'}`,
        },
      };

      const decision = decideReviewGateRemediation(evidence);
      console.log(decision.disposition);
      process.exit(0);
    }

    // No typed findings: fall back to the pre-HOK-2890 artifact-signal split.
    // Only possible when at least the review artifact exists; without any
    // artifact we have no evidence to classify from, which is the "no
    // refusal" case the caller should not have invoked us for.
    if (!haveReviewResult && !haveScopeStop) {
      console.error('No review-result.json or review-scope-stop.json to classify');
      process.exit(1);
    }

    console.log(dispositionFromReviewArtifactSignals(reviewResult));
    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
