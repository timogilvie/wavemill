/**
 * Preflight guard (HOK-3235): every `WAVEMILL_*` env token in code must have
 * an entry in `docs/feature-flags.md` or in the seeded plumbing baseline
 * (`tools/feature-flags-baseline.txt`), and the open-shadow list is capped at
 * {@link MAX_OPEN_SHADOWS}. See CLAUDE.md and docs/feature-flags.md for the
 * policy and the `// allow-feature-flag:` suppression marker.
 */
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLinearIssueId } from './task-identity.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const SUPPRESSION_MARKER = 'allow-feature-flag';

export const FEATURE_FLAGS_DOC = 'docs/feature-flags.md';
export const FEATURE_FLAGS_BASELINE_FILE = 'tools/feature-flags-baseline.txt';

/** The policy start date: grandfathered rows get 30 days from here. */
export const POLICY_START_DATE = '2026-10-20';

/** Hard cap on `## Open shadow modes` table rows. */
export const MAX_OPEN_SHADOWS = 5;

/** Rows must be removed within this many days of being added. */
export const EXPIRY_WINDOW_DAYS = 30;

/**
 * A row may carry one explicit extension, at most this many days past its
 * original remove-by. `added` is never rewritten to buy more time.
 */
export const EXTENSION_WINDOW_DAYS = 30;

const KILL_SWITCH_PATTERN = /(^|_)(DISABLED?|SKIP|SYNC|LIVE|SHADOW|LEGACY|AUTOFIX|ENABLED|FORCE|NO)(_|$)/;

const SCANNED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs',
  '.sh', '.bash',
  '.yml', '.yaml',
  '.json',
]);

const EXCLUDED_PREFIXES = [
  'tests/',
  'features/',
  '.wavemill/',
  'docs/',
  'node_modules/',
  'spike/',
  'worktrees/',
  'shared/validators/',
  'shared/fixtures/',
];

const EXCLUDED_FILE_PATTERNS = [
  /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh)$/,
  /\.md$/,
];

/** The guard and the doc necessarily name every flag. */
const AUTO_EXCLUDED_PATHS = new Set([
  'shared/lib/feature-flag-checker.ts',
  'shared/lib/feature-flag-checker.test.ts',
  'tools/check-feature-flags.ts', // install-paths: allow repo-relative scan-exclusion key, not an invocation
  FEATURE_FLAGS_DOC,
  FEATURE_FLAGS_BASELINE_FILE,
]);

const WAVEMILL_TOKEN_RE = /WAVEMILL_[A-Z0-9_]+/g;

export type DocTableKind = 'open-shadows' | 'kill-switches' | 'permanent';

export interface DocRow {
  table: DocTableKind;
  name: string;
  rawName: string;
  isPrefix: boolean;
  cells: string[];
  lineNumber: number;
  /** First cell is a backticked name; `cells` holds the remaining columns. */
}

export interface ParsedDoc {
  rows: DocRow[];
  shadowCount: number;
  errors: Array<{ message: string; line: number }>;
}

const OPEN_SHADOWS_HEADING = /^##\s+Open shadow modes\s*$/;
const KILL_SWITCHES_HEADING = /^##\s+Kill switches, rollbacks, skips and legacy paths\s*$/;
const PERMANENT_HEADING = /^##\s+Permanent operator settings\s*$/;

