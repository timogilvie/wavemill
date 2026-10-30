/**
 * One-shot migration (HOK-2891).
 *
 * Historically `archive_stage_artifacts` stripped the leading dot from stage
 * result and sibling artifact file names (e.g. `coding-result.json`), while
 * every reader kept the dot (`.coding-result.json`). After HOK-2891 the
 * archiver keeps the live name; this tool renames already-archived files
 * under `.wavemill/evals/artifacts/<issue>/` so historical tasks are
 * retrievable through the one lookup.
 *
 * Idempotent: when the destination already exists we keep it and leave the
 * source in place (warn), skipping on an already-migrated tree is a no-op.
 */
import { readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRouteArtifactArchiveDir } from '../shared/lib/evals-paths.ts';
import { resolveFromMainRepo } from '../shared/lib/git-utils.ts';

/**
 * Dot-prefixed live names that `archive_stage_artifacts` used to strip. Each
 * entry is checked under every per-issue archive dir.
 */
const RENAMES: Array<{ from: string; to: string }> = [
  // Route lifecycle artifacts.
  { from: 'routing-complete.json', to: '.routing-complete' },
  { from: 'initial-route.json', to: '.initial-route.json' },
  { from: 'post-expansion-route.json', to: '.post-expansion-route.json' },
  // Operator intervention record.
  { from: 'operator-intervention.json', to: '.operator-intervention.json' },
  // Reliability-report evidence (HOK-3182).
  { from: 'operator-events.jsonl', to: '.operator-events.jsonl' },
  { from: 'terminal-history.jsonl', to: '.terminal-history.jsonl' },
  // Resolved coding uncommitted output.
  {
    from: 'coding-uncommitted-output.resolved.jsonl',
    to: '.coding-uncommitted-output.resolved.jsonl',
  },
  // Stage result files.
  { from: 'planning-result.json', to: '.planning-result.json' },
  { from: 'coding-result.json', to: '.coding-result.json' },
  { from: 'review-result.json', to: '.review-result.json' },
];

export interface MigrateOptions {
  repoDir?: string;
  dryRun?: boolean;
  logger?: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

export interface MigrateReport {
  issuesScanned: number;
  renamed: Array<{ issue: string; from: string; to: string }>;
  skipped: Array<{ issue: string; from: string; to: string; reason: string }>;
}

const defaultLogger = {
  info(msg: string) {
    process.stdout.write(`${msg}\n`);
  },
  warn(msg: string) {
    process.stderr.write(`${msg}\n`);
  },
};

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

export function migrateArchivedStageArtifacts(options: MigrateOptions = {}): MigrateReport {
  const log = options.logger ?? defaultLogger;
  const dryRun = Boolean(options.dryRun);
  const repoDir = options.repoDir
    ? options.repoDir
    : resolveFromMainRepo('.', process.cwd());
  const artifactsRoot = resolveRouteArtifactArchiveDir('__present__', repoDir);
  if (!artifactsRoot) {
    throw new Error('migrate-archived-stage-artifacts: could not resolve archive root');
  }
  const root = dirname(artifactsRoot);
  const report: MigrateReport = { issuesScanned: 0, renamed: [], skipped: [] };

  const issues = listSubdirs(root);
  for (const issue of issues) {
    const issueDir = join(root, issue);
    report.issuesScanned += 1;
    for (const { from, to } of RENAMES) {
      const srcPath = join(issueDir, from);
      const destPath = join(issueDir, to);
      // Only rename files resolved under the per-issue archive dir.
      if (basename(dirname(srcPath)) !== issue) continue;
      const srcExists = fileExists(srcPath);
      const destExists = fileExists(destPath);
      if (!srcExists && !destExists) continue;

      if (destExists && !srcExists) {
        // Already migrated — silent skip.
        continue;
      }
      if (destExists && srcExists) {
        log.warn(
          `[migrate-archive] ${issue}: both ${from} and ${to} exist; keeping dot-prefixed ${to}`,
        );
        report.skipped.push({ issue, from, to, reason: 'both-exist' });
        continue;
      }
      if (dryRun) {
        log.info(`[dry-run] ${issue}: rename ${from} -> ${to}`);
        report.renamed.push({ issue, from, to });
        continue;
      }
      renameSync(srcPath, destPath);
      log.info(`[migrate-archive] ${issue}: renamed ${from} -> ${to}`);
      report.renamed.push({ issue, from, to });
    }
  }

  return report;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const dryRun = process.argv.includes('--dry-run');
  const report = migrateArchivedStageArtifacts({ dryRun });
  process.stdout.write(
    `migrate-archived-stage-artifacts: scanned ${report.issuesScanned} issue(s), ${report.renamed.length} rename(s), ${report.skipped.length} skip(s)\n`,
  );
}
