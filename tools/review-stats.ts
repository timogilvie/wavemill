#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolve } from 'node:path';
import { loadMetrics, type ReviewMetric } from '../shared/lib/review-metrics.ts';
import { CYAN, GREEN, YELLOW, RED, BOLD, DIM, NC } from '../shared/lib/colors.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface FilterOptions {
  from?: string;
  to?: string;
  outcome?: 'resolved' | 'escalated' | 'error';
  branch?: string;
  issue?: string;
}

interface AggregateStats {
  totalReviews: number;
  avgIterations: number;
  resolutionRate: number;
  escalationRate: number;
  errorRate: number;
  iterationDistribution: Record<string, number>;
  findingsSummary: {
    total: number;
    avgPerReview: number;
    blockers: number;
    warnings: number;
    blockersPercent: number;
    warningsPercent: number;
  };
  topCategories: Array<{ category: string; count: number; percent: number }>;
  recentReviews: Array<{
    issue: string;
    branch: string;
    targetBranch: string;
    iterations: number;
    outcome: string;
    date: string;
  }>;
}

// ────────────────────────────────────────────────────────────────
// Filtering
// ────────────────────────────────────────────────────────────────

function filterMetrics(metrics: ReviewMetric[], options: FilterOptions): ReviewMetric[] {
  return metrics.filter((m) => {
    // Date range filter
    if (options.from) {
      const fromDate = new Date(options.from);
      const metricDate = new Date(m.timestamp);
      if (metricDate < fromDate) return false;
    }

    if (options.to) {
      const toDate = new Date(options.to);
      toDate.setHours(23, 59, 59, 999); // Include entire day
      const metricDate = new Date(m.timestamp);
      if (metricDate > toDate) return false;
    }

    // Outcome filter
    if (options.outcome && m.outcome !== options.outcome) {
      return false;
    }

    // Branch filter (simple substring match)
    if (options.branch && !m.branch.includes(options.branch)) {
      return false;
    }

    // Issue filter
    if (options.issue && m.issueId !== options.issue) {
      return false;
    }

    return true;
  });
}

// ────────────────────────────────────────────────────────────────
// Aggregation
// ────────────────────────────────────────────────────────────────

