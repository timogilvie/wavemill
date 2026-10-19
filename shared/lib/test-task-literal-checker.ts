// allow-task-literal: this file *is* the test-task-literal guard; its pattern
// and docs name the forbidden literal. It is auto-excluded from its own scan.
/**
 * Preflight guard (HOK-3223): tests build workflow-state task rows through the
 * shared, schema-validated fixture builders — `buildTask` /
 * `buildWorkflowState` in `tests/lib/task-builder.ts` and `fixture_task` /
 * `fixture_workflow_state` in `tests/lib/state-fixtures.sh` — never through a
 * hand-written `tasks: { ... }` literal.
 *
 * A hand-written literal compiles whatever field names its author guessed.
 * That is how the HOK-3212 "real-state" test kept passing against a shape no
 * writer produces: the test invented the shape the reader expected. The
 * builders reject a key the schema (`shared/schemas/workflow-task.schema.json`,
 * HOK-3220) does not declare, so a test can only seed what a writer writes.
 *
 * Scanned: tracked files under `tests/` (TS/JS, shell, JSON fixtures) and
 * every tracked `*.test.*` file. One pattern covers TS object literals
 * (`tasks: {`), JSON (`"tasks": {`), jq programs (`{tasks: {($i): ...}}`)
 * and escaped JSON inside shell strings (`\"tasks\": {`). An empty map
 * (`tasks: {}`) is not a task literal and never fires.
 *
 * Ratchet: `tools/test-task-literals-allowlist.txt` was seeded with every
 * file that contained a literal when the guard landed. It may only shrink:
 * an entry whose file no longer contains a literal (or no longer exists) is a
 * failure, so a migrated file must leave the list in the same change. One-off
 * exceptions (a test that seeds a deliberately schema-violating row, or a
 * `tasks` map that is not workflow-state, such as `ready-watchdog-state.json`)
 * use `// allow-task-literal: <reason>` (or `#` in shell) on the finding line
 * or the line above.
 */
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const SUPPRESSION_MARKER = 'allow-task-literal';
export const TEST_TASK_LITERALS_ALLOWLIST_FILE = 'tools/test-task-literals-allowlist.txt';

const SCANNED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh', '.bash', '.json', '.jsonl',
]);
const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/;

/** The guard and the builders necessarily contain the literal. */
const AUTO_EXCLUDED_PATHS = new Set([
  'shared/lib/test-task-literal-checker.ts',
  'shared/lib/test-task-literal-checker.test.ts',
  'tools/check-test-task-literals.ts',
  'tests/lib/task-builder.ts',
  'tests/lib/bin/build-fixture-task.ts',
  'tests/lib/state-fixtures.sh',
]);

const AUTO_EXCLUDED_PREFIXES = ['node_modules/', 'features/', '.wavemill/', 'spike/', 'worktrees/'];

/**
 * `tasks` (optionally quoted, optionally with escaped quotes) followed by `:`
 * and an opening brace that is not immediately closed. The lookbehind keeps
 * `.tasks` (a property read), `subtasks` and `$tasks` from matching.
 */
