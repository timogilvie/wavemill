// allow-task-identity: this file *is* the task-identity guard; it necessarily
// contains every forbidden pattern as a literal. It is auto-excluded from its
// own scan (see AUTO_EXCLUDED_PATHS); the marker above is defensive.
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const SUPPRESSION_MARKER = 'allow-task-identity';
const ALLOWLIST_FILE = 'tools/task-identity-allowlist.txt';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash']);

const TEST_FILE_PATTERN = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SHELL_TEST_PATTERN = /\.test\.(sh|bash)$/;

// The invariant itself and the guard that scans for it necessarily contain
// every forbidden pattern; they are never scanned.
const AUTO_EXCLUDED_PATHS = new Set([
  'shared/lib/task-identity.ts',
  'shared/lib/task-identity.sh',
  'shared/lib/task-identity-checker.ts',
]);

// Directory prefixes that are generated / per-run / pinned and never scanned.
const AUTO_EXCLUDED_PREFIXES = [
  'tests/fixtures/',
  'features/',
  '.wavemill/',
  'node_modules/',
  '.git/',
];

type Lang = 'ts' | 'sh' | 'both';

interface PatternSpec {
  /** Stable name surfaced in findings. */
  name: string;
  /** Short human description of the ad-hoc shape being caught. */
  description: string;
  /** Which source languages the pattern applies to. */
  lang: Lang;
  /** Line-oriented matcher (never use the `g` flag; we index per line). */
  re: RegExp;
}

