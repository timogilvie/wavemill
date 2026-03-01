#!/usr/bin/env -S npx tsx

/**
 * Deduplicate eval records by keeping only the earliest eval for each issue+PR combination.
 *
 * Usage:
 *   npx tsx tools/deduplicate-evals.ts [--dry-run] [--evals-file <path>]
 *
 * Creates a timestamped backup before modifying the file.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getEvalConfig } from '../shared/lib/config.ts';

// ── Types ────────────────────────────────────────────────────────────────────

interface EvalRecord {
  id: string;
  issueId?: string;
  prUrl?: string;
  timestamp: string;
  [key: string]: unknown;
}

interface DeduplicationResult {
  totalRecords: number;
  uniqueRecords: number;
  duplicatesRemoved: number;
  duplicateGroups: Map<string, EvalRecord[]>;
}

// ── Core Logic ───────────────────────────────────────────────────────────────

function readEvalRecords(filePath: string): EvalRecord[] {
  if (!existsSync(filePath)) {
    throw new Error(`Eval file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const records: EvalRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]) as EvalRecord;
      records.push(record);
    } catch (err) {
      console.warn(`Warning: Failed to parse line ${i + 1}, skipping`);
    }
  }

  return records;
}

function deduplicateRecords(records: EvalRecord[]): DeduplicationResult {
  // Group records by issueId + prUrl
  const groups = new Map<string, EvalRecord[]>();

  for (const record of records) {
    // Create a unique key from issueId and prUrl
    // Handle cases where either might be missing
    const issueId = record.issueId || 'no-issue';
    const prUrl = record.prUrl || 'no-pr';
    const key = `${issueId}|${prUrl}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(record);
  }

  // Find duplicate groups and keep only the earliest record from each
  const duplicateGroups = new Map<string, EvalRecord[]>();
  const uniqueRecords: EvalRecord[] = [];

  for (const [key, groupRecords] of groups) {
    if (groupRecords.length > 1) {
      // Sort by timestamp (earliest first)
      groupRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      duplicateGroups.set(key, groupRecords);
    }
    // Keep the first (earliest) record
    uniqueRecords.push(groupRecords[0]);
  }

  return {
    totalRecords: records.length,
    uniqueRecords: uniqueRecords.length,
    duplicatesRemoved: records.length - uniqueRecords.length,
    duplicateGroups,
  };
}

function formatDuplicateReport(result: DeduplicationResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Duplicates found for the following issue+PR combinations:');
  lines.push('');

  for (const [key, records] of result.duplicateGroups) {
    const [issueId, prUrlRaw] = key.split('|');
    const prUrl = prUrlRaw === 'no-pr' ? '(no PR)' : prUrlRaw;
    const prNumber = prUrl.match(/\/pull\/(\d+)$/)?.[1] || prUrl;
    const earliest = records[0].timestamp;

    lines.push(`  ${issueId} + ${prNumber}: ${records.length} records → keeping earliest (${earliest})`);
  }

  return lines.join('\n');
}

function writeEvalRecords(filePath: string, records: EvalRecord[]): void {
  // Sort records by timestamp for consistency
  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const content = sorted.map((record) => JSON.stringify(record)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

function createBackup(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const backupPath = `${filePath}.backup-${timestamp}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

// ── CLI Tool ─────────────────────────────────────────────────────────────────

runTool({
  name: 'deduplicate-evals',
  description: 'Remove duplicate eval records, keeping only the earliest eval for each issue+PR',
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be removed without making changes',
    },
    'evals-file': {
      type: 'string',
      description: 'Path to evals.jsonl file (default: .wavemill/evals/evals.jsonl)',
    },
    help: {
      type: 'boolean',
      short: 'h',
      description: 'Show help message',
    },
  },
  examples: [
    'npx tsx tools/deduplicate-evals.ts --dry-run',
    'npx tsx tools/deduplicate-evals.ts',
    'npx tsx tools/deduplicate-evals.ts --evals-file /path/to/evals.jsonl',
  ],
  async run({ args }) {
    const dryRun = args['dry-run'] || false;

    // Determine evals file path
    let evalsFile: string;
    if (args['evals-file']) {
      evalsFile = resolve(args['evals-file'] as string);
    } else {
      const repoDir = process.cwd();
      const evalConfig = getEvalConfig(repoDir);
      const evalsDir = evalConfig.evalsDir
        ? resolve(repoDir, evalConfig.evalsDir)
        : join(repoDir, '.wavemill', 'evals');
      evalsFile = join(evalsDir, 'evals.jsonl');
    }

    console.log(`Deduplicating eval records from ${evalsFile}`);
    console.log('');

    if (!existsSync(evalsFile)) {
      console.error(`Error: Eval file not found at ${evalsFile}`);
      process.exit(1);
    }

    // Read all records
    const records = readEvalRecords(evalsFile);
    console.log(`Found ${records.length} total eval records`);

    // Analyze duplicates
    console.log('Analyzing duplicates...');
    const result = deduplicateRecords(records);

    // Report findings
    if (result.duplicateGroups.size === 0) {
      console.log('');
      console.log('✓ No duplicates found - file is already deduplicated');
      process.exit(0);
    }

    console.log(formatDuplicateReport(result));
    console.log('');
    console.log(`Removed ${result.duplicatesRemoved} duplicate records`);
    console.log(`Kept ${result.uniqueRecords} unique records`);

    if (dryRun) {
      console.log('');
      console.log('Dry run mode - no changes made');
      console.log('Run without --dry-run to apply changes');
      process.exit(0);
    }

    // Create backup
    const backupPath = createBackup(evalsFile);
    console.log('');
    console.log(`Creating backup: ${backupPath}`);

    // Write deduplicated records
    const uniqueRecords = Array.from(result.duplicateGroups.values()).map((group) => group[0]);
    // Also include records that weren't duplicated
    const allKeys = new Set(result.duplicateGroups.keys());
    for (const record of records) {
      const key = `${record.issueId || 'no-issue'}|${record.prUrl || 'no-pr'}`;
      if (!allKeys.has(key)) {
        uniqueRecords.push(record);
      }
    }

    writeEvalRecords(evalsFile, uniqueRecords);
    console.log(`Wrote deduplicated records to ${evalsFile}`);
    console.log('');
    console.log('✓ Deduplication complete');
  },
});
