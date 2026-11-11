/**
 * Preflight guard for the one agent-exited fact (HOK-3426): a stage settles
 * `agent-exited` only on a recorded exit — the launcher's own `agent-exit`
 * record (the agent process's parent wrote it as it exited), the task row's
 * recorded window slot reporting dead (`term_is_dead`), or a HOK-3359
 * controller-termination record, all exposed as `TaskProgress.agentExited`.
 *
 * The pane descendant count (`agentProcessLive`) is a "rough fact that is
 * NEVER a source of progress" (HOK-3101 invariant 1). Reading its `false` as
 * a high-confidence exit is what stamped a live reviewer `failed` and
 * relaunched it through `stage-failure-review` in the reported 2026-11-05
 * stall. Production logs hold no retained record of that stall, so the
 * attribution is a reproduction, not incident evidence (plan Step 0). The
 * probe resolves the task window BY NAME, so a quarantined or freshly
 * recreated window — or the right window before its agent forked — reads
 * dead while the agent is alive.
 *
 * `agentProcessLive` remains the HOK-3374 background-work input and a
 * diagnostic. It never settles a stage, so `agentProcessLive === false`
 * outside the primitive that owns the fast-path diagnostic is a finding.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/**
 * The primitive that legitimately keeps `agentProcessLive === false`: the
 * `terminalIdle` diagnostic (`terminal && (agentIdle || …)`). It is not a
 * disposition settle rule and predates this guard.
 */
const TASK_PROGRESS_PATH = 'shared/lib/task-progress.ts';

/** A settle-shaped read of the pane descendant count. */
const PROCESS_LIVE_SETTLE = /\bagentProcessLive\s*(?:===|==)\s*false\b/;

/**
 * The one-agent-exited-fact guard (HOK-3426). `stage-agent-disposition.ts` is
 * deliberately scanned, so reverting rule 11 to the descendant count fails.
 */
export const STAGE_AGENT_EXIT_GUARD: GuardSpec = {
  name: 'stage-agent-exit',
  invariantDocs: ['docs/invariants/stage-agent-disposition.md'],
  findingNoun: 'stage settle decision(s) reading the pane descendant count',
  suppressionMarker: 'allow-stage-agent-exit',
  allowlistFile: 'tools/stage-agent-exit-allowlist.txt',
  invariantPaths: ['shared/lib/stage-agent-exit-guard.ts'],
  patterns: [
    {
      name: 'agent-process-live-settle',
      description:
        'agentProcessLive === false used as an exit decision — settle on TaskProgress.agentExited (a launcher agent-exit record, the task row\'s recorded window slot, or a controller-termination record), never on the pane descendant count (HOK-3426)',
      lang: 'ts',
      re: PROCESS_LIVE_SETTLE,
      excludePaths: [TASK_PROGRESS_PATH],
    },
  ],
  remediation: [
    'One agent-exited fact (HOK-3426): a stage agent has exited when a launcher',
    'record says so (the agent process\'s parent writes `agent-exit` as it exits),',
    'the task row\'s recorded window slot says so (term_is_dead on the',
    'windowId persisted for the task), or a HOK-3359 controller-termination record exists. task-progress exposes that as',
    'TaskProgress.agentExited; decideStageAgentDisposition settles on it. The pane',
    'descendant count (agentProcessLive) is the HOK-3374 background-work input and a',
    'diagnostic only: it resolves the task window by name, so a quarantined or',
    'recreated window (or a pane whose agent has not forked yet) reads dead while the',
    'agent is alive.',
  ],
};
