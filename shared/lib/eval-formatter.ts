/**
 * Eval Formatter
 *
 * Formats evaluation records for human-readable terminal output.
 * Uses ANSI color codes and Unicode box-drawing characters.
 *
 * @module eval-formatter
 */

import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from './colors.ts';
import { getScoreBand } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Format an evaluation record for terminal output.
 *
 * Creates a formatted display with:
 * - Header with metadata (issue, PR, agent, model)
 * - Score visualization (color-coded bar + band label)
 * - Rationale
 * - Interventions (if any)
 * - Outcomes summary (CI, tests, review, delivery)
 *
 * @param record - Evaluation record
 * @returns Formatted string with ANSI colors
 *
 * @example
 * ```typescript
 * const record = await evaluateTask({...}, outcomes);
 * console.log(formatEvalRecord(record));
 * // Prints:
 * // ═══════════════════════════════════════════════════════════════
 * //   WORKFLOW EVALUATION
 * // ═══════════════════════════════════════════════════════════════
 * //
 * //   Issue:  HOK-123
 * //   Score:  0.85  ██████████  EXCELLENT
 * //   ...
 * ```
 */
export function formatEvalRecord(record: any): string {
  const scoreColor = (score: number) => {
    if (score >= 0.8) return GREEN;
    if (score >= 0.5) return YELLOW;
    return RED;
  };

  const scoreBar = (score: number) => {
    const filled = Math.round(score * 10);
    const empty = 10 - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  };

  const band = getScoreBand(record.score);
  const lines = [];

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
  if (record.timeSeconds > 0)
    lines.push(`  ${DIM}Time:${NC}   ${record.timeSeconds}s`);
  lines.push('');

  // Score
  const sc = record.score;
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
    } else {
      // Fallback to legacy interventionDetails
      for (const detail of record.interventionDetails || []) {
        lines.push(`    ${YELLOW}-${NC} ${detail}`);
      }
    }
    lines.push('');
  } else {
    lines.push(`  ${BOLD}${GREEN}Interventions:${NC} None (fully autonomous)`);
    lines.push('');
  }

  // Intervention flags from judge
  const flags = record.metadata?.interventionFlags;
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
      const parts = [];
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
    lines.push(
      `    ${BOLD}Rework:${NC}    ${o.rework.agentIterations} iterations${o.rework.toolFailures ? `, ${o.rework.toolFailures} tool failures` : ''}`
    );

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
