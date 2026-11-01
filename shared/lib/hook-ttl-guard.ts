// allow-hook-ttl: this file *is* the task-progress guard module; its pattern
// tables name every forbidden shape. Both specs exported here auto-exclude
// this file from their own scans (see invariantPaths); the marker above is
// defensive.
/**
 * Preflight guards for the task progress/liveness primitive
 * shared/lib/task-progress.{ts,sh}.
 *
 * HOOK_TTL_GUARD — the task progress/liveness invariant (HOK-3101, enforced
 * by HOK-3236): liveness is derived by the one primitive —
 * `wavemill_hook_read --fresh` / `task_progress_json` in shell,
 * `deriveTaskProgress` / `readHookFile` in TS. A private TTL check (read the
 * hook's `.timestamp`, compare against 300s) ignores the primitive's three
 * invariants: pane existence is not progress, monitor writes are not agent
 * evidence, and the agent's own idle survives later monitor writes.
 *
 * Shapes caught:
 * - the TTL constant (`HOOK_TTL_SECONDS` / `WAVEMILL_HOOK_TTL_SECONDS`) used
 *   outside the primitive — doing the freshness math yourself;
 * - a jq read of `.timestamp` straight out of a hook file;
 * - a hard-coded 300s comparison on a hook / staleness / timestamp line.
 *
 * AGENT_BACKGROUND_WORK_GUARD — the one background-work decision invariant
 * (HOK-3374): `deriveAgentBackgroundWork` decides "is the agent running
 * background work" purely from process ownership — a descendant of the agent
 * process that started after it — never from command names. The HOK-3222
 * incident (a live 54-minute test run killed because
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
 * Pre-existing hook-TTL sites are held by a count ratchet in
 * tools/hook-ttl-allowlist.txt, so a new private check in the same file still
 * fails. The background-work guard needs no allowlist: its allowlist file
 * (tools/agent-background-work-allowlist.txt) does not exist yet, which
 * source-guard reads as an empty allowlist — every scanned file must satisfy
 * the ownership-only rule.
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';
import { topLevelFunctions } from './stage-launchability-guard.ts';

export const HOOK_TTL_GUARD: GuardSpec = {
  name: 'hook-ttl',
  findingNoun: 'private hook-TTL liveness check(s)',
  suppressionMarker: 'allow-hook-ttl',
  allowlistFile: 'tools/hook-ttl-allowlist.txt',
  invariantPaths: [
    'shared/lib/task-progress.ts',
    'shared/lib/task-progress.sh',
    'shared/lib/hook-ttl-guard.ts',
  ],
  patterns: [
    {
      name: 'hook-ttl-constant',
      description: 'hook TTL constant outside the primitive — use wavemill_hook_read --fresh / task_progress_json / deriveTaskProgress',
      lang: 'both',
      re: /\b(?:WAVEMILL_)?HOOK_TTL_SECONDS\b/,
    },
    {
      name: 'raw-hook-timestamp-read',
      description: 'jq read of `.timestamp` from a hook file — use wavemill_hook_read (add --agent-only for the agent record)',
      lang: 'sh',
      re: /['"]\.(?:agentRecord\.)?timestamp\b[^'"]*['"]\s+"?\$\{?hook/,
    },
    {
      name: 'hook-ttl-literal',
      description: 'hard-coded 300s freshness comparison on a hook/staleness line — the TTL belongs to the task-progress primitive',
      lang: 'both',
      re: /^(?=.*\b(?:hook\w*|staleness|timestamp)\b).*?(?:<=?|>=?|-lt|-le|-gt|-ge)\s*300(?:_?000)?\b/i,
    },
  ],
  remediation: [
    'Every liveness decision goes through the task-progress primitive (HOK-3101):',
    'wavemill_hook_read / task_progress_json in shell, deriveTaskProgress / readHookFile in',
    'TypeScript. Never re-derive liveness from a private hook-timestamp TTL check.',
  ],
};

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
 * The one-background-work-decision guard (HOK-3374). Unlike HOOK_TTL_GUARD,
 * this spec scans shared/lib/task-progress.ts (its invariant source is this
 * guard module, not the primitive).
 */
export const AGENT_BACKGROUND_WORK_GUARD: GuardSpec = {
  name: 'agent-background-work',
  findingNoun: 'background-work decision site(s) outside the ownership rule',
  suppressionMarker: 'allow-agent-background-work',
  allowlistFile: 'tools/agent-background-work-allowlist.txt',
  invariantPaths: ['shared/lib/hook-ttl-guard.ts'],
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
