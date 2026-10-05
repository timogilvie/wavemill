#!/usr/bin/env node
/**
 * Run verification checks when a weaker model is used for coding.
 *
 * This script is called as a pre-commit hook by the agent adapter.
 * It determines what verification checks are needed based on the coder model's quality,
 * then executes those checks and reports any failures.
 *
 * Environment variables:
 * - WAVEMILL_CODER_MODEL: Model ID used for coding (required)
 * - WAVEMILL_AVAILABLE_REVIEWERS: Comma-separated list of reviewer model IDs
 * - WAVEMILL_MILLED_REPO_DIR: Milled repository directory (default: cwd)
 * - SKIP_VERIFICATION: Set to "true" to skip all verification (emergency escape hatch)
 *
 * Exit codes:
 * - 0: All checks passed (or no verification needed)
 * - 1: One or more checks failed
 */

import { determineVerificationRequirements } from './verification-engine.ts';
import { getBaseBranch, validatePatchSize } from './patch-size-validator.ts';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from './error-utils.ts';
import { resolveWavemillInstallDir } from './native-agent/install-paths.ts';

interface CheckCommands {
  typecheck?: string;
  lint?: string;
  test?: string;
  build?: string;
}

interface VerificationResult {
  passed: boolean;
  checkResults: Array<{
    check: string;
    passed: boolean;
    output?: string;
    error?: string;
  }>;
  patchSizeResult?: {
    totalLines: number;
    cap: number;
    exceedsCap: boolean;
    reason: string;
  };
}

interface RoutingMetadata {
  planner?: string;
  coder?: string;
  reviewer?: string;
  planDepth?: string;
  codeDepth?: string;
  reviewRecommended?: string;
}

/**
 * Load routing metadata from the routing JSON file.
 * Falls back to environment variables if file not found.
 */
function loadRoutingMetadata(): { coderModel: string; availableReviewers: string[] } {
  // Try environment variables first (most explicit)
  if (process.env.WAVEMILL_CODER_MODEL) {
    return {
      coderModel: process.env.WAVEMILL_CODER_MODEL,
      availableReviewers: process.env.WAVEMILL_AVAILABLE_REVIEWERS?.split(',').filter(Boolean) || [],
    };
  }

  // Try loading from routing JSON file (mill mode)
  const session = process.env.WAVEMILL_SESSION;
  const issue = process.env.WAVEMILL_ISSUE;

  if (session && issue) {
    const routingFile = `/tmp/${session}-${issue}-route.json`;
    try {
      const content = readFileSync(routingFile, 'utf-8');
      const routing: RoutingMetadata = JSON.parse(content);

      if (routing.coder) {
        // Available reviewers: any model that could be used for review
        // In practice, this includes the recommended reviewer plus other strong models
        const availableReviewers = [routing.reviewer, routing.planner].filter(Boolean) as string[];

        return {
          coderModel: routing.coder,
          availableReviewers,
        };
      }
    } catch (err) {
      // File not found or invalid - continue to error below
    }
  }

  // No routing metadata available
  throw new Error(
    'Could not determine coder model. Set WAVEMILL_CODER_MODEL environment variable or ensure routing metadata exists.',
  );
}

/**
 * Main entry point for verification.
 */
async function main(): Promise<void> {
  // Check for emergency escape hatch
  if (process.env.SKIP_VERIFICATION === 'true') {
    console.log('⚠️  SKIP_VERIFICATION=true - bypassing all verification checks');
    process.exit(0);
  }

  // Load routing metadata
  let coderModel: string;
  let availableReviewers: string[];

  try {
    ({ coderModel, availableReviewers } = loadRoutingMetadata());
  } catch (err) {
    console.error(`ERROR: ${errorMessage(err)}`);
    process.exit(1);
  }

  const repoDir = process.env.WAVEMILL_MILLED_REPO_DIR || process.cwd();

  // Determine verification requirements
  const requirements = determineVerificationRequirements(
    coderModel,
    'coding',
    availableReviewers,
    repoDir,
  );

  // If no verification needed, exit early
  if (!requirements.verificationNeeded) {
    console.log(`✓ Strong model (${coderModel}) - no extra verification needed`);
    process.exit(0);
  }

  // Log verification requirements
  console.log(`\n⚠️  Weak model detected: ${coderModel} (score: ${requirements.metadata.coderScore}, threshold: ${requirements.metadata.threshold})`);
  console.log(`Quality gap: ${requirements.metadata.qualityGap} points below threshold\n`);

  // Load check commands from claude/config.json
  const checkCommands = loadCheckCommands(repoDir);

  // Run verification
  const result = await runVerification(requirements, checkCommands, repoDir);

  // Report results
  reportResults(result, requirements);

  // Exit with appropriate code
  process.exit(result.passed ? 0 : 1);
}

/**
 * Load check commands from claude/config.json
 */
function loadCheckCommands(_repoDir: string): CheckCommands {
  const configPath = join(resolveWavemillInstallDir(), 'claude', 'config.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config.checks || {};
  } catch (err) {
    console.warn(`Warning: Could not load check commands from ${configPath}: ${errorMessage(err)}`);
    return {};
  }
}

/**
 * Run all required verification checks.
 */
