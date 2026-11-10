#!/usr/bin/env -S npx tsx
/**
 * Preflight guard (HOK-3456): ensure no second required-files list exists.
 *
 * `shared/lib/review-scope-guard.ts` exports the single `REQUIRED_PATHS`
 * list. Files our own rules demand (test registrations, journeys/fakes,
 * incident replay fixtures, journey-matrix additions in ci.yml) must be
 * admitted from that one source. Any other file that restates two or more
 * of those paths in a 20-line window is a duplicate list.
 *
 * Usage: npx tsx tools/check-required-files-list.ts [repoRoot]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_PATHS } from '../shared/lib/review-scope-guard.ts';
import {
  listTrackedSourceFiles,
  runGuardCli,
  type GuardSpec,
  type StructuralMatch,
} from './lib/source-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

const REQUIRED_PATH_LITERALS = REQUIRED_PATHS.filter((p) => !p.endsWith('/'));
const WINDOW_LINES = 20;

/** Quote characters that can surround a required-path string literal. */
const QUOTES = ['\'', '"', '`'] as const;

function lineContainsRequiredPath(line: string, path: string): boolean {
  for (const quote of QUOTES) {
    if (line.includes(`${quote}${path}${quote}`)) {
      return true;
    }
  }
  return false;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return false;
  return trimmed.startsWith('#')
    || trimmed.startsWith('//')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*');
}

function findDuplicateRequiredPathLists(sourceText: string): StructuralMatch[] {
  const lines = sourceText.split(/\r?\n/);
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const path of REQUIRED_PATH_LITERALS) {
      if (lineContainsRequiredPath(line, path)) {
        matchLines.push(i);
        break;
      }
    }
  }

  const findings: StructuralMatch[] = [];
  for (let idx = 0; idx < matchLines.length; idx += 1) {
    const line = matchLines[idx];
    const windowStart = Math.max(0, line - WINDOW_LINES + 1);
    const windowEnd = Math.min(lines.length - 1, line + WINDOW_LINES - 1);
    let hasNeighbor = false;
    for (let otherIdx = 0; otherIdx < matchLines.length; otherIdx += 1) {
      if (otherIdx === idx) continue;
      const otherLine = matchLines[otherIdx];
      if (otherLine >= windowStart && otherLine <= windowEnd) {
        hasNeighbor = true;
        break;
      }
    }
    if (hasNeighbor) {
      findings.push({ line: line + 1 });
    }
  }
  return findings;
}

function buildSpec(repoDir: string): GuardSpec {
  const trackedFiles = listTrackedSourceFiles(repoDir, [
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.bash',
  ]);
  return {
    name: 'required-files-list',
    findingNoun: 'duplicate required-files list(s)',
    suppressionMarker: 'allow-required-files-list',
    allowlistFile: 'tools/required-files-list-allowlist.txt',
    invariantPaths: [
      'shared/lib/review-scope-guard.ts',
      'tools/check-required-files-list.ts', // install-paths: allow source-guard invariant path, not an executable argv
    ],
    structuralChecks: [{
      name: 'required-files-list-duplicate',
      description:
        'this file restates two or more entries from REQUIRED_PATHS within a 20-line window; ' +
        'route required-path references through shared/lib/review-scope-guard.ts',
      paths: trackedFiles,
      find(sourceText) {
        return findDuplicateRequiredPathLists(sourceText);
      },
    }],
    patterns: [],
    remediation: [
      'REQUIRED_PATHS in shared/lib/review-scope-guard.ts is the single source',
      'of truth for files our rules demand during review. If you need to refer',
      'to those paths, import the list or mention one isolated path; do not',
      'create a second enumerated list.',
    ],
  };
}

if (process.argv[1] === __filename) {
  const repoDir = process.argv[2] ?? defaultRepoRoot;
  runGuardCli(buildSpec(repoDir), repoDir);
}
