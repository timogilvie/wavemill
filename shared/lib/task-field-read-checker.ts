// allow-task-field: this file *is* the task-field-read guard; its pattern
// strings and docs name forbidden field reads. It is auto-excluded from its
// own scan.
/**
 * Preflight guard (HOK-3224): a task-record field read in shell or untyped
 * TypeScript must name a property declared in
 * `shared/schemas/workflow-task.schema.json`'s `$defs.TaskRecord`. HOK-3212
 * shipped because nothing compared the names code reads against the names any
 * writer sets; this guard is the structural partner to the A1 schema and the
 * writer-coverage test. Typed TS reads are already a `tsc` error (the
 * `TaskRecord` type has no index signature), so this guard focuses on
 * `shared/lib/*.sh`, `shared/hooks/*.sh`, and `tools/*.sh`, plus any `.ts`
 * file in those directories whose `.tasks[...]` access escapes the type
 * system through casts or JSON parsing.
 *
 * Two patterns are extracted per scanned line:
 *   - jq-style first-segment reads: `.tasks[<key>].<field>` (and nested paths
 *     such as `.tasks[$i].lifecycle.deliveryEvidence.prNumber` validate only
 *     the first segment, `lifecycle`). `.terminalTaskHistory.tasks[$i].<x>`
 *     is a tombstone with a different shape and is dropped via a negative
 *     lookbehind.
 *   - `get_task_meta <id> <field>` calls (shell only). The field name may be
 *     bare, single- or double-quoted.
 *
 * jq writes (`.tasks[$i].x = $foo`) are deliberately matched too: a write to
 * a field the schema does not declare is still drift. Writer coverage is
 * enforced primarily by `workflow-state.writer-coverage.test.ts`.
 *
 * Suppress one line with `# allow-task-field: <reason>` (or `//` in TS) on
 * the finding line or within a short preceding window, so one shell-comment
 * marker covers an owning `jq '…multi-line filter…'` or
 * `state_mutate "$FILE" '…'` call whose filter spans several lines.
 * Comment-only lines never fire the guard, so prose that names a forbidden
 * field in docs is safe.
 */
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const SUPPRESSION_MARKER = 'allow-task-field';
export const WORKFLOW_TASK_SCHEMA_PATH = 'shared/schemas/workflow-task.schema.json';

const SCANNED_EXTENSIONS = new Set(['.sh', '.bash', '.ts', '.tsx', '.mts', '.cts']);
const SCANNED_PREFIXES = ['shared/lib/', 'shared/hooks/', 'tools/'];
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mts|cts|sh)$/;

/** The guard and the shared writer surface necessarily contain the pattern. */
const AUTO_EXCLUDED_PATHS = new Set([
  'shared/lib/task-field-read-checker.ts',
  'shared/lib/task-field-read-checker.test.ts',
  'tools/check-task-field-reads.ts', // install-paths: allow repo-relative scan-exclusion key, not an invocation
  'shared/lib/workflow-state-writers.ts',
]);

const AUTO_EXCLUDED_PREFIXES = ['node_modules/', 'features/', '.wavemill/', 'spike/', 'worktrees/', 'tests/'];

/**
 * `.tasks[...].field` — captures the first segment after the index. The
 * negative lookbehind drops `.terminalTaskHistory.tasks[...]` (a tombstone
 * map with a different shape, owned by the terminal reconciler).
 */
const TASKS_FIELD_RE = /(?<!terminalTaskHistory)\.tasks\[[^\]]*\]\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * `get_task_meta <id> <field>` — the first arg is any shell word (quoted,
 * `$var`, `${expr}`, or bare), the field is a bare word or a `'...'`/`"..."`
 * literal. Dynamic field names (`$var`, `${expr}`) are intentionally not
 * matched: the guard flags concrete field names only.
 */
const GET_TASK_META_RE = /get_task_meta\s+(?:"[^"]*"|'[^']*'|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\S+)\s+(?:"([A-Za-z_]\w*)"|'([A-Za-z_]\w*)'|([A-Za-z_]\w*))/g;

export interface TaskFieldReadFinding {
  file: string;
  line: number;
  column: number;
  field: string;
  pattern: 'tasks-field-read' | 'get-task-meta';
  text: string;
}

export interface TaskFieldReadResult {
  ok: boolean;
  scannedFiles: number;
  allowedFields: string[];
  findings: TaskFieldReadFinding[];
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#');
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}

/**
 * Load the TaskRecord property names from the schema and return them as a
 * `Set<string>`. Throws on parse or shape errors so the guard fails closed —
 * a missing or malformed schema means every reader is unverifiable, not safe.
 */
export function loadAllowedTaskFields(repoDir = defaultRepoRoot): Set<string> {
  const schemaPath = join(repoDir, WORKFLOW_TASK_SCHEMA_PATH);
  const text = readFileSync(schemaPath, 'utf-8');
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    throw new Error(`task-field-read-checker: cannot parse ${WORKFLOW_TASK_SCHEMA_PATH}: ${(err as Error).message}`);
  }
  const defs = (schema as { $defs?: { TaskRecord?: { properties?: Record<string, unknown> } } }).$defs;
  const props = defs?.TaskRecord?.properties;
  if (!props || typeof props !== 'object') {
    throw new Error(`task-field-read-checker: ${WORKFLOW_TASK_SCHEMA_PATH} has no $defs.TaskRecord.properties`);
  }
  return new Set(Object.keys(props));
}

