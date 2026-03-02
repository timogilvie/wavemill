/**
 * Eval Formatter
 *
 * Formats detailed evaluation records for display.
 * Provides rich, multi-line output with color coding and structured sections.
 *
 * @module eval-formatter
 */

import type { EvalRecord } from './eval-schema.ts';
import { getScoreBand } from './eval-schema.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from './colors.ts';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 0.8) return GREEN;
  if (score >= 0.5) return YELLOW;
  return RED;
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  const empty = 10 - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Format evaluation record for detailed display.
 *
 * Produces a rich, multi-line output with:
 * - Header with metadata (issue, PR, agent, model, time)
 * - Score with visual bar and band
 * - Rationale
 * - Interventions (if any)
 * - Judge flags (if any)
 * - Outcomes summary (CI, tests, review, rework, delivery)
 *
 * @param record - Complete eval record
 * @returns Formatted string suitable for console output
 *
 * @example
 * ```typescript
 * const record = await evaluateTask(...);
 * console.log(formatEvalRecord(record));
 * ```
 */
export function formatEvalRecord(record: EvalRecord): string {
  const band = getScoreBand(record.score as number);
  const lines: string[] = [];

  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  WORKFLOW EVALUATION${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  // Metadata
  if (record.issueId) lines.push(`  ${DIM}Issue:${NC}  ${record.issueId}`);
  if (record.prUrl) lines.push(`  ${DIM}PR:${NC}     ${record.prUrl}`);
  if (record.agentType) lines.push(`  ${DIM}Agent:${NC}  ${record.agentType}`);

  // Show solution model if it differs from the judge model (i.e. was explicitly set)
  if (record.modelId && record.modelId !== record.judgeModel) {
    lines.push(`  ${DIM}Model:${NC}  ${record.modelId}`);
  }
  lines.push(
    `  ${DIM}Judge:${NC}  ${DIM}${record.judgeModel || record.modelId}${NC}`
  );

  if (record.timeSeconds && record.timeSeconds > 0) {
    lines.push(`  ${DIM}Time:${NC}   ${record.timeSeconds}s`);
  }
  lines.push('');

  // Score
  const sc = record.score as number;
  lines.push(
    `  ${BOLD}Score:${NC}  ${scoreColor(sc)}${sc.toFixed(2)}${NC}  ${scoreBar(sc)}  ${BOLD}${band.label}${NC}`
  );
  lines.push(`          ${DIM}${band.description}${NC}`);
  lines.push('');

  // Rationale
  lines.push(`  ${BOLD}Rationale:${NC}`);
  lines.push(`  ${record.rationale}`);
  lines.push('');

  // Interventions
  if (record.interventionRequired) {
    lines.push(
      `  ${BOLD}${YELLOW}Interventions:${NC} ${record.interventionCount}`
    );

    // Show structured interventions if available
    if (record.interventions && record.interventions.length > 0) {
      for (const intervention of record.interventions) {
        const severityColor =
          intervention.severity === 'high'
            ? RED
            : intervention.severity === 'med'
              ? YELLOW
              : DIM;
        const timestamp = new Date(intervention.timestamp).toLocaleTimeString();
        lines.push(
          `    ${severityColor}[${intervention.severity.toUpperCase()}]${NC} ${YELLOW}${intervention.type}${NC} @ ${timestamp}`
        );
        lines.push(`      ${DIM}${intervention.note}${NC}`);
      }
    } else if (record.interventionDetails) {
      // Fallback to legacy interventionDetails
      for (const detail of record.interventionDetails) {
        lines.push(`    ${YELLOW}-${NC} ${detail}`);
      }
    }
    lines.push('');
  } else {
    lines.push(`  ${BOLD}${GREEN}Interventions:${NC} None (fully autonomous)`);
    lines.push('');
  }

  // Intervention flags from judge
  const flags = (record.metadata as any)?.interventionFlags;
  if (flags && flags.length > 0) {
    lines.push(`  ${BOLD}Judge Flags:${NC}`);
    for (const flag of flags) {
      lines.push(`    ${DIM}-${NC} ${flag}`);
    }
    lines.push('');
  }

  // Outcomes Summary
  if (record.outcomes) {
    const o = record.outcomes;
    lines.push(`  ${BOLD}Outcomes:${NC}`);
    lines.push(
      `    ${BOLD}Success:${NC}   ${o.success ? GREEN + '✓' : RED + '✗'}${NC}`
    );

    if (o.ci) {
      const ciStatus = o.ci.passed ? GREEN + 'passed' : RED + 'failed';
      lines.push(
        `    ${BOLD}CI:${NC}        ${ciStatus}${NC} (${o.ci.checks.length} checks)`
      );
    }

    if (o.tests) {
      const testInfo = o.tests.added
        ? `added${o.tests.passRate !== undefined ? ` (${Math.round(o.tests.passRate * 100)}% pass)` : ''}`
        : 'none added';
      lines.push(`    ${BOLD}Tests:${NC}     ${testInfo}`);
    }

    if (o.staticAnalysis && Object.keys(o.staticAnalysis).length > 0) {
      const parts: string[] = [];
      if (o.staticAnalysis.typecheckPassed !== undefined) {
        parts.push(
          o.staticAnalysis.typecheckPassed ? 'typecheck ✓' : 'typecheck ✗'
        );
      }
      if (o.staticAnalysis.lintDelta !== undefined) {
        const lintStatus =
          o.staticAnalysis.lintDelta === 0
            ? '✓'
            : `+${o.staticAnalysis.lintDelta}`;
        parts.push(`lint ${lintStatus}`);
      }
      if (parts.length > 0) {
        lines.push(`    ${BOLD}Analysis:${NC}  ${parts.join(', ')}`);
      }
    }

    lines.push(
      `    ${BOLD}Review:${NC}    ${o.review.approvals} approvals, ${o.review.changeRequests} change requests, ${o.review.rounds} rounds`
    );

    const reworkLine = `    ${BOLD}Rework:${NC}    ${o.rework.agentIterations} iterations`;
    if (o.rework.toolFailures) {
      lines.push(`${reworkLine}, ${o.rework.toolFailures} tool failures`);
    } else {
      lines.push(reworkLine);
    }

    const deliveryStatus = o.delivery.merged
      ? `merged${o.delivery.timeToMergeSeconds ? ` (${Math.round(o.delivery.timeToMergeSeconds / 3600)}h)` : ''}`
      : o.delivery.prCreated
        ? 'PR created'
        : 'no PR';
    lines.push(`    ${BOLD}Delivery:${NC}  ${deliveryStatus}`);
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}
