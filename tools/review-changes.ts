#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve } from 'node:path';
import { reviewChanges, type ReviewResult } from '../shared/lib/review-runner.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from '../shared/lib/colors.ts';

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

runTool({
  name: 'review-changes',
  description: 'Review code changes against plan and task packet',
  options: {
    verbose: { type: 'boolean', description: 'Print full review output and debug info' },
    'skip-ui': { type: 'boolean', description: 'Skip UI verification even if design context exists' },
    'ui-only': { type: 'boolean', description: 'Run only UI verification (skip code review)' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'targetBranch repoDir',
    description: 'Target branch and optional repository directory',
    multiple: true,
  },
  examples: [
    'npx tsx tools/review-changes.ts',
    'npx tsx tools/review-changes.ts develop',
    'npx tsx tools/review-changes.ts main --verbose',
    'npx tsx tools/review-changes.ts main /path/to/repo --skip-ui',
  ],
  additionalHelp: `Exit Codes:
  0 - Review passed (verdict: ready)
  1 - Review failed (verdict: not_ready)
  2 - Error occurred`,
  async run({ args, positional }) {
    const targetBranch = positional[0] || 'main';
    const repoDir = positional[1] ? resolve(positional[1]) : process.cwd();
    const verbose = !!args.verbose;

    try {
      console.error('Running code review...');
      if (verbose) {
        console.error(`  Target branch: ${targetBranch}`);
        console.error(`  Repository: ${repoDir}`);
        console.error(`  Skip UI: ${!!args['skip-ui']}`);
        console.error(`  UI only: ${!!args['ui-only']}`);
        console.error('');
      }

      const result = await reviewChanges({
        targetBranch,
        repoDir,
        skipUi: !!args['skip-ui'],
        uiOnly: !!args['ui-only'],
        verbose,
      });

      const output = formatReviewResult(result, verbose);
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(output + '\n', (err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });

      process.exitCode = result.verdict === 'ready' ? 0 : 1;
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      if (verbose && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exitCode = 2;
    }
  },
});
