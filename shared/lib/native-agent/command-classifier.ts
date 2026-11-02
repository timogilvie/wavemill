import { isSafePattern } from '../permission-patterns.ts';
import type { ParsedCommand } from './command-argv.ts';

export type CommandClass = 'safe' | 'dangerous';

export interface CommandClassification {
  commandClass: CommandClass;
  normalizedCommand: string;
  rejectionReason?: 'empty-command' | 'dangerous-command-pattern';
}

/**
 * Classify a parsed command using `permission-patterns.ts` as the single
 * safety dialect. The caller supplies the one `ParsedCommand` produced by
 * `parseCommandArgv` (HOK-3383); the classifier never re-tokenises a raw
 * string. The normalised form is `argv.join(' ')`, which is what the pattern
 * table matches.
 */
export function classifyCommand(parsed: ParsedCommand): CommandClassification {
  const normalizedCommand = parsed.argv.join(' ').trim();
  if (normalizedCommand.length === 0) {
    return {
      commandClass: 'dangerous',
      normalizedCommand,
      rejectionReason: 'empty-command',
    };
  }

  if (!isSafePattern(normalizedCommand)) {
    return {
      commandClass: 'dangerous',
      normalizedCommand,
      rejectionReason: 'dangerous-command-pattern',
    };
  }

  return {
    commandClass: 'safe',
    normalizedCommand,
  };
}
