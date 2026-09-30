#!/usr/bin/env -S npx tsx

/**
 * Backfill tool-decision corpus (HOK-3120).
 *
 * Harvests existing worktree-local corpora into the main repo, and replays
 * session-event streams (on or after a cutoff date) through the capture
 * pipeline to populate the main corpus with rows that were previously lost.
 *
 * The tool is idempotent: duplicate rows are deduplicated by decisionId,
 * and scripted rows (from test fixtures) are filtered out automatically.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveMainRepo } from '../shared/lib/git-utils.ts';
import {
  appendToolDecisions,
  isScriptedToolDecisionRow,
  resolveToolDecisionCorpusPath,
} from '../shared/lib/native-agent/tool-decision-corpus.ts';
import { parseToolDecisionJsonl } from '../shared/lib/native-agent/tool-decision-schema.ts';
import { resolveSessionEventsDir } from '../shared/lib/native-agent/session-stream.ts';
import { captureToolDecisionsFromStream } from '../shared/lib/native-agent/tool-decision-capture.ts';

interface BackfillSummary {
  repoDir: string;
  harvest?: {
    attempted: number;
    processed: number;
    rows: number;
    deduped: number;
    filtered: number;
  };
  backfill?: {
    since: string;
    skipped: number;
    processed: number;
    appended: number;
  };
  dryRun: boolean;
}

const DEFAULT_SINCE = new Date('2026-09-22T00:00:00Z');

/**
 * List all subdirectories under worktrees/ that exist in the repo.
 * Returns absolute paths.
 */
