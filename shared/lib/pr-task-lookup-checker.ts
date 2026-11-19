/**
 * Guard against ad-hoc PR-to-task iteration patterns (HOK-3271).
 *
 * Scans source files for inline `.tasks` iteration with resolver-shape
 * predicates (task.pr, task.branch, id === taskId) and reports findings
 * with file path, line number, and pattern name. {@link PR_TASK_LOOKUP_GUARD}
 * runs the scan on tools/lib/source-guard.ts, which supplies file listing,
 * suppression and the ratcheting allowlist.
 */

import { resolve } from 'node:path';
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export interface PrTaskLookupFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  excerpt: string;
}

interface ScannerState {
  braceDepth: number;
  inTasksLoop: boolean;
  loopStartLine: number;
  loopVarName: string | null;
  loopBraceDepth: number;
}

const PATTERNS = [
  {
    name: 'inline-task-pr-match',
    regex: /(task|t)\.pr\s*===|String\s*\(\s*task\.pr\s*\)\s*===\s*String/,
  },
  {
    name: 'inline-task-branch-match',
    regex: /(task|t)\.branch\s*===\s*/,
  },
  {
    name: 'inline-task-key-match',
    regex: /(?:taskId|id|key)\s*===\s*(?:opts?(?:ions)?\.)?taskId\b/,
  },
];

function getLoopVarFromHeader(header: string): string | null {
  // Matches: for (const [id, task] of ...), for (const [taskId, t] of ...)
  const match = header.match(/for\s*\(\s*(?:const|let|var)\s+\[([^,]+),\s*([^\]]+)\]/);
  if (match) {
    return match[2];
  }
  return null;
}

function isTasksLoopHeader(header: string): boolean {
  return /workflowTaskEntries\s*\(|Object\.\s*(?:values|entries|keys)\s*\([^)]*\.tasks\b/.test(
    header,
  );
}

export function scanForPrTaskLookups(
  filePath: string,
  content: string,
): PrTaskLookupFinding[] {
  const findings: PrTaskLookupFinding[] = [];
  const lines = content.split('\n');
  let state: ScannerState = {
    braceDepth: 0,
    inTasksLoop: false,
    loopStartLine: 0,
    loopVarName: null,
    loopBraceDepth: 0,
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // Track brace depth (do this first, before pattern matching)
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '{') state.braceDepth++;
      if (line[i] === '}') state.braceDepth--;
    }

    // Detect entry into a .tasks loop (after counting braces on this line)
    if (!state.inTasksLoop && isTasksLoopHeader(line)) {
      state.inTasksLoop = true;
      state.loopStartLine = lineNum;
      state.loopVarName = getLoopVarFromHeader(line);
      state.loopBraceDepth = state.braceDepth;
    }

    // Check for predicate patterns while inside a .tasks loop
    if (state.inTasksLoop) {
      for (const pattern of PATTERNS) {
        const match = line.match(pattern.regex);
        if (match) {
          const column = (match.index ?? 0) + 1;
          findings.push({
            file: resolve(filePath),
            line: lineNum,
            column,
            pattern: pattern.name,
            excerpt: line.trim(),
          });
        }
      }
    }

    // Exit the loop scope when brace depth returns to the level before the loop
    if (state.inTasksLoop && state.braceDepth < state.loopBraceDepth) {
      state.inTasksLoop = false;
      state.loopVarName = null;
    }
  }

  return findings;
}

export const PR_TASK_LOOKUP_GUARD: GuardSpec = {
  name: 'pr-task-lookup',
  findingNoun: 'ad-hoc PR-to-task lookup(s)',
  suppressionMarker: 'allow-pr-task-lookup',
  allowlistFile: 'tools/pr-task-lookup-allowlist.txt',
  // The resolver and this scanner necessarily contain the forbidden shapes.
  invariantPaths: ['shared/lib/pr-task-resolver.ts', 'shared/lib/pr-task-lookup-checker.ts'],
  patterns: [],
  structuralChecks: [{
    name: 'inline-task-lookup',
    description: 'single-task lookup inside a `.tasks` loop',
    scopedPaths: ['shared/lib/', 'tools/'],
    find: (sourceText, file) => scanForPrTaskLookups(file, sourceText)
      .map(({ line, column, pattern }) => ({ line, column, detail: pattern })),
  }],
  remediation: [
    'Every PR / task / branch single-task lookup must go through shared/lib/pr-task-resolver.ts',
    '(resolvePrTask / resolveTaskLocation / resolveBranchTask) so misses emit one',
    'structured log line.',
  ],
  tsExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  shellExtensions: [],
};
