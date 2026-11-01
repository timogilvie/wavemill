// allow-settled-attempt: this file *is* the settled-attempt guard; its pattern
// table names every forbidden shape. It is auto-excluded from its own scan
// (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-settled-attempt invariant (HOK-3373).
 *
 * "Is this attempt settled, and may anything act on it?" has one answer:
 * the settlement gate at the task-record seam (`task-settlement.ts`, reached
 * through `mutateJsonState` / `mutateWorkflowState` and the shell
 * `state_mutate`). Linear state is a render of the settled run
 * (`linear-state-renderer.ts` / `linear_state_converge_tick`), and a task
 * path is only touched through the task-worktree resolver
 * (`task-worktree-resolver.{ts,sh}`). This guard fails on the shapes that
 * answer it a second way:
 *
 * 1. `state-write-bypass` — writing `workflow-state.json` without the seam
 *    (a shell redirect / `mv` onto `$STATE_FILE`, a TS `writeFileSync` of
 *    the state path), so a lifecycle / abort / phase write skips the gate.
 * 2. `linear-state-write` — a Linear state transition outside the derived
 *    renderer (`linear_set_state` / `linear_set_state_checked` /
 *    `setIssueState`). Pre-existing writers (launch → In Progress, PR open →
 *    In Review, the terminal reconciler) are held by a count ratchet.
 * 3. `task-path-probe` — `git -C <task path>` or `mkdir -p <task path>`
 *    outside the resolver, which falls through to the main checkout or
 *    recreates a dead worktree (HOK-2595). Pre-existing probes are held by a
 *    count ratchet; a new one must go through `task_worktree_path_status` /
 *    `task_dir_ensure` / `taskWorktreePathStatus`.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/** Shell variables that hold a task worktree / task state path. */
const SH_TASK_PATH_VARS = '(?:wt_dir|WT_DIR|worktree|worktree_dir|wt|wt_path|task_wt|_ai_wt|challenger_wt_dir|arm_wt|state_dir|feature_dir|STATE_DIR_TASK)';

export const SETTLED_ATTEMPT_GUARD: GuardSpec = {
  name: 'settled-attempt',
  findingNoun: 'settled-attempt bypass(es)',
  suppressionMarker: 'allow-settled-attempt',
  allowlistFile: 'tools/settled-attempt-allowlist.txt',
  invariantPaths: [
    'shared/lib/task-settlement.ts',
    'shared/lib/attempt-identity.ts',
    'shared/lib/attempt-identity.sh',
    'shared/lib/linear-state-renderer.ts',
    'shared/lib/task-worktree-resolver.ts',
    'shared/lib/task-worktree-resolver.sh',
    'shared/lib/settled-attempt-guard.ts',
  ],
  patterns: [
    {
      name: 'state-write-bypass',
      description: 'workflow-state.json written without the task-record seam — use state_mutate / task_state_mutate_existing / mutateWorkflowState',
      lang: 'sh',
      re: /(?:>{1,2}\s*"?\$\{?STATE_FILE\}?"?\s*(?:$|[;&|)])|\bmv\s+(?:-f\s+)?\S+\s+"?\$\{?STATE_FILE\}?"?(?:\s|$|;))/,
    },
    {
      name: 'state-write-bypass',
      description: 'workflow-state.json written without the task-record seam — use mutateWorkflowState / mutateJsonState',
      lang: 'ts',
      re: /\bwriteFileSync\(\s*(?:statePath|stateFile|workflowStatePath|STATE_FILE)\b|\bwriteFileSync\([^,]*['"`][^'"`]*workflow-state\.json/,
    },
    {
      name: 'linear-state-write',
      description: 'Linear state written outside the derived renderer — Linear is a render of the settled run (linear_state_converge_tick)',
      lang: 'sh',
      re: /^\s*(?:if\s+!?\s*)?(?:[A-Za-z_]+=\S*\s+)*linear_set_state(?:_checked)?\s+["$]/,
    },
    {
      name: 'linear-state-write',
      description: 'Linear state written outside the derived renderer — Linear is a render of the settled run',
      lang: 'ts',
      re: /\bsetIssueState\(/,
    },
    {
      name: 'task-path-probe',
      description: 'git -C / mkdir -p on a task path outside the task-worktree resolver — use task_worktree_path_status / task_dir_ensure',
      lang: 'sh',
      re: new RegExp(`\\bgit\\s+-C\\s+"?\\$\\{?${SH_TASK_PATH_VARS}\\b|\\bmkdir\\s+-p\\s+"?\\$\\{?${SH_TASK_PATH_VARS}\\b`),
    },
    {
      name: 'task-path-probe',
      description: "git -C on a task worktree outside the task-worktree resolver — check taskWorktreePathStatus(...) === 'registered' first",
      lang: 'ts',
      re: /\[\s*['"]-C['"]\s*,\s*(?:worktree|worktreeDir|worktreePath|wtDir|taskWorktree)\b/,
    },
  ],
  remediation: [
    'HOK-3373: control writes go through the task-record seam, which refuses them on a settled or',
    'non-current run; Linear state is rendered from the settled run; task paths go through the',
    'task-worktree resolver so a dead worktree is never recreated and git never falls through to',
    'the main checkout.',
  ],
};
