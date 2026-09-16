#!/usr/bin/env npx tsx
/**
 * Quarantine challenge records that violated the one-variable invariant.
 * Marks records as ineligible for stage-level learning.
 *
 * Usage:
 *   npx tsx tools/quarantine-challenge.ts [--repo-dir <dir>] [--dry-run] <issue-ids...>
 *
 * Examples:
 *   npx tsx tools/quarantine-challenge.ts HOK-2806 HOK-3002
 *   npx tsx tools/quarantine-challenge.ts --dry-run HOK-2806
 *   npx tsx tools/quarantine-challenge.ts --repo-dir /path/to/repo HOK-2806
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

interface QuarantineMarker {
  reason: 'multiple-varied-roles';
  ticket: 'HOK-3018';
  at: string;
}

interface QuarantinedRecord {
  quarantined?: {
    reason: string;
    ticket: string;
    at: string;
  };
}

function parseArgs() {
  const args = argv.slice(2);
  let repoDir = process.cwd();
  let dryRun = false;
  const issues: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-dir' && i + 1 < args.length) {
      repoDir = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (!args[i].startsWith('--')) {
      issues.push(args[i]);
    }
  }

  return { repoDir, dryRun, issues };
}

async function quarantineChallenges(repoDir: string, issues: string[], dryRun: boolean): Promise<void> {
  const challengeRecordsPath = join(repoDir, '.wavemill', 'evals', 'challenge-records.jsonl');

  let content: string;
  try {
    content = readFileSync(challengeRecordsPath, 'utf-8');
  } catch (error) {
    console.error(`Error: Could not read challenge records: ${challengeRecordsPath}`);
    process.exit(1);
  }

  const lines = content.split('\n').filter(line => line.trim().length > 0);
  const quarantineSet = new Set(issues.map(id => id.toLowerCase()));
  let quarantinedCount = 0;
  let matchedCount = 0;
  let alreadyQuarantinedCount = 0;

  const updatedLines = lines.map(line => {
    try {
      const record = JSON.parse(line) as QuarantinedRecord & { challengePairId?: string };

      // Extract issue IDs from challengePairId (e.g., "HOK-2806:HOK-2806_c" -> ["HOK-2806"])
      const pairId = record.challengePairId || '';
      const issueIdMatch = pairId.match(/^([A-Z]+-\d+)/);
      const primaryIssue = issueIdMatch ? issueIdMatch[1].toLowerCase() : '';

      if (!quarantineSet.has(primaryIssue)) {
        return line;
      }

      matchedCount++;

      // Check if already quarantined
      if (record.quarantined) {
        alreadyQuarantinedCount++;
        return line;
      }

      // Add quarantine marker
      const marker: QuarantineMarker = {
        reason: 'multiple-varied-roles',
        ticket: 'HOK-3018',
        at: new Date().toISOString(),
      };
      record.quarantined = marker;
      quarantinedCount++;

      return JSON.stringify(record);
    } catch (error) {
      // If a line can't be parsed, keep it as-is
      return line;
    }
  });

  if (dryRun) {
    console.log(`Dry run: Would quarantine ${quarantinedCount} record(s)`);
    console.log(`Found ${matchedCount} matching record(s)`);
    console.log(`Already quarantined: ${alreadyQuarantinedCount}`);
    console.log(`No changes written`);
  } else {
    const output = updatedLines.join('\n') + (updatedLines.length > 0 ? '\n' : '');
    writeFileSync(challengeRecordsPath, output, 'utf-8');
    console.log(`Quarantined ${quarantinedCount} record(s)`);
    console.log(`Found ${matchedCount} matching record(s)`);
    console.log(`Already quarantined: ${alreadyQuarantinedCount}`);
    console.log(`Updated ${challengeRecordsPath}`);
  }
}

async function main() {
  const { repoDir, dryRun, issues } = parseArgs();

  if (issues.length === 0) {
    console.error('Usage: npx tsx tools/quarantine-challenge.ts [--repo-dir <dir>] [--dry-run] <issue-ids...>');
    console.error('Example: npx tsx tools/quarantine-challenge.ts HOK-2806 HOK-3002');
    process.exit(1);
  }

  try {
    await quarantineChallenges(repoDir, issues, dryRun);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
