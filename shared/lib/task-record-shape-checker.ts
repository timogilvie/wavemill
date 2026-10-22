// allow-task-record-shape: this file *is* the task-record-shape guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard (HOK-3220): `workflow-state.json` task records have exactly
 * one TypeScript shape, `TaskRecord` / `WorkflowState` in
 * `shared/lib/workflow-state.ts`. Any other file that declares its own
 * `tasks?: Record<...>`, casts `.tasks as Record<...>`, or names a private
 * `WorkflowState` / `TaskState` / `TaskRecord` type is reintroducing the
 * guessed-field-name class of bug that HOK-3181 shipped (fixed in HOK-3212).
 *
 * Test files are not scanned: fixtures deliberately build partial and
 * malformed state. Justified exceptions (a different file that happens to have
 * a `tasks` map, the ledger render view) go in
 * `tools/task-record-shape-allowlist.txt` with a reason, or on one line with
 * `// allow-task-record-shape: <reason>`. Built on tools/lib/source-guard.ts.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGuardSource,
  formatGuardResult,
  parseGuardAllowlist,
  runSourceGuard,
  type GuardFinding,
  type GuardPattern,
  type GuardResult,
  type GuardSpec,
} from '../../tools/lib/source-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

export const TASK_RECORD_SHAPE_ALLOWLIST_FILE = 'tools/task-record-shape-allowlist.txt';

const PATTERNS: GuardPattern[] = [
  {
    name: 'tasks-record-annotation',
    lang: 'ts',
    description: '`tasks?: Record<...>` — private task-map shape; use WorkflowState / TaskRecord',
    // `Record<string, TaskRecord>` is the canonical map and is allowed.
    re: /\btasks\s*\??\s*:\s*Record\s*<(?!\s*string\s*,\s*TaskRecord\s*>)/,
  },
  {
    name: 'tasks-record-cast',
    lang: 'ts',
    description: '`.tasks as Record<...>` — casting the task map to a guessed shape; use workflowTaskEntries() / TaskRecord',
    re: /\.tasks\s+as\s+Record\s*</,
  },
  {
    name: 'workflow-state-type',
    lang: 'ts',
    description: 'private `WorkflowState` type — import WorkflowState from workflow-state.ts',
    re: /\b(?:interface|type)\s+WorkflowState(?:File|Task|Like)?\s*(?:=|\{|<|extends\b)/,
  },
  {
    name: 'task-record-type',
    lang: 'ts',
    description: 'private task-record type — import TaskRecord from workflow-state.ts (or Pick<TaskRecord, ...>)',
    re: /\b(?:interface\s+TaskState|(?:interface|type)\s+TaskRecord)\s*(?:=|\{|<|extends\b)/,
  },
];

export type TaskRecordShapeFinding = GuardFinding;
export type TaskRecordShapeResult = GuardResult;

export const TASK_RECORD_SHAPE_GUARD: GuardSpec = {
  name: 'task-record-shape',
  findingNoun: 'private workflow-state task shape(s)',
  suppressionMarker: 'allow-task-record-shape',
  allowlistFile: TASK_RECORD_SHAPE_ALLOWLIST_FILE,
  /** The canonical module and this guard necessarily contain the shapes. */
  invariantPaths: [
    'shared/lib/workflow-state.ts',
    'shared/lib/task-record-shape-checker.ts',
  ],
  patterns: PATTERNS,
  remediation: [
    'workflow-state.json task records have one shape: TaskRecord / WorkflowState in',
    'shared/lib/workflow-state.ts, derived from the writers (HOK-3220). Import it, or',
    'narrow it with Pick<TaskRecord, ...>. A field the type lacks has no writer — the',
    'reader is wrong, not the type.',
  ],
  tsExtensions: ['.ts', '.tsx', '.mts', '.cts'],
  shellExtensions: [],
  ratchet: false,
};

/**
 * Scan one file. A finding is suppressed when `allow-task-record-shape:`
 * appears on the same line or the line above; whole-line comments never fire.
 */
export function checkTaskRecordShapeSource(fileName: string, sourceText: string): TaskRecordShapeFinding[] {
  return checkGuardSource(TASK_RECORD_SHAPE_GUARD, fileName, sourceText);
}

export interface AllowlistEntry {
  path: string;
  reason: string;
}

/**
 * Parse the allowlist: `<repo-relative path>  # <reason>`, one per line.
 * Entries without a reason are returned in `missingReason` so the guard fails
 * on them instead of silently honouring an unexplained exception.
 */
export function parseTaskRecordShapeAllowlist(contents: string): { entries: AllowlistEntry[]; missingReason: string[] } {
  const parsed = parseGuardAllowlist(contents);
  return {
    entries: parsed.entries.map(({ path, reason }) => ({ path, reason })),
    missingReason: parsed.missingReason.map((entry) => entry.path),
  };
}

export function checkTaskRecordShapes(repoDir = defaultRepoRoot): TaskRecordShapeResult {
  return runSourceGuard(TASK_RECORD_SHAPE_GUARD, repoDir);
}

export function formatTaskRecordShapes(result: TaskRecordShapeResult): string {
  return formatGuardResult(TASK_RECORD_SHAPE_GUARD, result);
}