/**
 * Fixed-size suppression window: the finding line itself and up to
 * {@link SUPPRESSION_WINDOW} immediately preceding lines. The window must be
 * large enough to let one shell-comment marker cover a `jq '...'` or
 * `state_mutate "$FILE" '...'` call whose multi-line filter follows on the
 * next line (one marker over the `jq` invocation and the filter opens on
 * line 2, the finding is on line 3 or deeper). 8 is comfortably past that
 * without reaching code that belongs to a different statement.
 */
const SUPPRESSION_WINDOW = 8;

/**
 * True when the finding on `index` is suppressed by an `allow-task-field:`
 * marker on the finding line itself or within the preceding window.
 */
export function hasNearbySuppression(lines: string[], index: number): boolean {
  const start = Math.max(0, index - SUPPRESSION_WINDOW);
  for (let j = start; j <= index; j += 1) {
    if (lines[j]?.includes(SUPPRESSION_MARKER)) return true;
  }
  return false;
}

/**
 * Extract every task-record field read from a single file's source text. A
 * finding is suppressed when `allow-task-field:` appears on the finding's
 * line or on a nearby owning line (see {@link hasNearbySuppression}).
 * Whole-line comments never fire.
 */
export function extractTaskFieldReads(
  fileName: string,
  sourceText: string,
  allowed: Set<string>,
): TaskFieldReadFinding[] {
  const normalized = normalizePath(fileName);
  const ext = path.posix.extname(normalized);
  if (!SCANNED_EXTENSIONS.has(ext)) return [];
  const isShell = ext === '.sh' || ext === '.bash';
  const lines = sourceText.split(/\r?\n/);
  const findings: TaskFieldReadFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (hasNearbySuppression(lines, i)) continue;
    if (isCommentLine(line)) continue;
    TASKS_FIELD_RE.lastIndex = 0;
    for (const match of line.matchAll(TASKS_FIELD_RE)) {
      const field = match[1];
      if (allowed.has(field)) continue;
      findings.push({
        file: normalized,
        line: i + 1,
        column: (match.index ?? 0) + 1,
        field,
        pattern: 'tasks-field-read',
        text: truncate(line.trim()),
      });
    }
    if (!isShell) continue;
    GET_TASK_META_RE.lastIndex = 0;
    for (const match of line.matchAll(GET_TASK_META_RE)) {
      const field = match[1] ?? match[2] ?? match[3];
      if (!field || allowed.has(field)) continue;
      findings.push({
        file: normalized,
        line: i + 1,
        column: (match.index ?? 0) + 1,
        field,
        pattern: 'get-task-meta',
        text: truncate(line.trim()),
      });
    }
  }
  return findings;
}

function listTrackedFiles(repoDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean).map(normalizePath);
}

/** Whether the guard scans `file` (repo-relative, posix separators). */
export function isTaskFieldReadScanned(file: string): boolean {
  if (AUTO_EXCLUDED_PATHS.has(file)) return false;
  if (AUTO_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  if (!SCANNED_EXTENSIONS.has(path.posix.extname(file))) return false;
  if (TEST_FILE_PATTERN.test(path.posix.basename(file))) return false;
  return SCANNED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function checkTaskFieldReads(repoDir = defaultRepoRoot): TaskFieldReadResult {
  const allowed = loadAllowedTaskFields(repoDir);
  const findings: TaskFieldReadFinding[] = [];
  let scannedFiles = 0;
  for (const file of listTrackedFiles(repoDir)) {
    if (!isTaskFieldReadScanned(file)) continue;
    let source: string;
    try {
      source = readFileSync(join(repoDir, file), 'utf-8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    findings.push(...extractTaskFieldReads(file, source, allowed));
  }
  return {
    ok: findings.length === 0,
    scannedFiles,
    allowedFields: [...allowed].sort(),
    findings,
  };
}

/** Scan one source string against an explicit allowlist. Used by tests. */
export function checkTaskFieldReadsForFile(
  fileName: string,
  source: string,
  allowed: Set<string>,
): TaskFieldReadResult {
  const findings = extractTaskFieldReads(fileName, source, allowed);
  return {
    ok: findings.length === 0,
    scannedFiles: 1,
    allowedFields: [...allowed].sort(),
    findings,
  };
}

export function formatTaskFieldReads(result: TaskFieldReadResult): string {
  if (result.ok) {
    return `task-field-reads: ok (${result.scannedFiles} files scanned, ${result.allowedFields.length} fields allowed)`;
  }
  return [
    `task-field-reads: found ${result.findings.length} reader-only task field(s):`,
    ...result.findings.map((f, i) =>
      `${i + 1}. ${f.file}:${f.line}:${f.column} [${f.pattern}] field \`${f.field}\` is not declared in TaskRecord\n   ${f.text}`),
    '',
    'A task-record field read must name a property declared in',
    `${WORKFLOW_TASK_SCHEMA_PATH}'s $defs.TaskRecord. The schema is derived from the writers (HOK-3220).`,
    'A field no writer sets has no value to read — the reader is wrong, not the schema.',
    'HOK-3212 shipped because nothing compared reads against writes; this guard closes that gap.',
    `For a justified exception (a legacy fallback, a terminal tombstone read), suppress one line with:`,
    `  # ${SUPPRESSION_MARKER}: <reason>   (or //  ${SUPPRESSION_MARKER}: <reason> in TypeScript)`,
    'on the finding line or the line above.',
  ].join('\n');
}
