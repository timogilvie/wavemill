#!/usr/bin/env npx tsx
/**
 * Preflight guard: detects ad-hoc PR-to-task lookup patterns.
 * Follows check-task-identity.ts pattern (HOK-3271).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scanForPrTaskLookups } from '../shared/lib/pr-task-lookup-checker.ts';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');
const ALLOWLIST_FILE = join(REPO_ROOT, 'tools', 'pr-task-lookup-allowlist.txt');

const AUTO_EXCLUDED_PATHS = [
  'shared/lib/pr-task-resolver.ts',
  'shared/lib/pr-task-lookup-checker.ts',
  'tools/check-pr-task-lookup-sites.ts',
];

const TEST_FILE_PATTERN = /\.test\.(ts|tsx|js|jsx)$/;

function getTrackedFiles(repoDir: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
    { cwd: repoDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split('\0').filter(Boolean);
}

function readAllowlist(): Set<string> {
  const allowlist = new Set<string>();
  if (!existsSync(ALLOWLIST_FILE)) return allowlist;

  const content = readFileSync(ALLOWLIST_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      allowlist.add(trimmed);
    }
  }
  return allowlist;
}

function shouldExclude(filePath: string): boolean {
  // Auto-exclude the guard itself and the resolver
  for (const excluded of AUTO_EXCLUDED_PATHS) {
    if (filePath.endsWith(excluded)) return true;
  }

  // Auto-exclude test files
  if (TEST_FILE_PATTERN.test(filePath)) return true;

  // Only scan shared/lib and tools directories
  if (!filePath.startsWith('shared/lib/') && !filePath.startsWith('tools/')) {
    return true;
  }

  return false;
}

function main() {
  const allowlist = readAllowlist();

  // Get all tracked TypeScript files
  const files = getTrackedFiles(REPO_ROOT);

  const allFindings: Array<{
    file: string;
    findings: Array<{ line: number; column: number; pattern: string; excerpt: string }>;
  }> = [];

  for (const file of files) {
    if (shouldExclude(file)) continue;

    const fullPath = join(REPO_ROOT, file);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const findings = scanForPrTaskLookups(fullPath, content);

      if (findings.length > 0) {
        // Check each finding against allowlist and inline suppressions
        const relevantFindings = [];
        for (const finding of findings) {
          const lines = content.split('\n');
          const lineContent = lines[finding.line - 1] ?? '';
          const prevLineContent = lines[finding.line - 2] ?? '';

          // Check for inline suppression on same line or line above
          if (
            lineContent.includes('// allow-pr-task-lookup:') ||
            prevLineContent.includes('// allow-pr-task-lookup:')
          ) {
            continue;
          }

          // Check if file is allowlisted
          if (allowlist.has(file)) {
            continue;
          }

          relevantFindings.push(finding);
        }

        if (relevantFindings.length > 0) {
          allFindings.push({ file, findings: relevantFindings });
        }
      }
    } catch {
      // Skip files that cannot be read
    }
  }

  if (allFindings.length === 0) {
    process.exit(0);
  }

  console.error('pr-task-lookup: found ad-hoc PR-to-task lookup(s):');
  let count = 1;
  for (const { file, findings } of allFindings) {
    for (const finding of findings) {
      console.error(
        `${count}. ${file}:${finding.line}:${finding.column} [${finding.pattern}]`,
      );
      console.error(`   ${finding.excerpt}`);
      console.error('');
      count++;
    }
  }

  console.error(
    'Every PR / task / branch single-task lookup must go through shared/lib/pr-task-resolver.ts',
  );
  console.error('(resolvePrTask / resolveTaskLocation / resolveBranchTask) so misses emit one');
  console.error('structured log line. For a justified exception, add the path to');
  console.error('tools/pr-task-lookup-allowlist.txt with a reason, or suppress one line with:');
  console.error('  // allow-pr-task-lookup: <reason>');
  console.error('');

  process.exit(1);
}

main();
