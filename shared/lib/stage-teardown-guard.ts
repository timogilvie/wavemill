/**
 * Preflight guard for the one stage-agent teardown invariant (HOK-3359).
 *
 * "May the controller end this stage agent now, and what does the record
 * say afterwards?" has one answer: {@link ../lib/stage-teardown.sh
 * stage_agent_teardown} — settle, terminate, record, kill. Eight call sites
 * used to each decide independently, and the 2026-10-30 incident (HOK-3315)
 * was exactly that divergence: a raw `tmux kill-window` fired 3s after
 * `.coding-complete` with no settle and no exit record, while the agent was
 * still mid-write.
 *
 * This guard fails on a raw `tmux kill-window` / `tmux kill-pane` call, or a
 * direct `agent_terminate_in_pane` call, outside the one teardown function.
 * Legitimate non-task-window kills (mill startup/shutdown panes, the
 * terminal-backend seam's own host primitives, test harnesses) are carried
 * on the ratcheting allowlist with a reason — never silently exempted by
 * path prefix, so a new one still has to justify itself.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const STAGE_TEARDOWN_GUARD: GuardSpec = {
  name: 'stage-teardown',
  invariantDocs: ['docs/invariants/stage-teardown.md'],
  findingNoun: 'raw pane-kill / terminate call(s) outside stage_agent_teardown',
  suppressionMarker: 'allow-stage-teardown',
  allowlistFile: 'tools/stage-teardown-allowlist.txt',
  invariantPaths: [
    'shared/lib/stage-teardown.sh',
    'shared/lib/stage-teardown-guard.ts',
    'tools/check-stage-teardown.ts', // install-paths: allow invariantPaths list, not an argv target
    // agent_terminate_in_pane is DEFINED here; the guard targets call sites,
    // not the implementation that stage_agent_teardown itself calls into.
    'shared/lib/agent-adapters.sh',
  ],
  patterns: [
    {
      name: 'raw-kill-window',
      description: 'tmux kill-window outside stage_agent_teardown — call stage_agent_teardown (shared/lib/stage-teardown.sh) instead',
      lang: 'sh',
      re: /\btmux\s+kill-window\b/,
    },
    {
      name: 'raw-kill-pane',
      description: 'tmux kill-pane outside stage_agent_teardown — call stage_agent_teardown (shared/lib/stage-teardown.sh) instead, or allowlist if this is not a task window',
      lang: 'sh',
      re: /\btmux\s+kill-pane\b/,
    },
    {
      name: 'raw-agent-terminate-in-pane',
      description: 'agent_terminate_in_pane called outside stage_agent_teardown — the graceful terminate sequence belongs inside the one teardown',
      lang: 'sh',
      re: /\bagent_terminate_in_pane\b\s*(?:"|\$|[A-Za-z0-9_])/,
    },
  ],
  remediation: [
    'HOK-3359: ending a stage agent\'s tmux window goes through the one',
    'teardown (shared/lib/stage-teardown.sh stage_agent_teardown) — settle,',
    'terminate, record, kill. It settles non-blocking (HOK-3206), writes a',
    'controller-termination exit fact tools/task-progress.ts reads as',
    'agentIdle, then kills the window (unless --keep-window).',
  ],
};