const TASK_LITERAL_RE = /(?<![\w$.\\])\\?(["']?)tasks\\?\1\s*:\s*\{(?!\s*\})/;

export interface TestTaskLiteralFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  description: string;
  text: string;
}

export interface TestTaskLiteralResult {
  ok: boolean;
  scannedFiles: number;
  findings: TestTaskLiteralFinding[];
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

/** Whether the guard scans `file` (repo-relative, posix separators). */
export function isTestTaskLiteralScanned(file: string): boolean {
  if (AUTO_EXCLUDED_PATHS.has(file)) return false;
  if (AUTO_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  if (!SCANNED_EXTENSIONS.has(path.posix.extname(file))) return false;
  return file.startsWith('tests/') || TEST_FILE_PATTERN.test(path.posix.basename(file));
}

/**
 * Scan one file. A finding is suppressed when `allow-task-literal:` appears on
 * the same line or the line above; whole-line comments never fire.
 */
export function checkTestTaskLiteralSource(fileName: string, sourceText: string): TestTaskLiteralFinding[] {
  const lines = sourceText.split(/\r?\n/);
  const findings: TestTaskLiteralFinding[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const previous = i > 0 ? lines[i - 1] : '';
    if (line.includes(SUPPRESSION_MARKER) || previous.includes(SUPPRESSION_MARKER)) continue;
    if (isCommentLine(line)) continue;
    const match = TASK_LITERAL_RE.exec(line);
    if (!match) continue;
    findings.push({
      file: normalizePath(fileName),
      line: i + 1,
      column: match.index + 1,
      pattern: 'task-literal',
      description: 'hand-written `tasks: { ... }` literal — build rows with buildTask / buildWorkflowState or fixture_task',
      text: truncate(line.trim()),
    });
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
export function parseTestTaskLiteralsAllowlist(contents: string): { entries: AllowlistEntry[]; missingReason: string[] } {
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

function listTrackedFiles(repoDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean).map(normalizePath);
}

function allowlistFinding(pattern: string, description: string, file: string): TestTaskLiteralFinding {
  return { file: TEST_TASK_LITERALS_ALLOWLIST_FILE, line: 0, column: 0, pattern, description, text: file };
}

export function checkTestTaskLiterals(repoDir = defaultRepoRoot): TestTaskLiteralResult {
  const allowlistPath = join(repoDir, TEST_TASK_LITERALS_ALLOWLIST_FILE);
  const { entries, missingReason } = existsSync(allowlistPath)
    ? parseTestTaskLiteralsAllowlist(readFileSync(allowlistPath, 'utf-8'))
    : { entries: [], missingReason: [] };
  const allowed = new Set(entries.map((entry) => entry.path));

  const findings: TestTaskLiteralFinding[] = missingReason.map((file) =>
    allowlistFinding('allowlist-missing-reason', `allowlist entry ${file} has no "# reason"`, file));

  const tracked = listTrackedFiles(repoDir);
  const trackedSet = new Set(tracked);
  for (const entry of entries) {
    if (!trackedSet.has(entry.path) || !isTestTaskLiteralScanned(entry.path)) {
      findings.push(allowlistFinding(
        'allowlist-stale-entry',
        `allowlist entry ${entry.path} is not a tracked, scanned test file — remove it (the allowlist only shrinks)`,
        entry.path,
      ));
    }
  }

  let scannedFiles = 0;
  for (const file of tracked) {
    if (!isTestTaskLiteralScanned(file)) continue;
    let source: string;
    try {
      source = readFileSync(join(repoDir, file), 'utf-8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    const fileFindings = checkTestTaskLiteralSource(file, source);
    if (allowed.has(file)) {
      if (fileFindings.length === 0) {
        findings.push(allowlistFinding(
          'allowlist-stale-entry',
          `allowlist entry ${file} no longer contains a task literal — remove it (the allowlist only shrinks)`,
          file,
        ));
      }
      continue;
    }
    findings.push(...fileFindings);
  }
  return { ok: findings.length === 0, scannedFiles, findings };
}

export function formatTestTaskLiterals(result: TestTaskLiteralResult): string {
  if (result.ok) return `test-task-literals: ok (${result.scannedFiles} files scanned)`;
  return [
    `test-task-literals: found ${result.findings.length} problem(s):`,
    ...result.findings.map((f, i) => `${i + 1}. ${f.file}:${f.line}:${f.column} [${f.pattern}] ${f.description}\n   ${f.text}`),
    '',
    'Tests seed workflow-state task rows through the schema-validated builders',
    '(HOK-3223), never a hand-written `tasks: { ... }` literal:',
    "  TS:    import { buildTask, buildWorkflowState } from 'tests/lib/task-builder.ts'",
    '  shell: source tests/lib/state-fixtures.sh; fixture_workflow_state "$STATE_FILE" HOK-1 phase=ready',
    'The builders reject any key the schema does not declare, so a test cannot invent',
    'a field no writer sets. For a justified exception (a deliberately invalid row, or a',
    `\`tasks\` map that is not workflow-state) suppress one line with: // ${SUPPRESSION_MARKER}: <reason>`,
    `${TEST_TASK_LITERALS_ALLOWLIST_FILE} is a seeded ratchet: it only shrinks.`,
  ].join('\n');
}
