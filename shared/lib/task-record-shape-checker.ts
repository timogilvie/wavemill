// allow-task-record-shape: this file *is* the task-record-shape guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see AUTO_EXCLUDED_PATHS); the marker above is defensive.
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
 * `// allow-task-record-shape: <reason>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const SUPPRESSION_MARKER = 'allow-task-record-shape';
export const TASK_RECORD_SHAPE_ALLOWLIST_FILE = 'tools/task-record-shape-allowlist.txt';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mts|cts)$/;

/** The canonical module and this guard necessarily contain the shapes. */
const AUTO_EXCLUDED_PATHS = new Set([
  'shared/lib/workflow-state.ts',
  'shared/lib/task-record-shape-checker.ts',
]);

const AUTO_EXCLUDED_PREFIXES = ['tests/', 'features/', '.wavemill/', 'node_modules/', 'spike/', 'worktrees/'];

interface PatternSpec {
  name: string;
  description: string;
  /** Line-oriented matcher (no `g` flag; tested per line). */
  re: RegExp;
}

const PATTERNS: PatternSpec[] = [
  {
    name: 'tasks-record-annotation',
    description: '`tasks?: Record<...>` — private task-map shape; use WorkflowState / TaskRecord',
    // `Record<string, TaskRecord>` is the canonical map and is allowed.
    re: /\btasks\s*\??\s*:\s*Record\s*<(?!\s*string\s*,\s*TaskRecord\s*>)/,
  },
  {
    name: 'tasks-record-cast',
    description: '`.tasks as Record<...>` — casting the task map to a guessed shape; use workflowTaskEntries() / TaskRecord',
    re: /\.tasks\s+as\s+Record\s*</,
  },
  {
    name: 'workflow-state-type',
    description: 'private `WorkflowState` type — import WorkflowState from workflow-state.ts',
    re: /\b(?:interface|type)\s+WorkflowState(?:File|Task|Like)?\s*(?:=|\{|<|extends\b)/,
  },
  {
    name: 'task-record-type',
    description: 'private task-record type — import TaskRecord from workflow-state.ts (or Pick<TaskRecord, ...>)',
    re: /\b(?:interface\s+TaskState|(?:interface|type)\s+TaskRecord)\s*(?:=|\{|<|extends\b)/,
  },
];

export interface TaskRecordShapeFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  description: string;
  text: string;
}

export interface TaskRecordShapeResult {
  ok: boolean;
  scannedFiles: number;
  findings: TaskRecordShapeFinding[];
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}

/**
 * Scan one file. A finding is suppressed when `allow-task-record-shape:`
 * appears on the same line or the line above; whole-line comments never fire.
 */
export function checkTaskRecordShapeSource(fileName: string, sourceText: string): TaskRecordShapeFinding[] {
  if (!TS_EXTENSIONS.has(path.extname(fileName))) return [];
  const lines = sourceText.split(/\r?\n/);
  const findings: TaskRecordShapeFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const previous = i > 0 ? lines[i - 1] : '';
    if (line.includes(SUPPRESSION_MARKER) || previous.includes(SUPPRESSION_MARKER)) continue;
    if (isCommentLine(line)) continue;
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      findings.push({
        file: normalizePath(fileName),
        line: i + 1,
        column: match.index + 1,
        pattern: pattern.name,
        description: pattern.description,
        text: truncate(line.trim()),
      });
    }
  }
  return findings;
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
  const entries: AllowlistEntry[] = [];
  const missingReason: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const hash = trimmed.indexOf('#');
    const file = normalizePath((hash === -1 ? trimmed : trimmed.slice(0, hash)).trim());
    const reason = hash === -1 ? '' : trimmed.slice(hash + 1).trim();
    if (!reason) missingReason.push(file);
    else entries.push({ path: file, reason });
  }
  return { entries, missingReason };
}

function isExcluded(file: string): boolean {
  if (AUTO_EXCLUDED_PATHS.has(file)) return true;
  if (TEST_FILE_PATTERN.test(file)) return true;
  return AUTO_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function listTrackedTsFiles(repoDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.cts'], {
    cwd: repoDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean).map(normalizePath);
}

export function checkTaskRecordShapes(repoDir = defaultRepoRoot): TaskRecordShapeResult {
  const allowlistPath = join(repoDir, TASK_RECORD_SHAPE_ALLOWLIST_FILE);
  const { entries, missingReason } = existsSync(allowlistPath)
    ? parseTaskRecordShapeAllowlist(readFileSync(allowlistPath, 'utf-8'))
    : { entries: [], missingReason: [] };
  const allowed = new Set(entries.map((entry) => entry.path));

  const findings: TaskRecordShapeFinding[] = missingReason.map((file) => ({
    file: TASK_RECORD_SHAPE_ALLOWLIST_FILE,
    line: 0,
    column: 0,
    pattern: 'allowlist-missing-reason',
    description: `allowlist entry ${file} has no "# reason"`,
    text: file,
  }));
  let scannedFiles = 0;
  for (const file of listTrackedTsFiles(repoDir)) {
    if (isExcluded(file) || allowed.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(join(repoDir, file), 'utf-8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    findings.push(...checkTaskRecordShapeSource(file, source));
  }
  return { ok: findings.length === 0, scannedFiles, findings };
}

export function formatTaskRecordShapes(result: TaskRecordShapeResult): string {
  if (result.ok) return `task-record-shape: ok (${result.scannedFiles} files scanned)`;
  return [
    `task-record-shape: found ${result.findings.length} private workflow-state task shape(s):`,
    ...result.findings.map((f, i) => `${i + 1}. ${f.file}:${f.line}:${f.column} [${f.pattern}] ${f.description}\n   ${f.text}`),
    '',
    'workflow-state.json task records have one shape: TaskRecord / WorkflowState in',
    'shared/lib/workflow-state.ts, derived from the writers (HOK-3220). Import it, or',
    'narrow it with Pick<TaskRecord, ...>. A field the type lacks has no writer — the',
    'reader is wrong, not the type.',
    `For a justified exception, add the path to ${TASK_RECORD_SHAPE_ALLOWLIST_FILE} with a "# reason",`,
    `or suppress one line with: // ${SUPPRESSION_MARKER}: <reason>`,
  ].join('\n');
}