/** Pull out backticked flag names from the first cell. May return several. */
function parseFlagNames(cell: string): string[] {
  const matches = cell.match(/`([^`]+)`/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1).trim()).filter(Boolean);
}

export function parseFeatureFlagsDoc(markdown: string): ParsedDoc {
  const lines = markdown.split(/\r?\n/);
  const rows: DocRow[] = [];
  const errors: ParsedDoc['errors'] = [];
  let current: DocTableKind | null = null;
  let inRow = false;
  let shadowCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (OPEN_SHADOWS_HEADING.test(line)) { current = 'open-shadows'; inRow = false; continue; }
    if (KILL_SWITCHES_HEADING.test(line)) { current = 'kill-switches'; inRow = false; continue; }
    if (PERMANENT_HEADING.test(line)) { current = 'permanent'; inRow = false; continue; }
    if (/^##\s+/.test(line)) { current = null; inRow = false; continue; }
    if (!current) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Separator row like `|------|------|`
    if (/^\|\s*-+/.test(trimmed)) { inRow = true; continue; }
    if (!inRow) continue; // header row before the separator
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    const names = parseFlagNames(cells[0]);
    if (names.length === 0) {
      // Allow continuation rows for config-key based shadows that use "—"
      if (cells[0] === '—' || cells[0] === '-') continue;
      errors.push({ message: `row without a backticked flag name: ${trimmed}`, line: i + 1 });
      continue;
    }
    if (current === 'open-shadows') shadowCount += 1;
    for (const name of names) {
      rows.push({
        table: current,
        name: name.replace(/\*$/, ''),
        rawName: name,
        isPrefix: name.endsWith('*') || name.endsWith('_'),
        cells: cells.slice(1),
        lineNumber: i + 1,
      });
    }
  }
  return { rows, shadowCount, errors };
}

export interface BaselineEntry {
  name: string;
  isPrefix: boolean;
  reason: string;
}

export function parseBaseline(contents: string): { entries: BaselineEntry[]; missingReason: string[] } {
  const entries: BaselineEntry[] = [];
  const missingReason: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const hash = trimmed.indexOf('#');
    const name = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
    const reason = hash === -1 ? '' : trimmed.slice(hash + 1).trim();
    if (!name) continue;
    if (!reason) missingReason.push(name);
    const bare = name.endsWith('*') ? name.slice(0, -1) : name;
    entries.push({ name: bare, isPrefix: name.endsWith('*') || name.endsWith('_'), reason });
  }
  return { entries, missingReason };
}

export interface CodeTokenFinding {
  token: string;
  file: string;
  line: number;
}

function isScanned(file: string): boolean {
  if (AUTO_EXCLUDED_PATHS.has(file)) return false;
  if (EXCLUDED_PREFIXES.some((p) => file.startsWith(p))) return false;
  if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(file))) return false;
  const ext = path.posix.extname(file);
  if (ext && !SCANNED_EXTENSIONS.has(ext)) return false;
  return true;
}

export function scanFileForTokens(file: string, source: string): CodeTokenFinding[] {
  const findings: CodeTokenFinding[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : '';
    if (line.includes(SUPPRESSION_MARKER) || prev.includes(SUPPRESSION_MARKER)) continue;
    WAVEMILL_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((match = WAVEMILL_TOKEN_RE.exec(line)) !== null) {
      const token = match[0];
      if (seen.has(token)) continue;
      seen.add(token);
      findings.push({ file, line: i + 1, token });
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
  return output.split('\0').filter(Boolean).map((f) => f.split(path.sep).join(path.posix.sep));
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export interface RemoveBy {
  /** The date the row must be gone by (the extended date when extended). */
  date: string;
  /** Present when the row was extended once. */
  extension?: { from: string; issue: string; reason: string };
}

const EXTENDED_REMOVE_BY_RE = /^(\S+)\s*\(\s*extended from\s+(\S+?)\s*,\s*([^:]+?)\s*:\s*(.*)\)$/i;

/**
 * Parse a remove-by cell: either `YYYY-MM-DD`, or one explicit extension
 * `YYYY-MM-DD (extended from YYYY-MM-DD, HOK-123: reason)`. Returns null when
 * the cell matches neither shape, or names more than one extension.
 */
export function parseRemoveBy(cell: string): RemoveBy | null {
  const trimmed = cell.trim();
  if ((trimmed.match(/extended from/gi) ?? []).length > 1) return null;
  const extended = EXTENDED_REMOVE_BY_RE.exec(trimmed);
  if (!extended) return { date: trimmed };
  return {
    date: extended[1],
    extension: { from: extended[2], issue: extended[3].trim(), reason: extended[4].trim() },
  };
}

export interface CheckOptions {
  repoDir?: string;
  /** Fixed "now" for overdue warnings; defaults to today. */
  now?: Date;
  /** Fixed listing of tracked files (tests pass this instead of running git). */
  files?: string[];
  /** Doc markdown override (tests). */
  docContent?: string;
  /** Baseline content override (tests). */
  baselineContent?: string;
  /** File reader override (tests). */
  readFile?: (abs: string) => string;
}

export interface FeatureFlagFinding {
  severity: 'error' | 'warning';
  kind: string;
  message: string;
  file?: string;
  line?: number;
}

export interface FeatureFlagResult {
  ok: boolean;
  scanned: number;
  tokens: number;
  shadowCount: number;
  findings: FeatureFlagFinding[];
  warnings: FeatureFlagFinding[];
}

function matchesRowOrBaseline(token: string, names: Array<{ name: string; isPrefix: boolean }>): boolean {
  for (const n of names) {
    if (n.isPrefix) {
      if (token.startsWith(n.name)) return true;
    } else if (token === n.name) {
      return true;
    }
  }
  return false;
}

function validateExpiringRow(row: DocRow, idxByName: Record<string, number>, policyStart: Date, findings: FeatureFlagFinding[], warnings: FeatureFlagFinding[], now: Date): void {
  const { cells, table, name, lineNumber } = row;
  // Shadow and kill-switch rows must carry owner-issue, removal-issue, added, remove-by.
  const columns = table === 'open-shadows'
    ? { switch: 0, owner: 1, added: 2, criterion: 3, removalIssue: 4, removeBy: 5 }
    : { purpose: 1, owner: 2, added: 3, criterion: 4, removalIssue: 5, removeBy: 6 };
  const added = cells[columns.added] ?? '';
  const removeBy = cells[columns.removeBy] ?? '';
  const owner = cells[columns.owner] ?? '';
  const removalIssue = cells[columns.removalIssue] ?? '';
  const criterion = cells[columns.criterion] ?? '';
  if (!owner || !criterion || !added || !removeBy || !removalIssue) {
    findings.push({
      severity: 'error',
      kind: 'missing-field',
      message: `row \`${row.rawName}\` is missing one of {owner, added, criterion, removal issue, remove-by}`,
      file: FEATURE_FLAGS_DOC,
      line: lineNumber,
    });
    return;
  }
  // Issue IDs through resolveLinearIssueId (HOK-3118 forbids inline regexes).
  const ownerBare = owner.replace(/\[|\]|\(|\).*/g, '').trim();
  const removalBare = removalIssue.replace(/\[|\]|\(|\).*/g, '').trim();
  const ownerResolved = resolveLinearIssueId(ownerBare);
  const removalResolved = resolveLinearIssueId(removalBare);
  if (!ownerResolved.ok) {
    findings.push({ severity: 'error', kind: 'bad-issue-id', message: `row \`${name}\` owner-issue is not a valid Linear ID: ${owner}`, file: FEATURE_FLAGS_DOC, line: lineNumber });
  }
  if (!removalResolved.ok) {
    findings.push({ severity: 'error', kind: 'bad-issue-id', message: `row \`${name}\` removal-issue is not a valid Linear ID: ${removalIssue}`, file: FEATURE_FLAGS_DOC, line: lineNumber });
  }
  const parsedRemoveBy = parseRemoveBy(removeBy);
  if (!parsedRemoveBy) {
    findings.push({ severity: 'error', kind: 'bad-extension', message: `row \`${name}\` remove-by may be extended at most once: ${removeBy}`, file: FEATURE_FLAGS_DOC, line: lineNumber });
    return;
  }
  const { extension } = parsedRemoveBy;
  // The 30-day cap applies to the original date, so an extension never hides it.
  const originalRemoveBy = extension ? extension.from : parsedRemoveBy.date;
  const addedDate = parseIsoDate(added);
  const originalDate = parseIsoDate(originalRemoveBy);
  const removeByDate = parseIsoDate(parsedRemoveBy.date);
  if (!addedDate || !originalDate || !removeByDate) {
    findings.push({ severity: 'error', kind: 'bad-date', message: `row \`${name}\` has a non-ISO date (added=${added}, remove-by=${removeBy})`, file: FEATURE_FLAGS_DOC, line: lineNumber });
    return;
  }
  const basis = addedDate.getTime() > policyStart.getTime() ? addedDate : policyStart;
  const latest = addDays(basis, EXPIRY_WINDOW_DAYS);
  if (originalDate.getTime() > latest.getTime()) {
    findings.push({
      severity: 'error',
      kind: 'remove-by-too-late',
      message: `row \`${name}\` remove-by ${originalRemoveBy} is more than ${EXPIRY_WINDOW_DAYS} days past max(added=${added}, policy=${POLICY_START_DATE})`,
      file: FEATURE_FLAGS_DOC,
      line: lineNumber,
    });
  }
  if (extension) {
    const extensionIssue = resolveLinearIssueId(extension.issue.replace(/\[|\]|\(|\).*/g, '').trim());
    if (!extensionIssue.ok || !extension.reason) {
      findings.push({ severity: 'error', kind: 'bad-extension', message: `row \`${name}\` extension needs a valid Linear issue and a reason: ${removeBy}`, file: FEATURE_FLAGS_DOC, line: lineNumber });
    }
    if (removeByDate.getTime() <= originalDate.getTime() || removeByDate.getTime() > addDays(originalDate, EXTENSION_WINDOW_DAYS).getTime()) {
      findings.push({
        severity: 'error',
        kind: 'extension-too-late',
        message: `row \`${name}\` extension to ${parsedRemoveBy.date} must be after ${originalRemoveBy} and at most ${EXTENSION_WINDOW_DAYS} days past it`,
        file: FEATURE_FLAGS_DOC,
        line: lineNumber,
      });
    }
  }
  if (removeByDate.getTime() < now.getTime()) {
    warnings.push({
      severity: 'warning',
      kind: 'overdue',
      message: `[feature-flags] overdue: ${name} remove-by ${parsedRemoveBy.date} (${removalIssue})`,
      file: FEATURE_FLAGS_DOC,
      line: lineNumber,
    });
  }
}

