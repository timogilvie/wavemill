#!/usr/bin/env -S npx tsx
/**
 * Preflight guard for arm-termination invariant (HOK-3358 D7).
 * Ensures all arm termination goes through the single recorder with proper types.
 *
 * Usage: npx tsx tools/check-arm-termination.ts [repo-dir]
 * CI: Wired into test:preflight
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const INVARIANT_SOURCE = 'shared/lib/arm-termination.ts';
const ALLOWLIST_PATH = 'tools/arm-termination-allowlist.txt';
const MARKER = 'allow-arm-termination';

interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

function runCheck(repoDir: string): Finding[] {
  const findings: Finding[] = [];

  // Pattern 1: Direct challengeAborted writes
  try {
    const result = execSync(
      `git grep -n '\\.challengeAborted\\s*=(?!=)' -- '*.ts' '*.tsx' ':!${INVARIANT_SOURCE}'`,
      { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = result.trim().split('\n').filter(l => l);
    lines.forEach(line => {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        findings.push({
          file: match[1],
          line: parseInt(match[2], 10),
          pattern: 'challenge-aborted-write',
          match: line.split(':')[2] || '',
        });
      }
    });
  } catch {
    // No matches
  }

  // Pattern 2: faultClass literals outside taxonomy
  try {
    const result = execSync(
      `git grep -n "faultClass\\s*:\\s*'\\(harness\\|selection\\|provider\\|model\\|unknown\\)-fault'" -- '*.ts' '*.tsx' ':!shared/lib/arm-failure-taxonomy.ts'`,
      { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = result.trim().split('\n').filter(l => l);
    lines.forEach(line => {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        findings.push({
          file: match[1],
          line: parseInt(match[2], 10),
          pattern: 'fault-class-literal',
          match: line.split(':')[2] || '',
        });
      }
    });
  } catch {
    // No matches
  }

  // Pattern 3: OPERATOR_ABORT_MARKER or operator_abort
  try {
    const result = execSync(
      `git grep -n "OPERATOR_ABORT_MARKER\\|'operator_abort'\\|\\\"operator_abort\\\"" -- '*.ts' '*.tsx' '*.sh'`,
      { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = result.trim().split('\n').filter(l => l);
    lines.forEach(line => {
      // Skip the invariant source and task-abort.ts (which defines it)
      if (line.includes(INVARIANT_SOURCE) || line.includes('shared/lib/task-abort.ts')) {
        return;
      }
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        findings.push({
          file: match[1],
          line: parseInt(match[2], 10),
          pattern: 'operator-abort-marker',
          match: line.split(':')[2] || '',
        });
      }
    });
  } catch {
    // No matches
  }

  return findings;
}

function loadAllowlist(repoDir: string): Map<string, number> {
  const allowlistPath = join(repoDir, ALLOWLIST_PATH);
  if (!existsSync(allowlistPath)) {
    return new Map();
  }

  const allowlist = new Map<string, number>();
  const content = readFileSync(allowlistPath, 'utf-8');
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([^\s]+)\s+(\d+)/);
    if (match) {
      allowlist.set(match[1], parseInt(match[2], 10));
    }
  });

  return allowlist;
}

async function main() {
  const repoDir = process.argv[2] ? resolve(process.argv[2]) : resolve('.');
  const findings = runCheck(repoDir);
  const allowlist = loadAllowlist(repoDir);

  if (findings.length === 0) {
    console.log('✓ arm-termination invariant: no direct writes or bad literals found');
    process.exit(0);
  }

  console.error(`✗ arm-termination invariant violations (${findings.length} found):`);
  const allowed = new Map<string, number>();
  let hasViolations = false;

  findings.forEach(f => {
    const key = `${f.file}:${f.pattern}`;
    const count = (allowed.get(key) ?? 0) + 1;
    allowed.set(key, count);

    const allowedCount = allowlist.get(f.file) ?? 0;
    if (count > allowedCount) {
      hasViolations = true;
      console.error(`  ${f.file}:${f.line}: ${f.pattern}`);
      console.error(`    ${f.match.substring(0, 120)}`);
    }
  });

  if (hasViolations) {
    console.error('\nFix by:');
    console.error('  1. Route through recordArmTermination() or stampTermination()');
    console.error('  2. Derive faultClass from classifyArmFault(), do not store');
    console.error('  3. Use formatTerminationReason(kind) instead of literals');
    console.error(`  4. Or suppress with "# ${MARKER}: <reason>" on the line above`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Guard check failed:', err.message);
  process.exit(1);
});
