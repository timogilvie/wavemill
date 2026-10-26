/**
 * Foreground-wait guard for the native command substrate (HOK-3262).
 *
 * A model that polls (`sleep 30`, `watch …`, `timeout 60 tail -f log`) spends
 * turns doing nothing and ends with `budget_exhausted`, which is charged to
 * the model. The guard refuses those argv shapes up front so the model gets
 * an actionable tool error instead of a silent turn sink.
 *
 * Operates on the argv tokens `parseCommandArgv` produces — never a regex
 * over the raw string, so `echo "sleep 60"` is not refused. `while` / `until`
 * loops need `;`, which `parseCommandArgv` already rejects as
 * `unsupported-shell-syntax`.
 */

import path from 'node:path';

/** Guard identifier recorded on transcripts and `guard_refused` events. */
export const FOREGROUND_WAIT_GUARD = 'foreground-wait';

/** `sleep` durations at or above this many seconds are refused. */
export const FOREGROUND_WAIT_FLOOR_SECONDS = 5;

export const FOREGROUND_WAIT_REFUSAL_MESSAGE =
  'Foreground waiting is refused. Run the command once with a timeout, or start it in the background and read its output later.';

export type WaitGuardDecision =
  | { refused: true; kind: 'sleep'; durationSeconds: number; floorSeconds: number }
  | { refused: true; kind: 'watch' }
  | { refused: true; kind: 'tail-f-timeout' }
  | { refused: false };

const DURATION_UNIT_SECONDS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-s', '--signal', '-k', '--kill-after']);
const TAIL_FOLLOW_FLAGS = new Set(['-f', '-F', '--follow']);

/**
 * Classify an exec argv as a foreground wait.
 *
 * Refused shapes:
 * - `sleep DURATION…` whose total is at or above the floor (`inf` included);
 * - `watch …`;
 * - `timeout DURATION tail -f …` (also `-F`, `--follow[=…]`), and any other
 *   refused shape wrapped in `timeout`.
 *
 * An unparseable `sleep` duration is not refused: the exec surfaces the error.
 */
export function classifyForegroundWait(
  argv: readonly string[],
  options: { floorSeconds?: number } = {},
): WaitGuardDecision {
  const floorSeconds = options.floorSeconds ?? FOREGROUND_WAIT_FLOOR_SECONDS;
  const program = argv[0] === undefined ? '' : path.basename(argv[0]);

  if (program === 'sleep') {
    const durationSeconds = sumSleepDurations(argv.slice(1));
    if (durationSeconds !== null && durationSeconds >= floorSeconds) {
      return { refused: true, kind: 'sleep', durationSeconds, floorSeconds };
    }
    return { refused: false };
  }

  if (program === 'watch') {
    return { refused: true, kind: 'watch' };
  }

  if (program === 'timeout') {
    const wrapped = timeoutWrappedCommand(argv.slice(1));
    if (wrapped.length === 0) return { refused: false };
    if (path.basename(wrapped[0]!) === 'tail' && wrapped.slice(1).some(isTailFollowFlag)) {
      return { refused: true, kind: 'tail-f-timeout' };
    }
    return classifyForegroundWait(wrapped, options);
  }

  return { refused: false };
}

/** Short, argv-free description of a refusal for messages and transcripts. */
export function describeWaitGuardRefusal(decision: WaitGuardDecision): string {
  if (!decision.refused) return '';
  switch (decision.kind) {
    case 'sleep': {
      const seconds = Number.isFinite(decision.durationSeconds) ? `${decision.durationSeconds}s` : 'infinity';
      return `sleep ${seconds} (>= ${decision.floorSeconds}s floor)`;
    }
    case 'watch':
      return 'watch';
    case 'tail-f-timeout':
      return 'timeout + tail -f';
  }
}

function sumSleepDurations(args: readonly string[]): number | null {
  if (args.length === 0) return null;
  let total = 0;
  for (const arg of args) {
    const seconds = parseDurationSeconds(arg);
    if (seconds === null) return null;
    total += seconds;
  }
  return total;
}

function parseDurationSeconds(token: string): number | null {
  const lowered = token.toLowerCase();
  if (lowered === 'inf' || lowered === 'infinity') return Number.POSITIVE_INFINITY;
  const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(lowered);
  if (!match) return null;
  return Number(match[1]) * DURATION_UNIT_SECONDS[match[2]!]!;
}

/** Strip `timeout`'s own options and DURATION, returning the wrapped argv. */
function timeoutWrappedCommand(args: readonly string[]): readonly string[] {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    const option = args[index]!;
    index += TIMEOUT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    if (option === '--') break;
  }
  // Skip DURATION.
  return args.slice(index + 1);
}

function isTailFollowFlag(arg: string): boolean {
  if (TAIL_FOLLOW_FLAGS.has(arg) || arg.startsWith('--follow=')) return true;
  // Bundled short options such as `-fn` / `-nF`; `-n10` style values stop at a digit.
  return /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(arg);
}