export function checkFeatureFlags(options: CheckOptions = {}): FeatureFlagResult {
  const repoDir = options.repoDir ?? defaultRepoRoot;
  const now = options.now ?? new Date();
  const readFile = options.readFile ?? ((abs: string) => readFileSync(abs, 'utf-8'));
  const findings: FeatureFlagFinding[] = [];
  const warnings: FeatureFlagFinding[] = [];

  // --- doc ---
  const docAbs = join(repoDir, FEATURE_FLAGS_DOC);
  const docContent = options.docContent ?? (existsSync(docAbs) ? readFile(docAbs) : '');
  if (!docContent) {
    findings.push({ severity: 'error', kind: 'doc-missing', message: `${FEATURE_FLAGS_DOC} is missing or empty`, file: FEATURE_FLAGS_DOC });
    return { ok: false, scanned: 0, tokens: 0, shadowCount: 0, findings, warnings };
  }
  const doc = parseFeatureFlagsDoc(docContent);
  for (const err of doc.errors) findings.push({ severity: 'error', kind: 'doc-parse', message: err.message, file: FEATURE_FLAGS_DOC, line: err.line });

  const policyStart = parseIsoDate(POLICY_START_DATE)!;
  for (const row of doc.rows) {
    if (row.table === 'open-shadows' || row.table === 'kill-switches') {
      validateExpiringRow(row, {}, policyStart, findings, warnings, now);
    }
  }
  if (doc.shadowCount > MAX_OPEN_SHADOWS) {
    findings.push({
      severity: 'error',
      kind: 'too-many-shadows',
      message: `too many open shadow modes: ${doc.shadowCount} > ${MAX_OPEN_SHADOWS}. Retire one before adding a new one.`,
      file: FEATURE_FLAGS_DOC,
    });
  }

  // --- baseline ---
  const baselineAbs = join(repoDir, FEATURE_FLAGS_BASELINE_FILE);
  const baselineContent = options.baselineContent ?? (existsSync(baselineAbs) ? readFile(baselineAbs) : '');
  const baseline = parseBaseline(baselineContent);
  for (const name of baseline.missingReason) {
    findings.push({ severity: 'error', kind: 'baseline-missing-reason', message: `baseline entry ${name} has no "# reason"`, file: FEATURE_FLAGS_BASELINE_FILE });
  }

  // Any baseline entry whose name matches a kill-switch shape is a bug.
  for (const entry of baseline.entries) {
    if (KILL_SWITCH_PATTERN.test(entry.name)) {
      findings.push({
        severity: 'error',
        kind: 'baseline-kill-switch',
        message: `baseline entry ${entry.name} matches the kill-switch pattern — it must have a doc row, not a baseline entry`,
        file: FEATURE_FLAGS_BASELINE_FILE,
      });
    }
  }

  // --- scan code ---
  const files = options.files ?? listTrackedFiles(repoDir);
  const docNames = doc.rows.map((r) => ({ name: r.name, isPrefix: r.isPrefix }));
  const baselineNames = baseline.entries.map((e) => ({ name: e.name, isPrefix: e.isPrefix }));

  const foundTokens = new Set<string>();
  let scanned = 0;
  let tokenCount = 0;
  for (const file of files) {
    if (!isScanned(file)) continue;
    const abs = join(repoDir, file);
    let source: string;
    try {
      source = readFile(abs);
    } catch {
      continue;
    }
    scanned += 1;
    const toks = scanFileForTokens(file, source);
    tokenCount += toks.length;
    for (const t of toks) {
      foundTokens.add(t.token);
      if (matchesRowOrBaseline(t.token, docNames)) continue;
      if (matchesRowOrBaseline(t.token, baselineNames)) continue;
      findings.push({
        severity: 'error',
        kind: 'undocumented-token',
        message: `token \`${t.token}\` has no entry in ${FEATURE_FLAGS_DOC} or ${FEATURE_FLAGS_BASELINE_FILE}`,
        file: t.file,
        line: t.line,
      });
    }
  }

  // Baseline entries that no longer appear in code.
  for (const entry of baseline.entries) {
    const present = entry.isPrefix
      ? Array.from(foundTokens).some((t) => t.startsWith(entry.name))
      : foundTokens.has(entry.name);
    if (!present) {
      findings.push({
        severity: 'error',
        kind: 'baseline-stale',
        message: `baseline entry ${entry.name} no longer appears in code — remove it (the baseline only shrinks)`,
        file: FEATURE_FLAGS_BASELINE_FILE,
      });
    }
    // An entry that also has a doc row is a ratchet violation.
    for (const row of doc.rows) {
      if (row.name === entry.name) {
        findings.push({
          severity: 'error',
          kind: 'baseline-duplicate',
          message: `${entry.name} has both a baseline entry and a doc row — remove the baseline entry`,
          file: FEATURE_FLAGS_BASELINE_FILE,
        });
        break;
      }
    }
  }

  // Doc rows naming a flag that no longer appears in code. Shadow rows whose
  // switch cell is `—` or a config-key path are exempt.
  for (const row of doc.rows) {
    if (row.table === 'permanent') continue;
    const switchCell = row.cells[0] ?? '';
    const isConfigKey = /^(cleanup|harness|observer|router)\./i.test(switchCell) || switchCell === '—' || switchCell === '-';
    if (isConfigKey) continue;
    const present = row.isPrefix
      ? Array.from(foundTokens).some((t) => t.startsWith(row.name))
      : foundTokens.has(row.name);
    if (!present) {
      findings.push({
        severity: 'error',
        kind: 'doc-stale',
        message: `doc row \`${row.rawName}\` no longer appears in code — remove it`,
        file: FEATURE_FLAGS_DOC,
        line: row.lineNumber,
      });
    }
  }

  return {
    ok: findings.length === 0,
    scanned,
    tokens: tokenCount,
    shadowCount: doc.shadowCount,
    findings,
    warnings,
  };
}

