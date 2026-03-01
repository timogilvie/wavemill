#!/usr/bin/env -S npx tsx
/**
 * Context Check - Drift detection for subsystem documentation
 *
 * Compares subsystem specs against current codebase to detect:
 * - Stale specs (files modified since last spec update)
 * - Orphaned specs (referenced files no longer exist)
 * - Undocumented subsystems (new subsystems detected but no spec)
 *
 * Usage:
 *   npx tsx tools/context-check.ts [repo-path] [options]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

// ────────────────────────────────────────────────────────────────
// CLI Argument Parsing
// ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isJson = args.includes('--json');
const isHelp = args.includes('--help') || args.includes('-h');

const repoPath = args.find((arg) => !arg.startsWith('-')) || process.cwd();
const repoDir = resolve(repoPath);

if (isHelp) {
  console.log(`
Context Check - Drift detection for subsystem documentation

Reports the freshness status of all subsystem specs.

Usage:
  npx tsx tools/context-check.ts [repo-path] [options]

Arguments:
  [repo-path]    Path to repository (default: current directory)

Options:
  --json         Output JSON format
  --help, -h     Show this help message

Statuses:
  ✅ Fresh         No changes since last update
  ⚠️  Stale         Files modified since last update (>7 days)
  ❌ Orphaned      Referenced files no longer exist
  🆕 Undocumented  New subsystem detected, no spec yet

Examples:
  # Check all subsystems
  npx tsx tools/context-check.ts

  # Output JSON for CI integration
  npx tsx tools/context-check.ts --json
  `);
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface SubsystemStatus {
  id: string;
  name: string;
  status: 'fresh' | 'stale' | 'orphaned' | 'undocumented';
  lastUpdated?: string;
  daysSinceUpdate?: number;
  filesChanged?: number;
  missingFiles?: string[];
  totalFiles?: number;
}

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Extract metadata from a subsystem spec.
 */
