// allow-command-parse: this file *is* the one-command-parse guard (HOK-3383);
// its pattern table necessarily names the forbidden shapes. It is
// auto-excluded from its own scan (see invariantPaths); the marker above is
// defensive against regex-based tooling re-scanning the guard itself.
/**
 * Preflight guard for the one-native-command-parse invariant (HOK-3383):
 * `parseCommandArgv` in shared/lib/native-agent/command-argv.ts is the single
 * parser for every `run_tests` / `run_format` guard. Downstream guards must
 * read the `ParsedCommand` it returns — never re-tokenise a command string on
 * their own, and never read `argv[0]` to decide program identity.
 *
 * This matters because `bash -c '…'` would otherwise sail past every guard
 * that only looks at the top-level argv: the full-suite refusal (HOK-3145),
 * the rerun-after-timeout refusal, and the foreground-wait refusal (HOK-3262).
 * The HOK-3374 attempt-2 incident lost a native coder's budget this way.
 *
 * Shapes caught:
 * - a bare `argv[0]` read in files under shared/lib/native-agent/ (use
 *   `parsed.program` / `parsed.programPath` / `parsed.programArgs` instead);
 * - importing a third-party shell tokeniser (shell-quote, shlex) — the one
 *   parser is `parseCommandArgv`.
 *
 * The allowlist file (tools/command-parse-allowlist.txt) only contains sites
 * that read `argv[0]` on a non-run-tests argv (e.g. coding-recovery-guard's
 * `git` subcommand check), where the one-parse rule does not apply.
 */
import type { GuardSpec } from '../tools/lib/source-guard.ts';

/** Reading argv[0] outside the parser is forbidden — use parsed.program. */
const ARGV_ZERO_READ = /\bargv\s*\[\s*0\s*\]/;

/** Pulling in a third-party shell tokeniser bypasses the one parser. */
const THIRD_PARTY_SHELL_TOKENIZER =
  /\bfrom\s+['"](?:shell-quote|shlex|minimist|yargs-parser)['"]|\brequire\(\s*['"](?:shell-quote|shlex|minimist|yargs-parser)['"]/;

export const COMMAND_PARSE_GUARD: GuardSpec = {
  name: 'command-parse',
  findingNoun: 'ad-hoc command parse site(s) outside parseCommandArgv',
  suppressionMarker: 'allow-command-parse',
  allowlistFile: 'tools/command-parse-allowlist.txt',
  invariantPaths: [
    'shared/lib/native-agent/command-argv.ts',
    'shared/lib/command-parse-guard.ts',
  ],
  // The parse rule applies to the native command substrate (where
  // `run_tests` / `run_format` live). Non-native-agent callers rarely read
  // `argv[0]`, and when they do they are on an unrelated argv (process.argv,
  // git subcommand parsing) — those sites use the per-line suppression marker
  // or an allowlist entry. Default `excludedPrefixes` apply.
  patterns: [
    {
      name: 'argv-zero-read-outside-parser',
      description:
        'reading argv[0] outside the one parser is forbidden — use ParsedCommand.program / programPath / programArgs (HOK-3383)',
      lang: 'ts',
      re: ARGV_ZERO_READ,
    },
    {
      name: 'third-party-shell-tokenizer',
      description:
        'the one command tokeniser is parseCommandArgv in command-argv.ts — never import an external shell parser',
      lang: 'ts',
      re: THIRD_PARTY_SHELL_TOKENIZER,
    },
  ],
  remediation: [
    'One command parse (HOK-3383): every native run_tests / run_format guard reads one',
    'ParsedCommand from parseCommandArgv instead of re-tokenising a command string or',
    'reading argv[0] on its own. A bash -c \'…\' wrapper is caught at parse time and',
    'returned as unsupported-shell-syntax; downstream guards consume parsed.program /',
    'parsed.programPath / parsed.programArgs.',
  ],
};
