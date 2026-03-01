#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

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

function getFileModTime(filePath: string): Date | null {
  try {
    return statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function getLastCommitDate(filePath: string, repoDir: string): Date | null {
  try {
    const timestamp = execSync(
      `git log -1 --format=%ct -- "${filePath}"`,
      { cwd: repoDir, encoding: 'utf-8' }
    ).trim();
    return timestamp ? new Date(parseInt(timestamp) * 1000) : null;
  } catch {
    return null;
  }
}

function checkSubsystemStatus(
  subsystemId: string,
  contextDir: string,
  repoDir: string
): SubsystemStatus {
  const specPath = join(contextDir, `${subsystemId}.md`);

  if (!existsSync(specPath)) {
    return {
      id: subsystemId,
      name: subsystemId,
      status: 'undocumented',
    };
  }

  const specContent = readFileSync(specPath, 'utf-8');
  const lastUpdatedMatch = specContent.match(/\*\*Last updated:\*\*\s*(.+)/);
  const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : null;

  const fileListMatch = specContent.match(/##\s*Key Files[\s\S]*?\n\n/);
  const files: string[] = [];
  if (fileListMatch) {
    const lines = fileListMatch[0].split('\n');
    for (const line of lines) {
      const match = line.match(/\|\s*([^\|]+?)\s*\|/);
      if (match && !line.includes('File') && !line.includes('---')) {
        files.push(match[1].trim());
      }
    }
  }

  const missingFiles = files.filter(f => !existsSync(join(repoDir, f)));

  if (missingFiles.length > 0) {
    return {
      id: subsystemId,
      name: subsystemId,
      status: 'orphaned',
      lastUpdated: lastUpdated || undefined,
      missingFiles,
      totalFiles: files.length,
    };
  }

  const specModTime = getFileModTime(specPath);
  if (!specModTime) {
    return {
      id: subsystemId,
      name: subsystemId,
      status: 'fresh',
      lastUpdated: lastUpdated || undefined,
    };
  }

  let filesChanged = 0;
  for (const file of files) {
    const fileModTime = getLastCommitDate(file, repoDir);
    if (fileModTime && fileModTime > specModTime) {
      filesChanged++;
    }
  }

  const daysSinceUpdate = lastUpdated
    ? Math.floor((Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const status = filesChanged > 0 && daysSinceUpdate > 7 ? 'stale' : 'fresh';

  return {
    id: subsystemId,
    name: subsystemId,
    status,
    lastUpdated: lastUpdated || undefined,
    daysSinceUpdate,
    filesChanged,
    totalFiles: files.length,
  };
}

runTool({
  name: 'context-check',
  description: 'Drift detection for subsystem documentation',
  options: {
    json: { type: 'boolean', description: 'Output JSON format' },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
  },
  positional: {
    name: 'repoPath',
    description: 'Repository path (default: current directory)',
  },
  examples: [
    'npx tsx tools/context-check.ts',
    'npx tsx tools/context-check.ts --json',
  ],
  additionalHelp: `Statuses:
  ✅ Fresh         No changes since last update
  ⚠️  Stale         Files modified since last update (>7 days)
  ❌ Orphaned      Referenced files no longer exist
  🆕 Undocumented  New subsystem detected, no spec yet`,
  run({ args, positional }) {
    const repoDir = resolve(positional[0] || process.cwd());
    const contextDir = join(repoDir, '.wavemill', 'context');

    if (!existsSync(contextDir)) {
      console.error('No context directory found. Run context-init first.');
      process.exit(1);
    }

    const specFiles = readdirSync(contextDir).filter(f => f.endsWith('.md'));
    const statuses: SubsystemStatus[] = [];

    for (const specFile of specFiles) {
      const subsystemId = specFile.replace('.md', '');
      const status = checkSubsystemStatus(subsystemId, contextDir, repoDir);
      statuses.push(status);
    }

    if (args.json) {
      console.log(JSON.stringify(statuses, null, 2));
    } else {
      console.log('\n📊 Subsystem Status Report\n');
      for (const status of statuses) {
        const icon = status.status === 'fresh' ? '✅' :
                     status.status === 'stale' ? '⚠️' :
                     status.status === 'orphaned' ? '❌' : '🆕';
        console.log(`${icon} ${status.name} - ${status.status}`);
        if (status.filesChanged) {
          console.log(`   ${status.filesChanged}/${status.totalFiles} files changed`);
        }
        if (status.missingFiles && status.missingFiles.length > 0) {
          console.log(`   Missing: ${status.missingFiles.join(', ')}`);
        }
      }
    }
  },
});