function listWorktrees(repoDir: string): string[] {
  const worktreesDir = join(repoDir, 'worktrees');
  if (!existsSync(worktreesDir)) return [];
  try {
    const entries = readdirSync(worktreesDir);
    return entries.map((e) => join(worktreesDir, e)).filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export interface BackfillOptions {
  repoDir: string;
  harvestOnly?: boolean;
  backfillOnly?: boolean;
  since?: Date;
  dryRun?: boolean;
}

export function backfillToolDecisions(opts: BackfillOptions): BackfillSummary {
  const repoDir = resolve(opts.repoDir);
  const mainRepo = resolveMainRepo(repoDir) || repoDir;
  const dryRun = opts.dryRun ?? false;
  const since = opts.since ?? DEFAULT_SINCE;
  const summary: BackfillSummary = {
    repoDir: mainRepo,
    dryRun,
  };

  // Phase 1: Harvest worktree-local corpora
  if (!opts.backfillOnly) {
    const mainCorpusPath = resolveToolDecisionCorpusPath({ repoDir: mainRepo });
    const harvestSummary = { attempted: 0, processed: 0, rows: 0, deduped: 0, filtered: 0 };
    const worktrees = listWorktrees(mainRepo);

    for (const worktreeDir of worktrees) {
      const localCorpus = join(worktreeDir, '.wavemill/tool-decisions/corpus.jsonl');
      if (!existsSync(localCorpus)) continue;

      harvestSummary.attempted += 1;
      try {
        const raw = readFileSync(localCorpus, 'utf-8');
        let parsed: unknown[] = [];
        try {
          parsed = parseToolDecisionJsonl(raw);
        } catch {
          // Skip unparseable corpus
          continue;
        }

        // Filter out scripted rows before appending
        const filtered = parsed.filter((row) => !isScriptedToolDecisionRow(row));
        harvestSummary.filtered += parsed.length - filtered.length;
        harvestSummary.rows += filtered.length;

        if (!dryRun && filtered.length > 0) {
          const appendResult = appendToolDecisions(filtered, mainCorpusPath);
          harvestSummary.processed += 1;
          harvestSummary.deduped += appendResult.skippedDuplicates;
        } else if (filtered.length > 0) {
          harvestSummary.processed += 1;
        }

        // Remove the worktree-local corpus directory after successful harvest
        if (!dryRun && filtered.length > 0) {
          const toolDecisionsDir = join(worktreeDir, '.wavemill/tool-decisions');
          try {
            rmSync(toolDecisionsDir, { recursive: true, force: true });
          } catch {
            // best-effort
          }
        }
      } catch {
        // Skip this worktree corpus on read error
        continue;
      }
    }

    summary.harvest = harvestSummary;
  }

  // Phase 2: Backfill from session-event streams
  if (!opts.harvestOnly) {
    const mainRepo = resolve(opts.repoDir);
    const eventsDir = resolveSessionEventsDir(mainRepo);
    const backfillSummary = { since: since.toISOString(), skipped: 0, processed: 0, appended: 0 };

    if (existsSync(eventsDir)) {
      let entries: string[];
      try {
        entries = readdirSync(eventsDir);
      } catch {
        entries = [];
      }

      for (const entry of entries) {
        if (!entry.startsWith('wavemill-') || !entry.endsWith('.jsonl')) continue;

        const streamPath = join(eventsDir, entry);
        let mtime: Date;
        try {
          mtime = statSync(streamPath).mtime;
        } catch {
          continue;
        }

        if (mtime < since) {
          backfillSummary.skipped += 1;
          continue;
        }

        if (dryRun) {
          backfillSummary.processed += 1;
          continue;
        }

        const res = captureToolDecisionsFromStream({
          eventStreamPath: streamPath,
          repoDir: mainRepo,
        });

        if (res.ok) {
          backfillSummary.processed += 1;
          backfillSummary.appended += res.appended ?? 0;
        }
      }
    }

    summary.backfill = backfillSummary;
  }

  return summary;
}

function formatSummary(summary: BackfillSummary): string {
  const lines: string[] = [];
  lines.push(`Repo: ${summary.repoDir}${summary.dryRun ? ' (dry-run)' : ''}`);
  lines.push('');

  if (summary.harvest) {
    lines.push('Harvest:');
    lines.push(`  worktrees attempted:  ${summary.harvest.attempted}`);
    lines.push(`  worktrees processed:  ${summary.harvest.processed}`);
    lines.push(`  rows harvested:       ${summary.harvest.rows}`);
    lines.push(`  rows deduplicated:    ${summary.harvest.deduped}`);
    lines.push(`  scripted rows filtered: ${summary.harvest.filtered}`);
    lines.push('');
  }

  if (summary.backfill) {
    lines.push('Backfill:');
    lines.push(`  since:      ${summary.backfill.since}`);
    lines.push(`  skipped:    ${summary.backfill.skipped}`);
    lines.push(`  processed:  ${summary.backfill.processed}`);
    lines.push(`  appended:   ${summary.backfill.appended}`);
    lines.push('');
  }

  return lines.join('\n');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'backfill-tool-decisions',
  description: 'Harvest worktree corpora and backfill from session-event streams',
  options: {
    'repo-dir': {
      type: 'string' as const,
      description: 'Repository directory (defaults to cwd, resolved to main repo)',
    },
    'harvest-only': {
      type: 'boolean' as const,
      description: 'Only harvest worktree-local corpora; skip backfill',
    },
    'backfill-only': {
      type: 'boolean' as const,
      description: 'Only backfill from session-event streams; skip harvest',
    },
    since: {
      type: 'string' as const,
      description: `Include session streams on or after this ISO date (default: 2026-09-22T00:00:00Z)`,
    },
    'dry-run': {
      type: 'boolean' as const,
      description: 'Report what would change without writing anything',
    },
    json: {
      type: 'boolean' as const,
      description: 'Emit the summary as JSON instead of a human-readable report',
    },
  },
  examples: [
    'npx tsx tools/backfill-tool-decisions.ts',
    'npx tsx tools/backfill-tool-decisions.ts --harvest-only',
    'npx tsx tools/backfill-tool-decisions.ts --dry-run --json',
  ],
  async run({ args }: {
    args: {
      'repo-dir'?: string;
      'harvest-only'?: boolean;
      'backfill-only'?: boolean;
      since?: string;
      'dry-run'?: boolean;
      json?: boolean;
    };
  }) {
    const repoDir = args['repo-dir'] ?? process.cwd();
    let sinceDate = DEFAULT_SINCE;
    if (args.since) {
      try {
        sinceDate = new Date(args.since);
      } catch {
        console.error(`Invalid --since date: ${args.since}`);
        process.exit(1);
      }
    }

    const summary = backfillToolDecisions({
      repoDir,
      harvestOnly: args['harvest-only'] ?? false,
      backfillOnly: args['backfill-only'] ?? false,
      since: sinceDate,
      dryRun: args['dry-run'] ?? false,
    });

    if (args.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatSummary(summary));
    }
  },
};

if (isMainModule) {
  runTool(config);
}