// Deliberately narrow, operator-shaped patterns. The goal is to catch new
// ad-hoc `_c` derivations and inline issue-ID regexes — never to lint variable
// names that end in `_c` (`comp_c`) or prose issue IDs in strings/comments.
const PATTERNS: PatternSpec[] = [
  // --- TS/JS ---------------------------------------------------------------
  {
    name: 'ts-endswith-c',
    description: "`.endsWith('_c')` — challenger check; use isChallengerTaskId()",
    lang: 'ts',
    re: /\.endsWith\(\s*['"`]_c['"`]\s*\)/,
  },
  {
    name: 'c-anchor-regex',
    description: '`/_c$/` regex literal — stripping the challenger suffix inline',
    lang: 'both',
    re: /\/_c\$\//,
  },
  {
    name: 'ts-template-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${expr}_c` template literal — hand-built challenger ID; use challengerTaskId()',
    lang: 'ts',
    re: /\$\{[^}]+\}_c`/,
  },
  // --- Shell ---------------------------------------------------------------
  {
    name: 'sh-param-expand-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${var%_c}` parameter expansion — stripping the challenger suffix inline',
    lang: 'sh',
    re: /\$\{[A-Za-z_][A-Za-z0-9_]*%_c\}/,
  },
  {
    name: 'sh-glob-c',
    description: '`*_c ]]` glob test — ad-hoc challenger match; use is_challenger_task_id()',
    lang: 'sh',
    re: /\*_c\s*\]\]/,
  },
  {
    name: 'sh-build-c',
    // allow-template-curly: literal description of the forbidden shape, not interpolation.
    description: '`${var}_c` — hand-built challenger ID; use challenger_task_id()',
    lang: 'sh',
    re: /\$\{[^}]+\}_c(?=["'}\/\s]|$)/,
  },
  {
    name: 'sh-awk-sub-c',
    description: '`sub("_c$"…)` — awk stripping the challenger suffix inline',
    lang: 'sh',
    re: /sub\(\s*(?:"_c\$|\/_c\\?\$)/,
  },
  {
    name: 'sh-jq-endswith-c',
    description: '`endswith("_c")` — jq challenger check inline',
    lang: 'sh',
    re: /endswith\(\s*"_c"\s*\)/,
  },
  // --- Both: inline issue-ID regex literals --------------------------------
  // `[A-Z]+-\d+`, `[A-Z][A-Z0-9]*-\d+`, `[A-Z]{2,}-\d+`, and the `\\d`
  // (string-source) twin. Requires the characteristic `[A-Z` class start so a
  // comment or prose issue ID never fires.
  {
    name: 'issue-id-regex',
    description: 'inline issue-ID regex (`[A-Z…]-\\d+`) — use ISSUE_ID_RE / the task-identity exports',
    lang: 'both',
    re: /\[A-Z[^\n]{0,24}?-\\{1,2}d/,
  },
];

export interface TaskIdentityFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  description: string;
  text: string;
}

export interface TaskIdentityResult {
  ok: boolean;
  scannedFiles: number;
  findings: TaskIdentityFinding[];
}

function patternsForExtension(ext: string): PatternSpec[] {
  if (TS_EXTENSIONS.has(ext)) {
    return PATTERNS.filter((p) => p.lang === 'ts' || p.lang === 'both');
  }
  if (SHELL_EXTENSIONS.has(ext)) {
    return PATTERNS.filter((p) => p.lang === 'sh' || p.lang === 'both');
  }
  return [];
}

/**
 * Scan a single file's source text for ad-hoc task-identity derivations.
 *
 * Line-oriented: each applicable pattern is tested against every line, and a
 * finding is suppressed when `allow-task-identity:` appears on the same line or
 * the line immediately above.
 */
export function checkSourceText(fileName: string, sourceText: string): TaskIdentityFinding[] {
  const ext = path.extname(fileName);
  const patterns = patternsForExtension(ext);
  if (patterns.length === 0) return [];

  const lines = sourceText.split(/\r?\n/);
  const findings: TaskIdentityFinding[] = [];

  const isShell = SHELL_EXTENSIONS.has(ext);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const previous = i > 0 ? lines[i - 1] : '';
    if (line.includes(SUPPRESSION_MARKER) || previous.includes(SUPPRESSION_MARKER)) {
      continue;
    }
    // Skip whole-line comments: prose (`# HOK-123_c`, `// built as ${x}_c`) is
    // not a derivation. Lines with trailing comments still fire on their code.
    if (isCommentLine(line, isShell)) {
      continue;
    }
    for (const pattern of patterns) {
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

export function checkTaskIdentity(repoDir = defaultRepoRoot): TaskIdentityResult {
  const allowlist = readAllowlist(repoDir);
  const files = listTrackedSourceFiles(repoDir);

  const findings: TaskIdentityFinding[] = [];
  let scannedFiles = 0;

  for (const file of files) {
    if (isExcluded(file) || allowlist.has(file)) continue;

    const fullPath = join(repoDir, file);
    if (!existsSync(fullPath)) continue;

    const sourceText = readSourceFile(fullPath);
    if (sourceText === null) continue;
    scannedFiles += 1;

    findings.push(...checkSourceText(file, sourceText));
  }

  return {
    ok: findings.length === 0,
    scannedFiles,
    findings,
  };
}

export function formatTaskIdentity(result: TaskIdentityResult): string {
  if (result.ok) {
    return `task-identity: ok (${result.scannedFiles} files scanned)`;
  }

  return [
    `task-identity: found ${result.findings.length} ad-hoc task-identity derivation(s):`,
    ...result.findings.map((f, i) => (
      `${i + 1}. ${f.file}:${f.line}:${f.column} [${f.pattern}] ${f.description}\n   ${f.text}`
    )),
    '',
    'Every task-ID → Linear-ID derivation, challenger check, and challenger-ID',
    'construction must go through shared/lib/task-identity.{ts,sh} — never parse',
    'or build `_c` inline, and never author an inline issue-ID regex.',
    `For a justified exception, add the path to ${ALLOWLIST_FILE} with a reason,`,
    `or suppress one line with: // ${SUPPRESSION_MARKER}: <reason>  (use # in shell).`,
  ].join('\n');
}

function isExcluded(file: string): boolean {
  const normalized = normalizePath(file);
  if (AUTO_EXCLUDED_PATHS.has(normalized)) return true;
  if (TEST_FILE_PATTERN.test(normalized) || SHELL_TEST_PATTERN.test(normalized)) return true;
  return AUTO_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function readAllowlist(repoDir: string): Set<string> {
  const fullPath = join(repoDir, ALLOWLIST_FILE);
  const contents = readSourceFile(fullPath);
  if (contents === null) return new Set();

  const entries = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => normalizePath(line));
  return new Set(entries);
}

function listTrackedSourceFiles(repoDir: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.sh', '*.bash'],
    { cwd: repoDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => {
      const ext = path.extname(file);
      return TS_EXTENSIONS.has(ext) || SHELL_EXTENSIONS.has(ext);
    });
}

function readSourceFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function isCommentLine(line: string, isShell: boolean): boolean {
  const trimmed = line.trimStart();
  if (trimmed === '') return false;
  if (isShell) {
    return trimmed.startsWith('#');
  }
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}