export function formatFeatureFlagResult(result: FeatureFlagResult): string {
  const warnLines = result.warnings.map((w) => w.message);
  if (result.ok) {
    const lines = [
      `feature-flags: ok (${result.tokens} token(s) in ${result.scanned} file(s); ${result.shadowCount}/${MAX_OPEN_SHADOWS} open shadows)`,
      ...warnLines,
    ];
    return lines.join('\n');
  }
  const lines = [
    `feature-flags: found ${result.findings.length} problem(s):`,
    ...result.findings.map((f, i) => {
      const loc = f.file ? ` ${f.file}${f.line ? ':' + f.line : ''}` : '';
      return `${i + 1}. [${f.kind}]${loc} ${f.message}`;
    }),
    '',
    ...warnLines,
    '',
    'Every WAVEMILL_* flag goes in docs/feature-flags.md (open-shadow or kill-switch table)',
    'or, when it is permanent plumbing (SESSION, ISSUE, *_LOADED, debug-only path), in',
    `${FEATURE_FLAGS_BASELINE_FILE}. Shadow and expiring rows must name an owner issue,`,
    'a removal issue, an added date and a remove-by date <= added+30 days, extended at most',
    'once as "YYYY-MM-DD (extended from YYYY-MM-DD, HOK-123: reason)", <= 30 days more. The baseline',
    'only shrinks: an entry that no longer appears in code must be removed in the same change.',
    `Suppress a non-flag mention with: // ${SUPPRESSION_MARKER}: <reason> (or # for shell).`,
  ];
  return lines.join('\n');
}
