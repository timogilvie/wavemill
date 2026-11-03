// allow-command-parse: this file *is* the one command parser (HOK-3383);
// its body necessarily names and reads argv[0] to resolve the program. It is
// auto-excluded from its own scan via invariantPaths; the marker is defensive.
import path from 'node:path';

/**
 * One parsed command shape (HOK-3383): every native `run_tests` / `run_format`
 * guard reads this value instead of re-tokenising a command string or reading
 * `argv[0]` on its own. `program` is the resolved basename after stripping a
 * leading `env`; `programPath` is the same token with its original directory
 * (useful for scope checks that resolve a path against the worktree root);
 * `programArgs` is `argv` after the program.
 */
export interface ParsedCommand {
  argv: string[];
  /** Resolved program basename, with a leading `env` stripped. */
  program: string;
  /** Resolved program token with its original directory, e.g. `./tests/run-related.sh`. */
  programPath: string;
  /** `argv` after `program` — never the whole argv, so no guard needs `argv[0]`. */
  programArgs: string[];
}

export type ParseCommandArgvResult =
  | { ok: true; parsed: ParsedCommand }
  | { ok: false; reason: 'unsupported-shell-syntax'; detail: string };

/** Shell interpreters whose `-c` / `-lc` form smuggles a nested shell script past the parser. */
const SHELL_INTERPRETER_BASENAMES = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * Parse a command string into exec argv using the POSIX shell's quoting rules
 * for plain words, while rejecting syntax that would require a real shell.
 *
 * Also rejects a shell-interpreter wrapper (`sh|bash|zsh|dash` with `-c`/`-lc`,
 * optionally via `env`), because the inner script is a shell script and the
 * tool contract is that commands run without a shell (HOK-3383).
 */
export function parseCommandArgv(command: string): ParseCommandArgvResult {
  const argv: string[] = [];
  let current = '';
  let wordStarted = false;
  let state: 'unquoted' | 'single' | 'double' = 'unquoted';
  let pendingEscape = false;

  const flushWord = () => {
    if (wordStarted) {
      argv.push(current);
      current = '';
      wordStarted = false;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (state === 'single') {
      if (char === "'") {
        state = 'unquoted';
      } else {
        current += char;
      }
      continue;
    }

    if (state === 'double') {
      if (pendingEscape) {
        if (char === '"' || char === '\\' || char === '$' || char === '`') {
          current += char;
        } else {
          current += `\\${char}`;
        }
        pendingEscape = false;
        wordStarted = true;
        continue;
      }
      if (char === '\\') {
        pendingEscape = true;
        wordStarted = true;
        continue;
      }
      if (char === '"') {
        state = 'unquoted';
        continue;
      }
      if (char === '$' || char === '`') {
        return unsupported(char);
      }
      current += char;
      wordStarted = true;
      continue;
    }

    if (pendingEscape) {
      current += char;
      wordStarted = true;
      pendingEscape = false;
      continue;
    }

    if (char === ' ' || char === '\t') {
      flushWord();
      continue;
    }
    if (char === '\\') {
      pendingEscape = true;
      wordStarted = true;
      continue;
    }
    if (char === "'") {
      state = 'single';
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      state = 'double';
      wordStarted = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      return unsupported('newline');
    }
    if (char === '$' || char === '`') {
      return unsupported(char);
    }
    if (char === '|' || char === '&' || char === ';' || char === '<' || char === '>') {
      return unsupported(readOperator(command, index));
    }
    if (isRedirectFdPrefix(command, index)) {
      return unsupported(readFdRedirect(command, index));
    }

    current += char;
    wordStarted = true;
  }

  if (state !== 'unquoted' || pendingEscape) {
    return unsupported(state === 'single' ? 'unterminated quote' : pendingEscape ? 'unterminated escape' : 'unterminated quote');
  }
  flushWord();
  if (argv.length === 0) {
    return unsupported('empty command');
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) {
    return unsupported('leading environment assignment');
  }

  const resolution = resolveProgram(argv);
  if (resolution === null) {
    return unsupported('env missing a program');
  }
  if (SHELL_INTERPRETER_BASENAMES.has(resolution.program) && hasInlineScriptFlag(resolution.programArgs)) {
    return unsupported('shell interpreter wrapper');
  }

  return {
    ok: true,
    parsed: {
      argv,
      program: resolution.program,
      programPath: resolution.programPath,
      programArgs: resolution.programArgs,
    },
  };
}

/**
 * Build a `ParsedCommand` from an already-tokenised argv slice (no string
 * parse). Used by the wait guard when it recurses into a `timeout …` wrapper,
 * which only has to re-resolve the program — never re-tokenise.
 *
 * Returns `null` when the slice is empty or would itself be a shell wrapper.
 */
export function parsedCommandFromArgv(argv: readonly string[]): ParsedCommand | null {
  if (argv.length === 0) return null;
  const resolution = resolveProgram(argv);
  if (resolution === null) return null;
  if (SHELL_INTERPRETER_BASENAMES.has(resolution.program) && hasInlineScriptFlag(resolution.programArgs)) {
    return null;
  }
  return {
    argv: [...argv],
    program: resolution.program,
    programPath: resolution.programPath,
    programArgs: resolution.programArgs,
  };
}

/** Treat only a bare `env` (or `/path/to/env`) as the env wrapper, not `envsubst` or similar. */
function isEnvInvocation(token: string): boolean {
  if (token === 'env') return true;
  return path.basename(token) === 'env' && (token.includes('/') || token === 'env');
}

/**
 * Resolve `program` and `programArgs` from an argv. When `argv[0]` is `env`,
 * step over its options until a positional (the real program) is found.
 * Returns `null` when `env` was named but no positional follows.
 */
function resolveProgram(argv: readonly string[]): { program: string; programPath: string; programArgs: string[] } | null {
  const head = argv[0]!;
  if (!isEnvInvocation(head)) {
    return { program: path.basename(head), programPath: head, programArgs: argv.slice(1) };
  }
  // Walk past env's own options to find the first positional. A leading
  // `KEY=val` assignment is already rejected above (the parse never gets this
  // far with one), so a token containing `=` here is one of env's option values
  // (e.g. `--chdir=…`) — skip and continue.
  const WITH_VALUE = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
  let i = 1;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === '--') {
      i += 1;
      break;
    }
    if (!token.startsWith('-')) break;
    i += WITH_VALUE.has(token) ? 2 : 1;
  }
  if (i >= argv.length) return null;
  const programToken = argv[i]!;
  return { program: path.basename(programToken), programPath: programToken, programArgs: argv.slice(i + 1) };
}

