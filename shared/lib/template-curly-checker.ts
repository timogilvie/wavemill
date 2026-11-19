/**
 * Preflight guard: a plain string literal containing `$` + `{...}` is almost
 * always a template literal written with the wrong quotes. The scan needs the
 * TypeScript parser (comments, regexes and real template literals must not
 * fire), so it is a structural check on tools/lib/source-guard.ts, which
 * supplies file listing, suppression and the allowlist.
 */
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  checkGuardSource,
  formatGuardResult,
  runSourceGuard,
  type GuardFinding,
  type GuardResult,
  type GuardSpec,
} from '../../tools/lib/source-guard.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..', '..');

const TEMPLATE_CURLY_PATTERN = /\$\{[^}]+\}/;
const PLACEHOLDER_SYNTAX = '$' + '{...}';

export type TemplateCurlyFinding = GuardFinding;
export type TemplateCurlyResult = GuardResult;

/** Start positions of plain string literals that contain placeholder syntax. */
function findCurlyLiterals(sourceText: string, fileName: string): Array<{ line: number; column: number }> {
  if (!sourceText.includes('$' + '{')) return [];
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, scriptKindForPath(fileName));
  const matches: Array<{ line: number; column: number }> = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && TEMPLATE_CURLY_PATTERN.test(node.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      matches.push({ line: position.line + 1, column: position.character + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return matches;
}

export const TEMPLATE_CURLY_GUARD: GuardSpec = {
  name: 'template-curly',
  findingNoun: `plain string literal(s) containing ${PLACEHOLDER_SYNTAX}`,
  suppressionMarker: 'allow-template-curly',
  allowlistFile: 'tools/template-curly-allowlist.txt',
  invariantPaths: [],
  patterns: [],
  structuralChecks: [{
    name: 'string-literal-placeholder',
    description: `plain string literal contains ${PLACEHOLDER_SYNTAX}`,
    find: findCurlyLiterals,
  }],
  remediation: [
    'If interpolation was intended, switch the string to backticks.',
    `If the ${PLACEHOLDER_SYNTAX} text is literal on purpose, say so on that line or the line above.`,
  ],
  tsExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  shellExtensions: [],
  // A missed interpolation is a bug wherever it is, tests and fixtures included.
  excludedPrefixes: [],
  includeTests: true,
};

/**
 * Finds plain string literals that look like a missed template interpolation.
 */
export function checkSourceText(fileName: string, sourceText: string): TemplateCurlyFinding[] {
  return checkGuardSource(TEMPLATE_CURLY_GUARD, fileName, sourceText);
}

export function checkTemplateCurly(repoDir = defaultRepoRoot): TemplateCurlyResult {
  return runSourceGuard(TEMPLATE_CURLY_GUARD, repoDir);
}

export function formatTemplateCurly(result: TemplateCurlyResult): string {
  return formatGuardResult(TEMPLATE_CURLY_GUARD, result);
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
