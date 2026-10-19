/**
 * Writer-surface extraction for `workflow-state.json` task records (HOK-3220).
 *
 * The task-record schema (`shared/schemas/workflow-task.schema.json`) is
 * derived from the code that *writes* `.tasks[$id].*`, never from the code
 * that reads it. This module is the mechanical half of that rule: it scans
 * the writer surface and returns every top-level task field it can prove is
 * assigned. `workflow-state.writer-coverage.test.ts` asserts that every
 * property the schema declares appears in this set, so a field that only a
 * reader ever guessed (HOK-3181's `prNumber` / `headSha`) cannot be added to
 * the schema to make a reader compile.
 *
 * The extraction is a deliberate over-approximation of "this name is written
 * at the top level of a task record somewhere". It recognises:
 *
 * - jq path writes: `.tasks[$x].field = …` / `|= …` / `+= …`
 * - jq object merges: `.tasks[$x] = ((.tasks[$x] // {}) + { field: … })`,
 *   `.tasks[$x] = ($existing + { … })`, `.tasks[$x] |= . + { … }`
 *   (depth-1 keys only, so nested evidence objects such as
 *   `lifecycle.deliveryEvidence.prHeadSha` do not leak to the top level)
 * - jq bulk rewrites: `.tasks |= with_entries(… .value.field = … )`
 * - `task_state_mutate_existing <issue> '<filter>'` filters, where `.` is the
 *   task object: `.field = …` and `. + { field: … }`
 * - TypeScript `mutateJsonState` writers that assign through a task-shaped
 *   local (`task.field = …`, `entry.field = …`, `taskObj.field = …`)
 *
 * It ignores `.terminalTaskHistory.tasks[…]`: tombstone history is a separate
 * record shape owned by the terminal reconciler.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative TypeScript files that write task records via `mutateJsonState`. */
export const TS_TASK_WRITER_FILES: readonly string[] = [
  'shared/lib/task-abort.ts',
  'shared/lib/terminal-inbox-cleanup.ts',
  'shared/lib/challenge-pair-resolver.ts',
  'shared/lib/challenge-recovery.ts',
  'tools/void-challenge-record.ts',
  'tools/reap-stale-challengers.ts',
];

/** Locals that TypeScript writers use to hold a single task record. */
const TS_TASK_LOCAL = /\b(?:task|entry|taskObj)\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?![=>])/g;

const JQ_PATH_WRITE = /(?<!terminalTaskHistory)\.tasks\[[^\]]+\]\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|=|\+=|=)(?!=)/g;

/**
 * `.tasks[$x] = (<base> + {` / `.tasks[$x] |= (. + {` where <base> is the
 * existing task (`(.tasks[$x] // {})`, `.tasks[$x]`, a `$var`, or `.`).
 */
const JQ_OBJECT_MERGE = /(?<!terminalTaskHistory)\.tasks\[[^\]]+\]\s*(?:\|=|=)\s*\(*\s*(?:\(?\s*\.tasks\[[^\]]+\]\s*(?:\/\/\s*\{\}\s*)?\)?|\$[A-Za-z_]+|\.)\s*\+\s*\{/g;

const JQ_WITH_ENTRIES = /(?<!terminalTaskHistory)\.tasks\s*\|=\s*with_entries\(/g;
const ENTRY_VALUE_WRITE = /\.value\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|=|\+=|=)(?!=)/g;

const FILTER_PATH_WRITE = /(?<![\w\])$])\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|=|\+=|=)(?!=)/g;
const FILTER_OBJECT_MERGE = /(?<![\w\])$])\.\s*\+\s*\{/g;

/**
 * Collect depth-1 object keys from the object literal whose `{` sits at
 * `openIndex`. Brackets inside jq string literals are skipped.
 */
export function objectLiteralKeys(source: string, openIndex: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      if (depth === 1) {
        const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(source.slice(i + 1));
        if (key) keys.push(key[1]);
      }
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (ch === ',' && depth === 1) {
      const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(source.slice(i + 1));
      if (key) keys.push(key[1]);
    }
  }
  return keys;
}

/** Return the balanced `( … )` region whose `(` sits at `openIndex`. */
function balancedParenRegion(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

/** Return the quoted shell word starting at `start` (single or double quotes). */
function quotedWordAt(source: string, start: number): string | null {
  const quote = source[start];
  if (quote !== '\'' && quote !== '"') return null;
  for (let i = start + 1; i < source.length; i += 1) {
    if (quote === '"' && source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === quote) return source.slice(start + 1, i);
  }
  return null;
}

function addMatches(target: Set<string>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) target.add(match[1]);
}

function addObjectMerges(target: Set<string>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    for (const key of objectLiteralKeys(source, open)) target.add(key);
  }
}

/** Top-level task fields written by one shell source file. */
export function extractShellTaskWriterFields(rawSource: string): Set<string> {
  const fields = new Set<string>();
  // Whole-line shell / jq comments describe writes; they are not writes.
  const source = rawSource
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
  addMatches(fields, source, JQ_PATH_WRITE);
  addObjectMerges(fields, source, JQ_OBJECT_MERGE);
  for (const match of source.matchAll(JQ_WITH_ENTRIES)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    addMatches(fields, balancedParenRegion(source, open), ENTRY_VALUE_WRITE);
  }

  const helperCall = /task_state_mutate_existing(?:\s|\\\n)+(?:"[^"]*"|\S+)(?:\s|\\\n)+/g;
  for (const match of source.matchAll(helperCall)) {
    const filter = quotedWordAt(source, (match.index ?? 0) + match[0].length);
    if (!filter) continue;
    addMatches(fields, filter, FILTER_PATH_WRITE);
    addObjectMerges(fields, filter, FILTER_OBJECT_MERGE);
  }
  return fields;
}

/** Top-level task fields written by one TypeScript writer file. */
export function extractTsTaskWriterFields(source: string): Set<string> {
  const fields = new Set<string>();
  addMatches(fields, source, TS_TASK_LOCAL);
  return fields;
}

export interface WriterFieldIndex {
  /** field name → repo-relative files that write it */
  fields: Map<string, string[]>;
}

/**
 * Scan the whole writer surface under `repoRoot`: every `shared/lib/*.sh`
 * plus {@link TS_TASK_WRITER_FILES}.
 */
export function collectTaskWriterFields(repoRoot: string): WriterFieldIndex {
  const fields = new Map<string, string[]>();
  const record = (file: string, found: Set<string>) => {
    for (const field of found) {
      const files = fields.get(field) ?? [];
      files.push(file);
      fields.set(field, files);
    }
  };
  const shellFiles = readdirSync(join(repoRoot, 'shared/lib'))
    .filter((name) => name.endsWith('.sh'))
    .sort()
    .map((name) => `shared/lib/${name}`);
  for (const file of shellFiles) {
    record(file, extractShellTaskWriterFields(readFileSync(join(repoRoot, file), 'utf8')));
  }
  for (const file of TS_TASK_WRITER_FILES) {
    record(file, extractTsTaskWriterFields(readFileSync(join(repoRoot, file), 'utf8')));
  }
  return { fields };
}
