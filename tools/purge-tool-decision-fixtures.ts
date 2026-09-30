#!/usr/bin/env -S npx tsx

/**
 * Purge scripted test fixtures out of the real tool-decision corpus and
 * session-event streams (HOK-3121).
 *
 * The launch-planning tests used to run with `repoDir` pointed at the
 * real repo checkout, which caused their scripted planning sessions to
 * bleed into `.wavemill/tool-decisions/corpus.jsonl` and
 * `.wavemill/session-events/`. That leak is now blocked at source, but
 * the polluted files persist and need a one-time cleanup.
 *
 * This tool is idempotent: rerunning it on a clean corpus is a no-op
 * and leaves no backup.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  isScriptedToolDecisionRow,
  purgeToolDecisionRows,
  resolveToolDecisionCorpusPath,
} from '../shared/lib/native-agent/tool-decision-corpus.ts';
import {
  findScriptedSessionEventStreams,
  resolveSessionEventsDir,
} from '../shared/lib/native-agent/session-stream.ts';

interface PurgeSummary {
  repoDir: string;
  corpus: {
    path: string;
    total: number;
    removed: number;
    kept: number;
    backupPath?: string;
  };
  sessionEvents: {
    dir: string;
    backupDir?: string;
    moved: string[];
  };
  dryRun: boolean;
}

export function purgeToolDecisionFixtures(opts: {
  repoDir: string;
  dryRun?: boolean;
  now?: Date;
}): PurgeSummary {
  const repoDir = resolve(opts.repoDir);
  const corpusPath = resolveToolDecisionCorpusPath({ repoDir });
  const corpusResult = purgeToolDecisionRows(corpusPath, isScriptedToolDecisionRow, {
    dryRun: opts.dryRun ?? false,
  });

  const eventsDir = resolveSessionEventsDir(repoDir);
  const streams = findScriptedSessionEventStreams(eventsDir);
  const moved: string[] = [];
  let backupDir: string | undefined;
  if (streams.length > 0) {
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupDir = join(eventsDir, `.bak-hok-3121-${stamp}`);
    if (!opts.dryRun) {
      mkdirSync(backupDir, { recursive: true });
      for (const streamPath of streams) {
        const dest = join(backupDir, basename(streamPath));
        renameSync(streamPath, dest);
        moved.push(dest);
      }
    } else {
      for (const streamPath of streams) {
        moved.push(join(backupDir, basename(streamPath)));
      }
    }
  }

  return {
    repoDir,
    corpus: {
      path: corpusResult.path,
      total: corpusResult.total,
      removed: corpusResult.removed,
      kept: corpusResult.kept,
      ...(corpusResult.backupPath ? { backupPath: corpusResult.backupPath } : {}),
    },
    sessionEvents: {
      dir: eventsDir,
      ...(backupDir ? { backupDir } : {}),
      moved,
    },
    dryRun: opts.dryRun ?? false,
  };
}

function formatSummary(summary: PurgeSummary): string {
  const lines: string[] = [];
  lines.push(`Repo: ${summary.repoDir}${summary.dryRun ? ' (dry-run)' : ''}`);
  lines.push('');
  lines.push('Corpus:');
  lines.push(`  path:    ${summary.corpus.path}`);
  if (existsSync(summary.corpus.path)) {
    lines.push(`  total:   ${summary.corpus.total}`);
    lines.push(`  removed: ${summary.corpus.removed}`);
    lines.push(`  kept:    ${summary.corpus.kept}`);
    if (summary.corpus.backupPath) {
      lines.push(`  backup:  ${summary.corpus.backupPath}`);
    }
  } else {
    lines.push('  (no corpus file found — nothing to purge)');
  }
  lines.push('');
  lines.push('Session events:');
  lines.push(`  dir:   ${summary.sessionEvents.dir}`);
  if (summary.sessionEvents.moved.length === 0) {
    lines.push('  (no scripted-model streams found)');
  } else {
    if (summary.sessionEvents.backupDir) {
      lines.push(`  backup dir: ${summary.sessionEvents.backupDir}`);
    }
    lines.push(`  moved:      ${summary.sessionEvents.moved.length}`);
    for (const path of summary.sessionEvents.moved) {
      lines.push(`    - ${path}`);
    }
  }
  return lines.join('\n');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

const config = {
  name: 'purge-tool-decision-fixtures',
  description:
    'Purge scripted test fixtures from a repo\'s tool-decision corpus and session-event streams',
  options: {
    'repo-dir': {
      type: 'string' as const,
      description: 'Repository directory whose .wavemill/ to purge (defaults to cwd)',
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
    'npx tsx tools/purge-tool-decision-fixtures.ts --dry-run',
    'npx tsx tools/purge-tool-decision-fixtures.ts --repo-dir /path/to/checkout',
  ],
  async run({ args }: {
    args: {
      'repo-dir'?: string;
      'dry-run'?: boolean;
      json?: boolean;
    };
  }) {
    const repoDir = args['repo-dir'] ?? process.cwd();
    const summary = purgeToolDecisionFixtures({
      repoDir,
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