function computeStats(metrics: ReviewMetric[], limit: number): AggregateStats {
  const totalReviews = metrics.length;

  if (totalReviews === 0) {
    return {
      totalReviews: 0,
      avgIterations: 0,
      resolutionRate: 0,
      escalationRate: 0,
      errorRate: 0,
      iterationDistribution: {},
      findingsSummary: {
        total: 0,
        avgPerReview: 0,
        blockers: 0,
        warnings: 0,
        blockersPercent: 0,
        warningsPercent: 0,
      },
      topCategories: [],
      recentReviews: [],
    };
  }

  // Iteration statistics
  const totalIterations = metrics.reduce((sum, m) => sum + m.totalIterations, 0);
  const avgIterations = totalIterations / totalReviews;

  // Outcome statistics
  const resolved = metrics.filter((m) => m.outcome === 'resolved').length;
  const escalated = metrics.filter((m) => m.outcome === 'escalated').length;
  const errors = metrics.filter((m) => m.outcome === 'error').length;

  const resolutionRate = (resolved / totalReviews) * 100;
  const escalationRate = (escalated / totalReviews) * 100;
  const errorRate = (errors / totalReviews) * 100;

  // Iteration distribution
  const iterationDist: Record<string, number> = {};
  for (const metric of metrics) {
    const key = metric.totalIterations >= 4 ? '4+' : String(metric.totalIterations);
    iterationDist[key] = (iterationDist[key] || 0) + 1;
  }

  // Findings statistics
  let totalBlockers = 0;
  let totalWarnings = 0;
  const categoryCount: Record<string, number> = {};

  for (const metric of metrics) {
    for (const iteration of metric.iterations) {
      totalBlockers += iteration.findingsSummary.blockers;
      totalWarnings += iteration.findingsSummary.warnings;

      // Count categories
      if (iteration.findings) {
        for (const finding of iteration.findings) {
          categoryCount[finding.category] = (categoryCount[finding.category] || 0) + 1;
        }
      }
    }
  }

  const totalFindings = totalBlockers + totalWarnings;
  const avgPerReview = totalFindings / totalReviews;
  const blockersPercent = totalFindings > 0 ? (totalBlockers / totalFindings) * 100 : 0;
  const warningsPercent = totalFindings > 0 ? (totalWarnings / totalFindings) * 100 : 0;

  // Top categories
  const topCategories = Object.entries(categoryCount)
    .map(([category, count]) => ({
      category,
      count,
      percent: (count / totalFindings) * 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Recent reviews
  const sortedMetrics = [...metrics].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const recentReviews = sortedMetrics.slice(0, limit).map((m) => ({
    issue: m.issueId || 'N/A',
    branch: m.branch,
    targetBranch: m.targetBranch,
    iterations: m.totalIterations,
    outcome: m.outcome,
    date: m.timestamp.split('T')[0],
  }));

  return {
    totalReviews,
    avgIterations,
    resolutionRate,
    escalationRate,
    errorRate,
    iterationDistribution: iterationDist,
    findingsSummary: {
      total: totalFindings,
      avgPerReview,
      blockers: totalBlockers,
      warnings: totalWarnings,
      blockersPercent,
      warningsPercent,
    },
    topCategories,
    recentReviews,
  };
}

// ────────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────────

function formatStats(stats: AggregateStats): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push(`${BOLD}${CYAN}  REVIEW METRICS SUMMARY${NC}`);
  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  if (stats.totalReviews === 0) {
    lines.push(`${DIM}No review metrics found.${NC}`);
    lines.push('');
    lines.push(`${DIM}Run some workflows with self-review to collect data.${NC}`);
    lines.push('');
    lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
    lines.push('');
    return lines.join('\n');
  }

  // Overall statistics
  lines.push(`${BOLD}Overall Statistics:${NC}`);
  lines.push(`  Total reviews:        ${stats.totalReviews}`);
  lines.push(`  Average iterations:   ${stats.avgIterations.toFixed(1)}`);
  lines.push(
    `  Resolution rate:      ${GREEN}${stats.resolutionRate.toFixed(1)}%${NC} (${Math.round((stats.resolutionRate / 100) * stats.totalReviews)}/${stats.totalReviews})`
  );
  lines.push(
    `  Escalation rate:      ${YELLOW}${stats.escalationRate.toFixed(1)}%${NC} (${Math.round((stats.escalationRate / 100) * stats.totalReviews)}/${stats.totalReviews})`
  );
  lines.push(
    `  Error rate:           ${RED}${stats.errorRate.toFixed(1)}%${NC} (${Math.round((stats.errorRate / 100) * stats.totalReviews)}/${stats.totalReviews})`
  );
  lines.push('');

  // Iteration distribution
  lines.push(`${BOLD}Iteration Distribution:${NC}`);
  const sortedDist = Object.entries(stats.iterationDistribution).sort((a, b) => {
    const numA = a[0] === '4+' ? 4 : parseInt(a[0]);
    const numB = b[0] === '4+' ? 4 : parseInt(b[0]);
    return numA - numB;
  });

  for (const [key, count] of sortedDist) {
    const percent = ((count / stats.totalReviews) * 100).toFixed(1);
    const label = key === '1' ? '1 iteration' : `${key} iterations`;
    const bar = '█'.repeat(Math.round((count / stats.totalReviews) * 30));
    lines.push(`  ${label.padEnd(15)} ${percent.padStart(5)}% (${count.toString().padStart(2)}) ${DIM}${bar}${NC}`);
  }
  lines.push('');

  // Findings summary
  lines.push(`${BOLD}Findings Summary:${NC}`);
  lines.push(`  Total findings:       ${stats.findingsSummary.total}`);
  lines.push(`  Avg per review:       ${stats.findingsSummary.avgPerReview.toFixed(1)}`);
  lines.push(
    `  Blockers:             ${RED}${stats.findingsSummary.blockers}${NC} (${stats.findingsSummary.blockersPercent.toFixed(1)}%)`
  );
  lines.push(
    `  Warnings:             ${YELLOW}${stats.findingsSummary.warnings}${NC} (${stats.findingsSummary.warningsPercent.toFixed(1)}%)`
  );
  lines.push('');

  // Top categories
  if (stats.topCategories.length > 0) {
    lines.push(`${BOLD}Top Finding Categories:${NC}`);
    stats.topCategories.forEach((cat, i) => {
      lines.push(
        `  ${(i + 1).toString().padStart(2)}. ${cat.category.padEnd(30)} ${cat.count.toString().padStart(3)} (${cat.percent.toFixed(1)}%)`
      );
    });
    lines.push('');
  }

  // Recent reviews
  if (stats.recentReviews.length > 0) {
    lines.push(`${BOLD}Recent Reviews (last ${stats.recentReviews.length}):${NC}`);
    for (const review of stats.recentReviews) {
      const outcomeColor =
        review.outcome === 'resolved' ? GREEN : review.outcome === 'escalated' ? YELLOW : RED;
      const iterText = review.iterations === 1 ? '1 iteration' : `${review.iterations} iterations`;
      lines.push(
        `  ${DIM}${review.issue.padEnd(10)}${NC} ${review.branch.padEnd(20).slice(0, 20)} ${iterText.padEnd(15)} ${outcomeColor}${review.outcome.padEnd(10)}${NC} ${DIM}${review.date}${NC}`
      );
    }
    lines.push('');
  }

  lines.push(`${BOLD}${CYAN}${'═'.repeat(63)}${NC}`);
  lines.push('');

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

runTool({
  name: 'review-stats',
  description: 'Show review metrics summary and statistics',
  options: {
    from: { type: 'string', description: 'Include reviews from this date (YYYY-MM-DD)' },
    to: { type: 'string', description: 'Include reviews up to this date (YYYY-MM-DD)' },
    outcome: { type: 'string', description: 'Filter by outcome (resolved, escalated, error)' },
    branch: { type: 'string', description: 'Filter by branch name (substring match)' },
    issue: { type: 'string', description: 'Filter by Linear issue ID' },
    limit: { type: 'string', description: 'Number of recent reviews to show (default: 5)' },
    json: { type: 'boolean', description: 'Output as JSON' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'repoDir',
    description: 'Repository directory (default: current directory)',
  },
  examples: [
    'npx tsx tools/review-stats.ts',
    'npx tsx tools/review-stats.ts --from 2026-01-01',
    'npx tsx tools/review-stats.ts --outcome resolved',
    'npx tsx tools/review-stats.ts --json',
  ],
  additionalHelp: `Displays aggregate statistics from review metrics log.

Filter Options:
  --from YYYY-MM-DD       Reviews from this date (inclusive)
  --to YYYY-MM-DD         Reviews up to this date (inclusive)
  --outcome TYPE          Filter by outcome (resolved/escalated/error)
  --branch PATTERN        Filter by branch name (substring)
  --issue ISSUE-ID        Filter by Linear issue ID`,
  run({ args, positional }) {
    const repoDir = positional[0] ? resolve(positional[0]) : process.cwd();
    const limit = args.limit ? parseInt(String(args.limit), 10) : 5;

    // Load all metrics
    const allMetrics = loadMetrics(repoDir);

    // Build filter options
    const filterOptions: FilterOptions = {};
    if (args.from) filterOptions.from = String(args.from);
    if (args.to) filterOptions.to = String(args.to);
    if (args.outcome) {
      const outcome = String(args.outcome);
      if (!['resolved', 'escalated', 'error'].includes(outcome)) {
        console.error(`Error: Invalid outcome '${outcome}'. Must be one of: resolved, escalated, error`);
        process.exit(1);
      }
      filterOptions.outcome = outcome as 'resolved' | 'escalated' | 'error';
    }
    if (args.branch) filterOptions.branch = String(args.branch);
    if (args.issue) filterOptions.issue = String(args.issue);

    // Filter metrics
    const metrics = filterMetrics(allMetrics, filterOptions);

    // Compute statistics
    const stats = computeStats(metrics, limit);

    // Output
    if (args.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      const output = formatStats(stats);
      console.log(output);
    }
  },
});
