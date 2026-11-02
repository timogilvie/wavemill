/**
 * CLI wrapper for review-gate remediation disposition (HOK-2890).
 * Called from shell monitor paths to decide how to handle review refusals.
 *
 * Usage: npx tsx tools/review-gate-remediation-cli.ts decide --state-dir /path/to/state [--review-model MODEL] [--plan-scope-path PLAN]
 *
 * Outputs JSON on stdout with the disposition decision.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  decideReviewGateRemediation,
  type ReviewGateEvidence,
} from '../shared/lib/review-gate-remediation.ts';

interface CliOptions {
  stateDir?: string;
  reviewModel?: string;
  planScopePath?: string;
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
      case '--plan-scope-path':
        options.planScopePath = args[++i];
        break;
      default:
        break;
    }
    i++;
  }

  return options;
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
    // Read the review result artifact
    const reviewResultPath = join(
      options.stateDir,
      '.review-result.json',
    );
    let reviewResult: {
      verdict?: string;
      exitCode?: number;
      findings?: Array<{
        category: string;
        offendingPath?: string;
        message: string;
      }>;
      reviewerModel?: string;
    } = {
      findings: [],
    };

    try {
      const content = readFileSync(reviewResultPath, 'utf-8');
      reviewResult = JSON.parse(content);
    } catch {
      // Review result may not exist yet; continue with empty findings
    }

    // Read the scope stop artifact if it exists
    const scopeStopPath = join(options.stateDir, '.review-scope-stop.json');
    let scopeStop: { findings?: Array<{ category: string; offendingPath?: string; message: string }> } = {
      findings: [],
    };

    try {
      const content = readFileSync(scopeStopPath, 'utf-8');
      scopeStop = JSON.parse(content);
    } catch {
      // Scope stop may not exist
    }

    // Read plan scope allowlist if provided
    let planScopeAllowlist: Array<{
      path: string;
      reason: string;
      source: string;
    }> = [];
    if (options.planScopePath) {
      try {
        const content = readFileSync(options.planScopePath, 'utf-8');
        const planData = JSON.parse(content);
        if (planData.scopeAllowlist) {
          planScopeAllowlist = planData.scopeAllowlist;
        }
      } catch {
        // Plan scope may not be available
      }
    }

    // Combine findings from both sources (prefer review-result if both exist)
    const allFindings = [
      ...(reviewResult.findings || []),
      ...(scopeStop.findings || []),
    ].filter((f) => f && f.category && f.message);

    if (allFindings.length === 0) {
      console.error('No findings in review result or scope stop');
      process.exit(1);
    }

    const evidence: ReviewGateEvidence = {
      stage: reviewResult.findings && reviewResult.findings.length > 0 ? 'review' : 'pre-pr-verification',
      stateDir: options.stateDir,
      headSha: process.env.HEAD_SHA || 'unknown',
      reviewerModel: options.reviewModel || reviewResult.reviewerModel,
      verdict: reviewResult.verdict,
      findings: allFindings,
      artifact: {
        kind: reviewResult.findings ? 'review-result' : 'pre-pr-gate',
        identity: `review-${Date.now()}`,
      },
      planScopeAllowlist,
    };

    const decision = decideReviewGateRemediation(evidence);

    // Output the disposition as plain text for shell consumption (class:disposition)
    console.log(decision.disposition);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