async function runVerification(
  requirements: ReturnType<typeof determineVerificationRequirements>,
  checkCommands: CheckCommands,
  repoDir: string,
): Promise<VerificationResult> {
  const checkResults: VerificationResult['checkResults'] = [];

  // Run typecheck
  if (requirements.mandatory.typecheck) {
    const result = runCheck('typecheck', checkCommands.typecheck, repoDir);
    checkResults.push(result);
  }

  // Run lint
  if (requirements.mandatory.lint) {
    const result = runCheck('lint', checkCommands.lint, repoDir);
    checkResults.push(result);
  }

  // Run tests
  if (requirements.mandatory.test) {
    const result = runCheck('test', checkCommands.test, repoDir);
    checkResults.push(result);
  }

  // Check patch size if cap enforced
  let patchSizeResult;
  if (requirements.patchSizeCap) {
    patchSizeResult = checkPatchSize(requirements.patchSizeCap.maxLines, requirements.patchSizeCap.reason, repoDir);
    if (patchSizeResult.exceedsCap) {
      checkResults.push({
        check: 'patch-size',
        passed: false,
        error: `Patch size ${patchSizeResult.totalLines} exceeds cap ${patchSizeResult.cap}`,
      });
    }
  }

  // Check self-explanation (commit message format)
  if (requirements.mandatory.selfExplanation) {
    const result = checkSelfExplanation(repoDir);
    checkResults.push(result);
  }

  const passed = checkResults.every((r) => r.passed);

  return {
    passed,
    checkResults,
    patchSizeResult,
  };
}

/**
 * Run a single check command.
 */
function runCheck(
  checkName: string,
  command: string | undefined,
  repoDir: string,
): VerificationResult['checkResults'][0] {
  if (!command) {
    return {
      check: checkName,
      passed: true,
      output: `No ${checkName} command configured - skipping`,
    };
  }

  console.log(`Running ${checkName}: ${command}`);

  try {
    const output = execSync(command, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    console.log(`✓ ${checkName} passed\n`);

    return {
      check: checkName,
      passed: true,
      output,
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';

    console.error(`✗ ${checkName} failed:`);
    console.error(errorOutput);
    console.error('');

    return {
      check: checkName,
      passed: false,
      error: errorOutput,
    };
  }
}

/**
 * Check patch size against cap.
 */
function checkPatchSize(
  cap: number,
  reason: string,
  repoDir: string,
): NonNullable<VerificationResult['patchSizeResult']> {
  try {
    // Use shared validation logic from patch-size-validator.ts
    const baseBranch = getBaseBranch(repoDir);
    const branch = 'HEAD';
    const result = validatePatchSize(branch, baseBranch, cap, repoDir);

    if (result.exceedsCap) {
      console.error(`\n✗ Patch size cap exceeded:`);
      console.error(`  Total lines changed: ${result.totalLines}`);
      console.error(`  Cap: ${cap} lines`);
      console.error(`  Reason: ${reason}`);
      console.error(`\n  Suggestion: Split this work into smaller PRs\n`);
    } else {
      console.log(`✓ Patch size ${result.totalLines} lines (under cap of ${cap})\n`);
    }

    return {
      totalLines: result.totalLines,
      cap,
      exceedsCap: result.exceedsCap,
      reason,
    };
  } catch (err) {
    console.warn(`Warning: Could not check patch size: ${errorMessage(err)}`);
    return {
      totalLines: 0,
      cap,
      exceedsCap: false,
      reason,
    };
  }
}

/**
 * Check that commit message includes self-explanation.
 *
 * For now, this is a stub that always passes.
 * In the future, we could verify the commit message format:
 * - CHANGED: <list of files>
 * - WHY: <rationale>
 * - RISK: <potential issues>
 */
function checkSelfExplanation(repoDir: string): VerificationResult['checkResults'][0] {
  // Note: This check is enforced via agent prompt rather than pre-commit hook
  // The agent is instructed to include CHANGED/WHY/RISK sections in commit messages
  // We don't validate format here to avoid blocking valid commits
  console.log('✓ Self-explanation required (enforced via agent prompt)\n');

  return {
    check: 'self-explanation',
    passed: true,
    output: 'Self-explanation requirement communicated to agent',
  };
}

/**
 * Report verification results.
 */
function reportResults(
  result: VerificationResult,
  requirements: ReturnType<typeof determineVerificationRequirements>,
): void {
  console.log('\n' + '='.repeat(60));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nCoder Model: ${requirements.metadata.coderModel}`);
  console.log(`Quality Score: ${requirements.metadata.coderScore}/${requirements.metadata.threshold} (threshold)`);
  console.log(`Quality Gap: ${requirements.metadata.qualityGap} points\n`);

  console.log('Checks run:');
  for (const check of result.checkResults) {
    const status = check.passed ? '✓' : '✗';
    console.log(`  ${status} ${check.check}`);
  }

  if (requirements.secondPassReview.required) {
    console.log(`\nSecond-pass review will be required (stronger reviewer available: ${requirements.secondPassReview.preferredReviewer})`);
  }

  if (result.patchSizeResult && result.patchSizeResult.exceedsCap) {
    console.log(`\n⚠️  PATCH SIZE CAP EXCEEDED`);
    console.log(`  ${result.patchSizeResult.totalLines} lines > ${result.patchSizeResult.cap} lines (cap)`);
  }

  if (result.passed) {
    console.log('\n✓ All verification checks passed');
  } else {
    console.log('\n✗ Verification failed - please fix the issues above');
  }

  console.log('='.repeat(60) + '\n');
}

// Run main
main().catch((err) => {
  console.error(`\nFATAL ERROR: ${errorMessage(err)}`);
  process.exit(1);
});
