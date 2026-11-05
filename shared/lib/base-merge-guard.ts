// allow-base-merge: this file *is* the base-merge guard; its pattern table
// necessarily names every forbidden shape. It is auto-excluded from its own
// scan (invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-base-merge-executor invariant (HOK-3385):
 * exactly one implementation brings a task branch up to date with its base —
 * `updateBranchWithBase` (shared/lib/promotion-controller.ts). The mill runs
 * the merge; a conflict resolver agent only resolves the conflicted files.
 *
 * Shapes caught:
 * - a `git fetch` / `git merge` / `git rebase` instruction in an agent prompt
 *   surface (agent-adapters.sh `build_*_prompt` heredocs, `tools/prompts/`
 *   markdown). The HOK-3374 incident launched a native resolver twice against
 *   a prompt telling it to `git fetch` + `git merge` — tools the native
 *   runtime does not have — spending the conflict budget on launches that
 *   could never succeed.
 * - a mill-side `git merge` / `git rebase` execution outside the one
 *   primitive. New base-integration movers (HOK-3347) must call
 *   `updateBranchWithBase`, never a private shell merge.
 *
 * Justified survivors live in tools/base-merge-allowlist.txt with a reason:
 * tend's lane rebase (HOK-3105; its strategy belongs to HOK-3347/HOK-3370,
 * and its conflict hand-off already converges on the mill merge).
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/**
 * An agent-facing instruction line: `git fetch|merge|rebase ...` at the start
 * of a line (optionally numbered), the shape prompt heredocs and markdown
 * templates use. `git merge-base` / `git merge-tree` do not match (no space
 * after the subcommand).
 */
const PROMPT_MERGE_INSTRUCTION = /^\s*(?:\d+\.\s+)?git\s+(?:fetch|merge|rebase)\s/;

/**
 * A prose-embedded instruction to integrate the base, e.g. "(git rebase
 * origin/$base_branch)". Scoped to shapes naming `origin` so ordinary
 * mill-side plumbing (`git fetch --quiet origin ...`) never fires.
 */
const BASE_INTEGRATION_INSTRUCTION = /\bgit\s+(?:fetch|merge|rebase)\s+origin\b/;

/**
 * A quoted mill-side `git merge` / `git rebase` execution in TS, or a bare
 * one in shell. Base merges belong to `updateBranchWithBase`; `merge-base`,
 * `merge-tree` and `git merge*` permission-pattern literals do not match.
 */
const MILL_MERGE_TS = /['"`]git\s+(?:-C\s+\S+\s+)?(?:merge|rebase)\s/;
const MILL_MERGE_SH = /\bgit\s+(?:-C\s+\S+\s+)?(?:merge|rebase)\s/;

/**
 * The one-base-merge-executor guard (HOK-3385). The primitive is the
 * invariant source; markdown prompt templates are scanned with shell comment
 * semantics (a `#` heading is not an instruction).
 */
export const BASE_MERGE_GUARD: GuardSpec = {
  name: 'base-merge',
  findingNoun: 'base-merge instruction(s) or mill-side merge(s) outside updateBranchWithBase',
  suppressionMarker: 'allow-base-merge',
  allowlistFile: 'tools/base-merge-allowlist.txt',
  invariantPaths: [
    'shared/lib/base-merge-guard.ts',
    'shared/lib/promotion-controller.ts',
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
      name: 'prompt-merge-instruction',
      description:
        'git fetch/merge/rebase instruction in an agent prompt surface — the mill merges the base through updateBranchWithBase; the resolver agent only resolves the conflicted files (HOK-3385)',
      lang: 'sh',
      re: PROMPT_MERGE_INSTRUCTION,
    },
    {
      name: 'base-integration-instruction',
      description:
        'instruction to fetch/merge/rebase against origin — base integration is the mill\'s job (updateBranchWithBase), never an agent instruction',
      lang: 'sh',
      re: BASE_INTEGRATION_INSTRUCTION,
    },
    {
      name: 'mill-base-merge-ts',
      description:
        'mill-side git merge/rebase outside the one primitive — call updateBranchWithBase (shared/lib/promotion-controller.ts) instead',
      lang: 'ts',
      re: MILL_MERGE_TS,
    },
    {
      name: 'mill-base-merge-sh',
      description:
        'mill-side git merge/rebase outside the one primitive — call updateBranchWithBase via tools/update-branch-with-base.ts instead',
      lang: 'sh',
      re: MILL_MERGE_SH,
      // Markdown is a prompt surface, not mill code; the instruction
      // patterns above cover it.
      excludePaths: [],
    },
  ],
  remediation: [
    'One base-merge executor (HOK-3385): "bring this task branch up to date with its',
    'base" is implemented once, by updateBranchWithBase (shared/lib/promotion-controller.ts,',
    'CLI tools/update-branch-with-base.ts). The mill runs the merge — in retain-conflict',
    'mode for the Ready conflict launch — and the resolver agent only resolves the',
    'conflicted files, stages them, and commits. Agent prompts never instruct a fetch,',
    'merge, or rebase; every harness (including native) can edit, add, and commit.',
  ],
};
