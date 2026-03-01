#!/usr/bin/env -S npx tsx

/**
 * Self-Review Tool — Review code changes against plan and task packet
 *
 * Usage:
 *   npx tsx tools/review-changes.ts [targetBranch] [repoDir] [options]
 *   npx tsx tools/review-changes.ts main
 *   npx tsx tools/review-changes.ts main /path/to/repo --verbose
 *   npx tsx tools/review-changes.ts main --skip-ui
 *
 * Options:
 *   --verbose       Print full review output and debug info
 *   --skip-ui       Skip UI verification even if design context exists
 *   --ui-only       Run only UI verification (skip code review)
 *   --help, -h      Show this help message
 *
 * Exit Codes:
 *   0 - Review passed (verdict: ready)
 *   1 - Review failed (verdict: not_ready)
 *   2 - Error occurred
 */

import { resolve } from 'node:path';
import { reviewChanges, type ReviewResult } from '../shared/lib/review-runner.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from '../shared/lib/colors.ts';

// ────────────────────────────────────────────────────────────────
// Argument Parsing
// ────────────────────────────────────────────────────────────────

interface CliArgs {
  targetBranch: string;
  repoDir: string;
  verbose: boolean;
  skipUi: boolean;
  uiOnly: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    targetBranch: 'main',
    repoDir: process.cwd(),
    verbose: false,
    skipUi: false,
    uiOnly: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--skip-ui') {
      args.skipUi = true;
    } else if (arg === '--ui-only') {
      args.uiOnly = true;
    } else if (!arg.startsWith('--')) {
      // Positional arguments
      if (i === 0) {
        args.targetBranch = arg;
      } else if (i === 1) {
        args.repoDir = resolve(arg);
      }
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Self-Review Tool — Review code changes against plan and task packet

Usage:
  review-changes.ts [targetBranch] [repoDir] [options]

Arguments:
  targetBranch   Branch to diff against (default: "main")
  repoDir        Repository directory (default: current directory)

Options:
  --verbose      Print full review output and debug information
  --skip-ui      Skip UI verification even if design context exists
  --ui-only      Run only UI verification (skip code review)
  --help, -h     Show this help message

Examples:
  # Review current branch against main
  npx tsx tools/review-changes.ts

  # Review against develop branch
  npx tsx tools/review-changes.ts develop

  # Verbose output
  npx tsx tools/review-changes.ts main --verbose

  # Skip UI verification
  npx tsx tools/review-changes.ts main --skip-ui

  # UI verification only (when design context available)
  npx tsx tools/review-changes.ts main --ui-only

Exit Codes:
  0 - Review passed (verdict: ready)
  1 - Review failed (verdict: not_ready)
  2 - Error occurred

Environment:
  The review uses the LLM judge configured in .wavemill-config.json
  (eval.judge.model and eval.judge.provider). Defaults to:
    - Model: claude-sonnet-4-5-20250929
    - Provider: claude-cli
`);
}

// ────────────────────────────────────────────────────────────────
// Output Formatting
// ────────────────────────────────────────────────────────────────

/**
 * Format findings for terminal output with color.
 */
function formatFindings(findings: ReviewResult['codeReviewFindings'], title: string): string {
  if (!findings || findings.length === 0) {
    return `${title}: None`;
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  const lines: string[] = [];
  lines.push(`${BOLD}${title}${NC}`);

  if (blockers.length > 0) {
    lines.push(`  ${RED}${BOLD}Blockers: ${blockers.length}${NC}`);
    blockers.forEach((f, i) => {
      lines.push(`    ${RED}${i + 1}.${NC} ${BOLD}[${f.category}]${NC} ${DIM}${f.location}${NC}`);
      lines.push(`       ${f.description}`);
    });
  }

  if (warnings.length > 0) {
    lines.push(`  ${YELLOW}${BOLD}Warnings: ${warnings.length}${NC}`);
    warnings.forEach((f, i) => {
      lines.push(`    ${YELLOW}${i + 1}.${NC} ${BOLD}[${f.category}]${NC} ${DIM}${f.location}${NC}`);
      lines.push(`       ${f.description}`);
    });
  }

  return lines.join('\n');
}

/**
 * Format review result for terminal output.
 */
function formatReviewResult(result: ReviewResult, verbose: boolean): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  CODE REVIEW RESULTS${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  // Verdict
  const verdictColor = result.verdict === 'ready' ? GREEN : RED;
  const verdictText = result.verdict === 'ready' ? 'READY ✓' : 'NOT READY ✗';
  lines.push(`  ${BOLD}Verdict:${NC} ${verdictColor}${BOLD}${verdictText}${NC}`);
  lines.push('');

  // Metadata
  if (result.metadata) {
    lines.push(`  ${DIM}Branch:${NC}  ${result.metadata.branch}`);
    lines.push(`  ${DIM}Files:${NC}   ${result.metadata.files.length} changed`);
    if (result.metadata.hasUiChanges) {
      lines.push(`  ${DIM}UI:${NC}      Changes detected`);
    }
    if (result.metadata.designContextAvailable) {
      const uiStatus = result.metadata.uiVerificationRun ? 'verified' : 'skipped';
      lines.push(`  ${DIM}Design:${NC}  Context available (${uiStatus})`);
    }
    lines.push('');
  }

  // Code review findings
  lines.push(formatFindings(result.codeReviewFindings, 'Code Review'));
  lines.push('');

  // UI findings (if present)
  if (result.uiFindings && result.uiFindings.length > 0) {
    lines.push(formatFindings(result.uiFindings, 'UI Review'));
    lines.push('');
  }

  // Verbose mode: show full JSON
  if (verbose) {
    lines.push(`${BOLD}Full Result (JSON):${NC}`);
    lines.push(JSON.stringify(result, null, 2));
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    return;
  }

  try {
    console.error('Running code review...');
    if (args.verbose) {
      console.error(`  Target branch: ${args.targetBranch}`);
      console.error(`  Repository: ${args.repoDir}`);
      console.error(`  Skip UI: ${args.skipUi}`);
      console.error(`  UI only: ${args.uiOnly}`);
      console.error('');
    }

    // Run review
    const result = await reviewChanges({
      targetBranch: args.targetBranch,
      repoDir: args.repoDir,
      skipUi: args.skipUi,
      uiOnly: args.uiOnly,
      verbose: args.verbose,
    });

    // Format and print result, then flush stdout before setting exit code.
    // Using process.exitCode instead of process.exit() prevents killing the
    // process before stdout/stderr buffers are flushed (a known Node.js issue
    // when these streams are pipes rather than TTYs on POSIX systems).
    const output = formatReviewResult(result, args.verbose);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(output + '\n', (err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });

    process.exitCode = result.verdict === 'ready' ? 0 : 1;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    if (args.verbose && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 2;
  }
}

main();
