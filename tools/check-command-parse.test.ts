import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkGuardSource } from './lib/source-guard.ts';
import { COMMAND_PARSE_GUARD } from '../shared/lib/command-parse-guard.ts';

describe('check-command-parse guard', () => {
  // protects: command-parse guard failing to catch argv[0] reads
  it('fires on a plain argv[0] read', () => {
    const source = [
      'import type { ParsedCommand } from "./command-argv.ts";',
      '',
      'export function classifyThing(argv: readonly string[]): string {',
      '  if (argv[0] === "bash") return "shell";',
      '  return "other";',
      '}',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.ts', source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.pattern, 'argv-zero-read-outside-parser');
    assert.equal(findings[0]!.line, 4);
  });

  // protects: suppression marker falling off the right line
  it('honours the inline suppression marker on the same line', () => {
    const source = [
      'export function f(argv: readonly string[]): string {',
      '  if (argv[0] === "bash") return "shell"; // allow-command-parse: tool is not run_tests',
      '  return "other";',
      '}',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.ts', source);
    assert.equal(findings.length, 0);
  });

  it('honours the inline suppression marker on the line above', () => {
    const source = [
      'export function f(argv: readonly string[]): string {',
      '  // allow-command-parse: tool is not run_tests',
      '  if (argv[0] === "bash") return "shell";',
      '  return "other";',
      '}',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.ts', source);
    assert.equal(findings.length, 0);
  });

  // protects: comment-only mentions tripping the guard
  it('ignores argv[0] mentions in whole-line comments', () => {
    const source = [
      '// argv[0] is the program name — but reading it directly bypasses the parse',
      '/* argv[0] is parsed.program */',
      '* argv[0] in a jsdoc tag',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.ts', source);
    assert.equal(findings.length, 0);
  });

  // protects: a third-party shell tokeniser slipping in
  it('fires on importing a third-party shell tokeniser', () => {
    const source = [
      'import { parse } from "shell-quote";',
      '',
      'export const x = parse("foo bar");',
      '',
    ].join('\n');
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.ts', source);
    const names = findings.map((f) => f.pattern);
    assert.ok(names.includes('third-party-shell-tokenizer'), JSON.stringify(names));
  });

  // protects: `.sh` scripts being scanned by a TS-only pattern
  it('does not fire on shell scripts', () => {
    const source = 'argv[0] in a shell script\n';
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/foo.sh', source);
    assert.equal(findings.length, 0);
  });

  // protects: test files being scanned (they are allowed to use argv[0])
  it('skips test files', () => {
    const source = 'if (argv[0] === "bash") return;\n';
    const findings = checkGuardSource(COMMAND_PARSE_GUARD, 'shared/lib/native-agent/example.test.ts', source);
    // checkGuardSource bypasses the global isExcluded, but the invariant source
    // itself is scanned per-call. For test files, the guard's test-skip is
    // enforced by runSourceGuard's include-tests gate, not per-call: here we
    // simply assert the regex itself still matches, documenting that the
    // skip happens one layer up. Keeping this behavioural guarantee in a test
    // avoids a silent regression if the skip rule moves.
    assert.equal(findings.length, 1);
  });
});
