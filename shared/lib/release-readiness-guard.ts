// allow-release-readiness-grammar: this file *is* the Release Readiness guard;
// its pattern names the forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the Release Readiness grammar invariant (HOK-3499,
 * enforced by HOK-3236): "what does this plan's Release Readiness section
 * say?" has exactly one answer, parsed by `extractReleaseReadiness` in
 * `shared/lib/task-packet-utils.ts`.
 *
 * Three private grammars (the planning gate, the task-packet validator and the
 * consumer) is how the HOK-3406 planning gate came to reject a plan the
 * consumer would have read with one fix: the gate required `**field**:`, the
 * model emitted `**field:**`.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';
import { RELEASE_READINESS_FIELDS } from './task-packet-utils.ts';

/**
 * Matches an escaped-bold regex literal naming a required field, e.g.
 * `/\*\*database_change_risk\*\*:\s*(\S+)/`. The field alternation is derived
 * from the canonical list so a new required field cannot be forgotten here.
 */
const FORBIDDEN_FIELD_REGEX = new RegExp(
  String.raw`\\\*\\\*(?:${RELEASE_READINESS_FIELDS.join('|')})`,
);

export const RELEASE_READINESS_GUARD: GuardSpec = {
  name: 'release-readiness-grammar',
  invariantDocs: ['docs/invariants/release-readiness-grammar.md'],
  findingNoun: 'private Release Readiness field regex(es)',
  suppressionMarker: 'allow-release-readiness-grammar',
  allowlistFile: 'tools/release-readiness-allowlist.txt',
  invariantPaths: [
    'shared/lib/task-packet-utils.ts',
    'shared/lib/release-readiness-guard.ts',
  ],
  patterns: [
    {
      name: 'private-release-readiness-field-regex',
      description: 'escaped-bold Release Readiness field regex outside task-packet-utils.ts — call extractReleaseReadiness instead',
      lang: 'ts',
      re: FORBIDDEN_FIELD_REGEX,
      excludePaths: ['shared/lib/task-packet-utils.ts'],
    },
  ],
  remediation: [
    'extractReleaseReadiness in shared/lib/task-packet-utils.ts is the only Release Readiness grammar.',
    'It accepts **field**: and **field:** bullets and reports missing fields in `missingFields`.',
    'The planning gate, the task-packet validator and the ready-stage consumer all call it.',
    'Never author a second field regex; use the parsed fields or `missingFields`.',
  ],
};
