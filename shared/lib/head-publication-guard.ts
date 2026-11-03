// allow-head-publication: this file *is* the head-publication guard; its
// pattern table necessarily names every forbidden shape. It is auto-excluded
// from its own scan (invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-head-move-record invariant (HOK-3370):
 * exactly one publication seam (`publishStageHead`, branch-publication.ts)
 * and one head-freshness primitive (change-identity.ts).
 *
 * Shapes caught:
 * - a `git push` instruction in agent prompts/commands or mill shell/TS code
 *   outside the seam. Agents commit; **the mill publishes** at stage exit.
 *   The HOK-3361 incident needed three operator touches because agents were
 *   prompted to push and silently didn't.
 * - a raw head-SHA freshness comparison (`!== currentHeadSha`-shaped TS,
 *   `"$review_head" != ...`-shaped shell) outside change-identity.ts.
 *   Evidence binds to the change identity; a base merge or clean rebase
 *   keeps review evidence, only a code-changing commit stales it.
 *
 * Justified survivors live in tools/head-publication-allowlist.txt with a
 * reason: tend's force-with-lease rebase push (HOK-3105 rebind semantics),
 * the promotion flow's integration-branch push (no task state dir), branch
 * deletions (not head moves), and permission-pattern string literals.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/**
 * A push of a branch head. `git push --delete` removes a ref (not a head
 * move) and is excluded by the lookahead.
 */
const GIT_PUSH_INSTRUCTION = /\bgit\s+push\b(?!.*--delete)/;

/** Raw TS freshness comparison against the current head SHA. */
const TS_RAW_HEAD_FRESHNESS = /!==?\s*(?:input\.)?currentHeadSha\b|\bcurrentHeadSha\s*!==?\s*/;

/**
 * Raw shell freshness comparison on recorded review/capsule evidence heads.
 * Scoped to the evidence variables the monitor uses so ordinary head reads
 * (`git rev-parse HEAD`) never fire.
 */
const SHELL_RAW_HEAD_FRESHNESS =
  /"\$\{?(?:review_head|capsule_head|capsule_review_head)\}?"\s*[!=]=|[!=]=\s*"\$\{?(?:review_head|capsule_head|capsule_review_head)\}?"/;

/**
 * The one-head-move-record guard (HOK-3370). The seam and the primitive are
 * the invariant source; markdown prompt templates are scanned with shell
 * comment semantics (a `#` heading is not an instruction).
 */
export const HEAD_PUBLICATION_GUARD: GuardSpec = {
  name: 'head-publication',
  findingNoun: 'head publication(s) or raw head-freshness comparison(s) outside the seam',
  suppressionMarker: 'allow-head-publication',
  allowlistFile: 'tools/head-publication-allowlist.txt',
  invariantPaths: [
    'shared/lib/head-publication-guard.ts',
    'shared/lib/branch-publication.ts',
    'shared/lib/change-identity.ts',
    'shared/lib/head-move-record.ts',
  ],
  // Prompts are markdown; scan them with shell comment semantics. Operator
  // and workflow documentation is not a mill prompt surface.
  shellExtensions: ['.sh', '.bash', '.md'],
  excludedPrefixes: [
    'tests/',
    'features/',
    '.wavemill/',
    'node_modules/',
    'worktrees/',
    'spike/',
    '.git/',
    'shared/validators/',
    // Human-facing documentation and interactive command/skill guides are
    // not mill agent prompts.
    'docs/',
    'skills/',
    'commands/',
    '.claude/',
  ],
  patterns: [
    {
      name: 'push-outside-seam',
      description:
        'branch publication outside the one seam — agents commit, the mill publishes through publishStageHead (publish_stage_head / tools/publish-stage-head.ts)',
      lang: 'both',
      re: GIT_PUSH_INSTRUCTION,
    },
    {
      name: 'raw-head-freshness-ts',
      description:
        'raw head-SHA freshness comparison — evidence freshness is decided by isEvidenceFresh (shared/lib/change-identity.ts), never by SHA equality',
      lang: 'ts',
      re: TS_RAW_HEAD_FRESHNESS,
    },
    {
      name: 'raw-head-freshness-shell',
      description:
        'raw review/capsule head comparison — use change_identity_fresh (wavemill-common.sh), never a SHA equality test',
      lang: 'sh',
      re: SHELL_RAW_HEAD_FRESHNESS,
    },
  ],
  remediation: [
    'One head-move record (HOK-3370): every task-branch head move is published by the',
    'mill through publishStageHead (shared/lib/branch-publication.ts), which appends a',
    'head-move/v1 row and shadow-records the push. Agent prompts never instruct a push.',
    'Evidence freshness is the change identity (shared/lib/change-identity.ts):',
    'isEvidenceFresh in TS, change_identity_fresh in shell — never a raw SHA compare.',
  ],
};
