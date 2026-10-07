import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOLD, CYAN, DIM, GREEN, NC, RED, YELLOW } from './colors.ts';
import type { ReviewLogFormat } from './review-progress.ts';
import type { ReviewResult } from './review-runner.ts';

/**
 * Parse and validate the review progress log format option.
 */
export function parseLogFormat(value: string | undefined): ReviewLogFormat {
  if (!value || value === 'text') {
    return 'text';
  }
  if (value === 'json') {
    return 'json';
  }
  throw new Error(`Invalid --log-format value: ${value}. Expected "text" or "json".`);
}

/**
 * Format a set of review findings for terminal output.
 */
export function formatFindings(findings: ReviewResult['codeReviewFindings'], title: string): string {
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
 * Format a local review result for terminal output.
 */
export function formatReviewResult(result: ReviewResult, verbose: boolean): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  CODE REVIEW RESULTS${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  const verdictColor = result.verdict === 'ready' ? GREEN : RED;
  const verdictText = result.verdict === 'ready' ? 'READY ✓' : 'NOT READY ✗';
  lines.push(`  ${BOLD}Verdict:${NC} ${verdictColor}${BOLD}${verdictText}${NC}`);
  lines.push('');

  if (result.metadata) {
    lines.push(`  ${DIM}Branch:${NC}  ${result.metadata.branch}`);
    lines.push(`  ${DIM}Files:${NC}   ${result.metadata.files.length} changed`);
    const diffBase = result.metadata.diffBase;
    if (diffBase) {
      const tip = diffBase.reviewedBase ? diffBase.reviewedBase.slice(0, 8) : 'unresolved';
      const mergeBase = diffBase.mergeBaseSha ? diffBase.mergeBaseSha.slice(0, 8) : 'unresolved';
      const staleNote = diffBase.kind === 'local' ? ` ${DIM}(local ref — may be stale)${NC}` : '';
      lines.push(`  ${DIM}Base:${NC}    ${diffBase.ref} @ ${tip} (merge-base ${mergeBase})${staleNote}`);
    }
    if (result.metadata.hasUiChanges) {
      lines.push(`  ${DIM}UI:${NC}      Changes detected`);
    }
    if (result.metadata.designContextAvailable) {
      const uiStatus = result.metadata.uiVerificationRun ? 'verified' : 'skipped';
      lines.push(`  ${DIM}Design:${NC}  Context available (${uiStatus})`);
    }
    lines.push('');
  }

  if (result.needsStrongerReviewer) {
    const reason = result.strongerReviewerReason
      ? ` (${result.strongerReviewerReason})`
      : '';
    lines.push(`  ${DIM}Stronger reviewer needed:${NC} yes${reason}`);
    lines.push('');
  }

  lines.push(formatFindings(result.codeReviewFindings, 'Code Review'));
  lines.push('');

  if (result.uiFindings && result.uiFindings.length > 0) {
    lines.push(formatFindings(result.uiFindings, 'UI Review'));
    lines.push('');
  }

  if (verbose) {
    lines.push(`${BOLD}Full Result (JSON):${NC}`);
    lines.push(JSON.stringify(result, null, 2));
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Detect the review base commit recorded for the current task branch.
 */
export function detectSinceCommit(branchName: string, repoDir: string, verbose: boolean): string | undefined {
  const match = branchName.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return undefined;
  }

  const slug = match[1];

  for (const dir of ['features', 'bugs']) {
    const taskPath = join(repoDir, dir, slug, 'selected-task.json');
    if (existsSync(taskPath)) {
      try {
        const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
        if (task.reviewBaseCommit) {
          if (verbose) {
            console.error(`Auto-detected sinceCommit from ${taskPath}: ${task.reviewBaseCommit.slice(0, 8)}`);
          }
          return task.reviewBaseCommit;
        }
      } catch {
        // Ignore parse errors.
      }
    }
  }

  return undefined;
}