/**
 * A short-option clump containing `c` (`-c`, `-lc`, `-ic`, `-xc`, …) among the
 * shell's own options — the inline-script marker. Only options **before** the
 * first non-option argument count: once a script name (or `--`) appears, every
 * remaining token is passed to the script itself, so `bash tests/foo.sh -c x`
 * is not a shell wrapper.
 *
 * Covers the HOK-3374 incident's `bash -c '…'` / `bash -lc '…'` forms and any
 * other clumping an agent might try (`-xc` with xtrace, `-ic` interactive).
 */
function hasInlineScriptFlag(programArgs: readonly string[]): boolean {
  for (const token of programArgs) {
    if (token === '--') return false; // options end here; everything after is script argv
    if (token.length < 2 || !token.startsWith('-')) return false; // first non-option — options end here too
    if (token.startsWith('--')) continue; // skip long options like --login
    const clump = token.slice(1);
    if (/^[A-Za-z]+$/.test(clump) && clump.includes('c')) return true;
  }
  return false;
}

function unsupported(detail: string): ParseCommandArgvResult {
  return { ok: false, reason: 'unsupported-shell-syntax', detail };
}

function readOperator(command: string, index: number): string {
  const two = command.slice(index, index + 2);
  const three = command.slice(index, index + 3);
  if (three === '<<<') {
    return three;
  }
  if (two === '&&' || two === '||' || two === '>>' || two === '<<' || two === '&>') {
    return two;
  }
  return command[index]!;
}

function isRedirectFdPrefix(command: string, index: number): boolean {
  return /[0-9]/.test(command[index] ?? '') && /[<>]/.test(command[index + 1] ?? '');
}

function readFdRedirect(command: string, index: number): string {
  let end = index;
  while (/[0-9]/.test(command[end] ?? '')) {
    end += 1;
  }
  if (command[end] === '>' && command[end + 1] === '&') {
    end += 2;
    while (/[0-9-]/.test(command[end] ?? '')) {
      end += 1;
    }
    return command.slice(index, end);
  }
  if (command[end] === '>' && command[end + 1] === '>') {
    return command.slice(index, end + 2);
  }
  return command.slice(index, end + 1);
}
