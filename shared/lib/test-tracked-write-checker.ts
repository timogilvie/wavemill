import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');
const SUPPRESSION_MARKER = 'allow-tracked-write';
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Mutators whose first argument is a path we care about. These are matched
// against the callee's identifier text (either a bare name or the trailing
// property name of a member expression like `fs.writeFileSync`).
const MUTATORS_FIRST_ARG = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'rmSync',
  'rm',
  'unlinkSync',
  'unlink',
  'truncateSync',
  'truncate',
]);

// Mutators where the second argument is also a destination path we care about.
const MUTATORS_TWO_ARGS = new Set([
  'renameSync',
  'rename',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'cp',
]);

export interface TrackedWriteFinding {
  file: string;
  line: number;
  column: number;
  callee: string;
  path: string;
}

export interface TrackedWriteResult {
  ok: boolean;
  scannedFiles: number;
  findings: TrackedWriteFinding[];
}

export function checkSourceText(
  fileName: string,
  sourceText: string,
  trackedPaths: Set<string>,
): TrackedWriteFinding[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForPath(fileName),
  );
  const lines = sourceText.split(/\r?\n/);
  const findings: TrackedWriteFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = extractCalleeName(node.expression);
      if (calleeName) {
        const checkFirst = MUTATORS_FIRST_ARG.has(calleeName) || MUTATORS_TWO_ARGS.has(calleeName);
        if (checkFirst) {
          maybeReport(node, 0, calleeName);
        }
        if (MUTATORS_TWO_ARGS.has(calleeName)) {
          maybeReport(node, 1, calleeName);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  function maybeReport(call: ts.CallExpression, argIndex: number, calleeName: string): void {
    const arg = call.arguments[argIndex];
    if (!arg) return;
    const literalText = extractLiteralString(arg);
    if (literalText === null) return;

    const normalized = normalizeRelPath(literalText);
    if (!normalized) return;
    if (!trackedPaths.has(normalized)) return;

    const start = arg.getStart(sourceFile);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    const line = position.line + 1;
    if (isSuppressed(lines, line)) return;

    findings.push({
      file: normalizePath(fileName),
      line,
      column: position.character + 1,
      callee: calleeName,
      path: normalized,
    });
  }

  visit(sourceFile);
  return findings;
}

export function checkTestTrackedWrites(repoDir = defaultRepoRoot): TrackedWriteResult {
  const tracked = listTrackedPaths(repoDir);
  const trackedSet = new Set(tracked);
  const testFiles = tracked.filter((p) => TEST_FILE_PATTERN.test(p));

  const findings: TrackedWriteFinding[] = [];
  let scannedFiles = 0;

  for (const file of testFiles) {
    const fullPath = join(repoDir, file);
    if (!existsSync(fullPath)) continue;

    const sourceText = readSourceFile(fullPath);
    scannedFiles += 1;
    if (sourceText === null) continue;
    // Cheap prefilter: skip files that don't name any mutator at all.
    if (!containsAnyMutator(sourceText)) continue;

    findings.push(...checkSourceText(file, sourceText, trackedSet));
  }

  return {
    ok: findings.length === 0,
    scannedFiles,
    findings,
  };
}

export function formatTestTrackedWrites(result: TrackedWriteResult): string {
  if (result.ok) {
    return `test-tracked-writes: ok (${result.scannedFiles} test files scanned)`;
  }

  return [
    `test-tracked-writes: found ${result.findings.length} write(s) to tracked repo path(s):`,
    ...result.findings.map((f, i) => (
      `${i + 1}. ${f.file}:${f.line}:${f.column} ${f.callee}('${f.path}')`
    )),
    '',
    'Tests must not write tracked repo files (HOK-3157): a killed run skips cleanup and',
    'leaves the worktree dirty, parking the coding handoff. Write to a mkdtemp dir and',
    'inject the path (e.g. templatePath).',
    `If a tracked path write is intentional, add a nearby comment: // ${SUPPRESSION_MARKER}: <reason>`,
  ].join('\n');
}

function extractCalleeName(expr: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function extractLiteralString(arg: ts.Node): string | null {
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null;
}

function normalizeRelPath(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith('/')) return null;
  if (raw.includes('://')) return null;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('..')) return null;
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function listTrackedPaths(repoDir: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean);
}

function readSourceFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function containsAnyMutator(sourceText: string): boolean {
  for (const name of MUTATORS_FIRST_ARG) {
    if (sourceText.includes(name)) return true;
  }
  for (const name of MUTATORS_TWO_ARGS) {
    if (sourceText.includes(name)) return true;
  }
  return false;
}

function isSuppressed(lines: string[], oneBasedLine: number): boolean {
  const currentLine = lines[oneBasedLine - 1] ?? '';
  const previousLine = lines[oneBasedLine - 2] ?? '';
  return currentLine.includes(SUPPRESSION_MARKER) || previousLine.includes(SUPPRESSION_MARKER);
}

function scriptKindForPath(fileName: string): ts.ScriptKind {
  switch (path.extname(fileName)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function normalizePath(fileName: string): string {
  return fileName.split(path.sep).join(path.posix.sep);
}