function extractSpecMetadata(specContent: string): {
  lastUpdated: string;
  keyFiles: string[];
  name: string;
} {
  const lines = specContent.split('\n');

  let lastUpdated = '';
  let name = '';
  const keyFiles: string[] = [];

  // Extract last updated timestamp
  for (const line of lines) {
    if (line.startsWith('**Last updated:**')) {
      lastUpdated = line.replace('**Last updated:**', '').trim();
    }
    if (line.startsWith('# Subsystem:')) {
      name = line.replace('# Subsystem:', '').trim();
    }
  }

  // Extract key files
  let inKeyFilesSection = false;
  for (const line of lines) {
    if (line.startsWith('## Key Files')) {
      inKeyFilesSection = true;
      continue;
    }
    if (inKeyFilesSection && line.startsWith('##')) {
      break;
    }
    if (inKeyFilesSection && line.startsWith('| `')) {
      const match = line.match(/\| `([^`]+)` \|/);
      if (match) keyFiles.push(match[1]);
    }
  }

  return { lastUpdated, keyFiles, name };
}

/**
 * Check if files have been modified since a timestamp.
 */
function getModifiedFilesSince(files: string[], sinceDate: Date, repoDir: string): string[] {
  const modifiedFiles: string[] = [];

  for (const file of files) {
    try {
      const fullPath = join(repoDir, file);
      if (!existsSync(fullPath)) continue;

      // Check git log for this file since the date
      const cmd = `git log --oneline --since="${sinceDate.toISOString()}" -- "${file}" | wc -l`;
      const commitCount = parseInt(execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim(), 10);

      if (commitCount > 0) {
        modifiedFiles.push(file);
      }
    } catch {
      // Skip files we can't check
    }
  }

  return modifiedFiles;
}

/**
 * Check which files no longer exist.
 */
function getMissingFiles(files: string[], repoDir: string): string[] {
  return files.filter(file => !existsSync(join(repoDir, file)));
}

/**
 * Calculate days between two dates.
 */
function daysBetween(date1: Date, date2: Date): number {
  const diffMs = date2.getTime() - date1.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Analyze a single subsystem spec.
 */
function analyzeSpec(specPath: string, repoDir: string): SubsystemStatus {
  const specContent = readFileSync(specPath, 'utf-8');
  const { lastUpdated, keyFiles, name } = extractSpecMetadata(specContent);
  const id = specPath.split('/').pop()?.replace('.md', '') || 'unknown';

  if (!lastUpdated) {
    return {
      id,
      name: name || id,
      status: 'stale',
      lastUpdated: 'unknown',
      daysSinceUpdate: 999,
      totalFiles: keyFiles.length,
    };
  }

  const updateDate = new Date(lastUpdated);
  const now = new Date();
  const daysSinceUpdate = daysBetween(updateDate, now);

  // Check for missing files
  const missingFiles = getMissingFiles(keyFiles, repoDir);
  if (missingFiles.length > 0) {
    return {
      id,
      name: name || id,
      status: 'orphaned',
      lastUpdated,
      daysSinceUpdate,
      missingFiles,
      totalFiles: keyFiles.length,
    };
  }

  // Check for modified files
  const modifiedFiles = getModifiedFilesSince(keyFiles, updateDate, repoDir);

  // Stale if >7 days old AND files have changed
  if (daysSinceUpdate > 7 && modifiedFiles.length > 0) {
    return {
      id,
      name: name || id,
      status: 'stale',
      lastUpdated,
      daysSinceUpdate,
      filesChanged: modifiedFiles.length,
      totalFiles: keyFiles.length,
    };
  }

  // Fresh
  return {
    id,
    name: name || id,
    status: 'fresh',
    lastUpdated,
    daysSinceUpdate,
    totalFiles: keyFiles.length,
  };
}

/**
 * Detect undocumented subsystems.
 */
function detectUndocumented(existingSpecs: SubsystemStatus[], repoDir: string): SubsystemStatus[] {
  try {
    const detectedSubsystems = detectSubsystems(repoDir, {
      minFiles: 3,
      useGitAnalysis: false, // Skip git analysis for speed
      maxSubsystems: 20,
    });

    const existingIds = new Set(existingSpecs.map(s => s.id));
    const undocumented: SubsystemStatus[] = [];

    for (const subsystem of detectedSubsystems) {
      if (!existingIds.has(subsystem.id)) {
        undocumented.push({
          id: subsystem.id,
          name: subsystem.name,
          status: 'undocumented',
          totalFiles: subsystem.keyFiles.length,
        });
      }
    }

    return undocumented;
  } catch {
    // Detection failed, return empty
    return [];
  }
}

/**
 * Format status for display.
 */
function formatStatus(status: string): string {
  switch (status) {
    case 'fresh': return '✅ Fresh';
    case 'stale': return '⚠️  Stale';
    case 'orphaned': return '❌ Orphaned';
    case 'undocumented': return '🆕 Undocumented';
    default: return '❓ Unknown';
  }
}

/**
 * Display results as table.
 */
function displayTable(results: SubsystemStatus[]): void {
  console.log('');
  console.log('Subsystem Documentation Status');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Group by status
  const fresh = results.filter(r => r.status === 'fresh');
  const stale = results.filter(r => r.status === 'stale');
  const orphaned = results.filter(r => r.status === 'orphaned');
  const undocumented = results.filter(r => r.status === 'undocumented');

  // Summary
  console.log(`Total: ${results.length} subsystems`);
  console.log(`  ${fresh.length} fresh, ${stale.length} stale, ${orphaned.length} orphaned, ${undocumented.length} undocumented`);
  console.log('');

  // Show stale specs first (most important)
  if (stale.length > 0) {
    console.log('⚠️  STALE SPECS (files changed since last update):');
    console.log('');
    stale.forEach(s => {
      console.log(`  ${s.name} (${s.id})`);
      console.log(`    Last updated: ${s.lastUpdated} (${s.daysSinceUpdate} days ago)`);
      console.log(`    Files changed: ${s.filesChanged}/${s.totalFiles}`);
      console.log(`    → Run: wavemill context update ${s.id}`);
      console.log('');
    });
  }

  // Show orphaned specs
  if (orphaned.length > 0) {
    console.log('❌ ORPHANED SPECS (referenced files no longer exist):');
    console.log('');
    orphaned.forEach(s => {
      console.log(`  ${s.name} (${s.id})`);
      console.log(`    Missing files: ${s.missingFiles?.join(', ')}`);
      console.log(`    → Consider regenerating: wavemill context init --force`);
      console.log('');
    });
  }

  // Show undocumented subsystems
  if (undocumented.length > 0) {
    console.log('🆕 UNDOCUMENTED SUBSYSTEMS (detected but no spec):');
    console.log('');
    undocumented.forEach(s => {
      console.log(`  ${s.name} (${s.id})`);
      console.log(`    Files: ${s.totalFiles}`);
      console.log(`    → Run: wavemill context init`);
      console.log('');
    });
  }

  // Show fresh specs (less important)
  if (fresh.length > 0) {
    console.log('✅ FRESH SPECS:');
    console.log('');
    fresh.forEach(s => {
      console.log(`  ${s.name} (${s.id}) - updated ${s.daysSinceUpdate} days ago`);
    });
    console.log('');
  }
}

/**
 * Display results as JSON.
 */
function displayJson(results: SubsystemStatus[]): void {
  console.log(JSON.stringify(results, null, 2));
}

// ────────────────────────────────────────────────────────────────
// Main Logic
// ────────────────────────────────────────────────────────────────

async function main() {
  const contextDir = join(repoDir, '.wavemill', 'context');

  // Check if context directory exists
  if (!existsSync(contextDir)) {
    console.error('Error: No subsystem specs found');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  // Find all spec files
  const specFiles = readdirSync(contextDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(contextDir, f));

  if (specFiles.length === 0) {
    console.error('Error: No subsystem specs found in .wavemill/context/');
    console.error('Initialize first: wavemill context init');
    process.exit(1);
  }

  // Analyze each spec
  const results: SubsystemStatus[] = specFiles.map(specPath => analyzeSpec(specPath, repoDir));

  // Detect undocumented subsystems
  const undocumented = detectUndocumented(results, repoDir);
  results.push(...undocumented);

  // Sort by status priority (stale > orphaned > undocumented > fresh)
  const statusPriority = { stale: 0, orphaned: 1, undocumented: 2, fresh: 3 };
  results.sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);

  // Display results
  if (isJson) {
    displayJson(results);
  } else {
    displayTable(results);
  }

  // Exit code: 0 if all fresh, 1 if any issues
  const hasIssues = results.some(r => r.status !== 'fresh');
  process.exit(hasIssues ? 1 : 0);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
