// allow-agent-background-work: this file *is* the agent-background-work guard;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one background-work decision invariant (HOK-3374):
 * `deriveAgentBackgroundWork` in shared/lib/task-progress.ts decides "is the
 * agent running background work" purely from process ownership — a
 * descendant of the agent process that started after it — never from command
 * names. The HOK-3222 incident (a live 54-minute test run killed because
 * `bash tests/run-related.sh` was classified "neutral" and
 * `npx tsx tools/plan-queue.test.ts` "controller") must not be reproducible.
 *
 * Shapes caught:
 * - a deleted HOK-3222 classifier symbol
 *   (`NEUTRAL_PROCESS_BASENAME_REGEX`, `isNeutralProcessCommand`,
 *   `classifyPaneProcess`, `PaneProcessClass`, `findSubstantiveAncestor`)
 *   reappearing in any scanned source;
 * - inside the body of `deriveAgentBackgroundWork` (structural): controller
 *   -regex use, command-name matching on a command/argv field, process IO
 *   (the pure function never shells out), or a second subtree index (a
 *   second probe).
 *
 * The allowlist file (tools/agent-background-work-allowlist.txt) ships empty,
 * so every scanned file must satisfy the ownership-only rule.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';
import { topLevelFunctions } from './stage-launchability-guard.ts';

/** The module whose background-work derivation the structural check pins. */
const TASK_PROGRESS_PATH = 'shared/lib/task-progress.ts';

/** The one pure background-work derivation the structural check pins. */
const DERIVE_FUNCTION_NAME = 'deriveAgentBackgroundWork';

/** Deleted HOK-3222 classifier symbols; background work is ownership-only. */
const DELETED_CLASSIFICATION_SYMBOL =
  /\b(?:NEUTRAL_PROCESS_BASENAME_REGEX|isNeutralProcessCommand|classifyPaneProcess|PaneProcessClass|findSubstantiveAncestor)\b/;

/** Controller-regex use inside the derivation (allowed only outside it). */
const CONTROLLER_PROCESS_USE = /\b(?:WAVEMILL_CONTROLLER_PROCESS_REGEX|isWavemillControllerProcess)\b/;

/** Command-name matching on a process field inside the derivation. */
const COMMAND_FIELD_MATCH = /(?:\.command|\.argv)\s*\.\s*(?:test|match|exec)\s*\(/;

/** Process IO inside the derivation — the pure function never shells out. */
const PROCESS_IO_CALL = /\b(?:safeExecFile|execFileSync|execSync|spawnSync)\s*\(|['"]ps['"]/;

/** A `childrenByPpid`-style subtree index; the body builds exactly one. */
const CHILD_INDEX_CONSTRUCTION = /new Map<[^>]*PaneProcess\s*\[\]\s*>/;

/**
 * Find forbidden shapes in the body of `deriveAgentBackgroundWork` (the
 * function signature line through the matching column-0 `}`, per the same
 * `topLevelFunctions` convention the stage-launchability guard uses).
 */
export function findNameMatchInsideDerive(sourceText: string): StructuralMatch[] {
  const lines = sourceText.split(/\r?\n/);
  const matches: StructuralMatch[] = [];
  for (const fn of topLevelFunctions(sourceText)) {
    if (fn.name !== DERIVE_FUNCTION_NAME) continue;
    // Re-derive the first body line: the signature runs from the declaration
    // to the first line ending with `{` (topLevelFunctions convention).
    let sigEnd = fn.line - 1;
    while (sigEnd < lines.length && !/\{\s*$/.test(lines[sigEnd])) sigEnd += 1;
    const firstBodyLine = sigEnd + 2;

    let childIndexCount = 0;
    fn.body.split(/\r?\n/).forEach((text, offset) => {
      const line = firstBodyLine + offset;
      if (CONTROLLER_PROCESS_USE.test(text)) {
        matches.push({
          line,
          detail: `${DERIVE_FUNCTION_NAME} must stay ownership-only: controller-regex use (HOK-3374)`,
        });
      }
      if (COMMAND_FIELD_MATCH.test(text)) {
        matches.push({
          line,
          detail: `${DERIVE_FUNCTION_NAME} must stay ownership-only: command-name matching`,
        });
      }
      if (PROCESS_IO_CALL.test(text)) {
        matches.push({
          line,
          detail: `${DERIVE_FUNCTION_NAME} is pure: no process IO inside the derivation`,
        });
      }
      if (CHILD_INDEX_CONSTRUCTION.test(text)) {
        childIndexCount += 1;
        if (childIndexCount > 1) {
          matches.push({
            line,
            detail: `${DERIVE_FUNCTION_NAME} runs one subtree traversal: a second child index is a second probe`,
          });
        }
      }
    });
  }
  return matches.sort((a, b) => a.line - b.line);
}

/**
 * The one-background-work-decision guard (HOK-3374). Its invariant source is
 * this guard module (the pattern table necessarily names the forbidden
 * shapes); the derivation it pins lives in shared/lib/task-progress.ts and is
 * covered by the structural check below.
 */
export const AGENT_BACKGROUND_WORK_GUARD: GuardSpec = {
  name: 'agent-background-work',
  findingNoun: 'background-work decision site(s) outside the ownership rule',
  suppressionMarker: 'allow-agent-background-work',
  allowlistFile: 'tools/agent-background-work-allowlist.txt',
  invariantPaths: ['shared/lib/agent-background-work-guard.ts'],
  patterns: [
    {
      name: 'deleted-classification-symbol',
      description:
        'HOK-3222 command-name classifier symbol reintroduced — background work is decided by process ownership only (deriveAgentBackgroundWork)',
      lang: 'ts',
      re: DELETED_CLASSIFICATION_SYMBOL,
    },
  ],
  structuralChecks: [
    {
      name: 'name-match-inside-derive',
      description: 'deriveAgentBackgroundWork is not ownership-only',
      paths: [TASK_PROGRESS_PATH],
      find: findNameMatchInsideDerive,
    },
  ],
  remediation: [
    'One background-work decision (HOK-3374): a process is the agent\'s work iff it is a',
    'descendant of the agent process that started after it. Never classify by command',
    'name inside deriveAgentBackgroundWork — HOK-3222 killed a live 54-minute test run',
    'that way. isWavemillControllerProcess stays scoped to HOK-3101 invariant 2 (hook',
    'writes and process trees that are not under the agent).',
  ],
};
