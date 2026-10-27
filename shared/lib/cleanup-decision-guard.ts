// allow-cleanup-decision: this file *is* the cleanup-decision guard; its
// pattern table names every forbidden shape. It is auto-excluded from its own
// scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one-cleanup-decision invariant (HOK-3312, enforced
 * by HOK-3236): the reap / archive-and-reap / retain decision for a terminal
 * task is owned by `shared/lib/terminal-inbox-cleanup.ts::decideTerminalTask`.
 * Both monitor sites (`cleanup_completed_task` in `shared/lib/wavemill-common.sh`,
 * `cleanup_aborted_challenge_arm` in `shared/lib/wavemill-monitor.sh`) and the
 * CLI (`tools/cleanup-terminal-inbox.ts` / `wavemill cleanup`) consume that
 * decision; they never re-derive one.
 *
 * Three mechanical shapes give a second decider away:
 *
 * - defining `cleanup_completed_task` or `cleanup_aborted_challenge_arm` in a
 *   file other than the canonical shell libraries (the two canonical shell
 *   definitions are auto-excluded as invariant source);
 * - referencing the retired private hook reader
 *   `wavemill_terminal_agent_idle_evidence`;
 * - minting a new `"live-agent-process"` / `"dirty_worktree"` refusal literal
 *   outside the TS decider itself.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const CLEANUP_DECISION_GUARD: GuardSpec = {
  name: 'cleanup-decision',
  findingNoun: 'ad-hoc terminal-cleanup-decision site(s)',
  suppressionMarker: 'allow-cleanup-decision',
  allowlistFile: 'tools/cleanup-decision-allowlist.txt',
  invariantPaths: [
    'shared/lib/terminal-inbox-cleanup.ts',
    'shared/lib/wavemill-common.sh',
    'shared/lib/wavemill-monitor.sh',
    'shared/lib/cleanup-decision-guard.ts',
    'tools/check-cleanup-decision.ts',
    'tools/decide-terminal-cleanup.ts',
  ],
  patterns: [
    {
      name: 'duplicate-cleanup-function',
      description: 'new `cleanup_completed_task` / `cleanup_aborted_challenge_arm` definition — the TS decider is the only decider; both canonical shell callers already exist in wavemill-common.sh / wavemill-monitor.sh',
      lang: 'sh',
      // Matches a function definition line like `cleanup_completed_task() {`
      // or `cleanup_aborted_challenge_arm () {` at any indentation.
      re: /^\s*(cleanup_completed_task|cleanup_aborted_challenge_arm)\s*\(\)\s*\{/,
    },
    {
      name: 'legacy-hook-reader',
      description: 'reference to the retired `wavemill_terminal_agent_idle_evidence` — pane liveness is no longer a terminal-release input (HOK-3312)',
      lang: 'both',
      re: /wavemill_terminal_agent_idle_evidence/,
    },
    {
      name: 'legacy-refusal-literal',
      description: 'new `"live-agent-process"` / `"dirty_worktree"` refusal literal — the TS decider promotes these into archive-and-reap for the monitor consumer; never re-mint them outside the decider',
      lang: 'both',
      re: /["']live-agent-process["']|["']dirty_worktree["']/,
    },
  ],
  remediation: [
    'Terminal-cleanup decisions live in exactly one place: `decideTerminalTask`',
    'in `shared/lib/terminal-inbox-cleanup.ts`. The monitor consumes its verdict',
    'through the `cleanup-decision` async job (shared/lib/monitor-async-jobs.sh);',
    'the CLI invokes it directly. Pane liveness is NOT a decision input for a',
    'terminal task — lifecycle is.',
  ],
};
