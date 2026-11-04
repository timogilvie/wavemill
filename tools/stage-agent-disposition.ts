#!/usr/bin/env -S npx tsx
/**
 * HOK-3386 — CLI over `shared/lib/stage-agent-disposition.ts` for the monitor
 * (`stage_agent_disposition` in wavemill-monitor.sh). Prints the disposition
 * JSON. Fail-safe: any error prints an `in-flight / progress-unavailable`
 * disposition so a broken probe holds rather than relaunches.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  evaluateStageAgentDisposition,
  gatherStageTaskProgress,
  type StageAgentStage,
} from '../shared/lib/stage-agent-disposition.ts';
import { readStageResult, type StageName } from '../shared/lib/stage-result.ts';
import { termCapture, termListPanes } from '../shared/lib/terminal-backend.ts';
import { readWorkflowState } from '../shared/lib/workflow-state.ts';

function isStageAgentStage(value: string | undefined): value is StageAgentStage {
  return value === 'planning' || value === 'coding' || value === 'review'
    || value === 'ready-remediation' || value === 'conflict-resolution';
}

runTool({
  name: 'stage-agent-disposition',
  description: 'HOK-3386 — is this stage\'s agent in flight, settled, advanced or inactive?',
  options: {
    issue: { type: 'string', description: 'Task issue ID (required)' },
    'state-dir': { type: 'string', description: 'Stage state dir (features/<slug>)' },
    worktree: { type: 'string', description: 'Task worktree' },
    'current-head': { type: 'string', description: 'Current worktree HEAD' },
    stage: { type: 'string', description: 'planning | coding | review | ready-remediation | conflict-resolution' },
    'launch-head': { type: 'string', description: 'Launch head for the stage (Ready wraps this)' },
    'pane-target': { type: 'string', description: 'Task pane, for the blocking-prompt and background-work probes' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION or wavemill)' },
    'state-file': { type: 'string', description: 'workflow-state.json path' },
  },
  async run({ args }) {
    const issue = args.issue?.trim() ?? '';
    const stateDir = args['state-dir'] ?? '';
    const worktree = args.worktree ?? '';
    const currentHead = args['current-head']?.trim() || null;
    const stageArg = args.stage?.trim();
    const launchHead = args['launch-head']?.trim() || null;
    const target = args['pane-target'];
    try {
      if (!issue || !stateDir || !worktree) throw new Error('--issue, --state-dir and --worktree are required');
      if (!isStageAgentStage(stageArg)) throw new Error('--stage must be one of planning|coding|review|ready-remediation|conflict-resolution');
      // Resolve the stage result backing this stage's `.<stage>-result.json`.
      // ready-remediation and conflict-resolution are sub-activities of the
      // Ready stage, so `running`/`awaiting_user` etc. come from `.ready-
      // result.json` — there is no separate `.ready-remediation-result.json`
      // or `.conflict-resolution-result.json` on disk.
      const resultStage: StageName = stageArg === 'ready-remediation' || stageArg === 'conflict-resolution' ? 'ready' : stageArg;
      const stageResult = await readStageResult(stateDir, resultStage);
      console.log(JSON.stringify(evaluateStageAgentDisposition({
        stateDir,
        stage: stageArg,
        stageResult,
        currentHead,
        launchHead,
        getProgress: () => gatherStageTaskProgress({
          issue,
          session: args.session?.trim() || process.env.WAVEMILL_SESSION || 'wavemill',
          worktree,
          stateDir,
          stage: stageArg,
          task: args['state-file'] ? readWorkflowState(args['state-file'])?.tasks?.[issue] : undefined,
          stageResult,
          paneText: target ? termCapture(target, { lines: 200, timeoutMs: 3000 }) ?? undefined : undefined,
          panePid: target ? termListPanes({ target, timeoutMs: 3000 })[0]?.pid ?? null : null,
        }),
      })));
    } catch {
      console.log(JSON.stringify({ kind: 'in-flight', reason: 'progress-unavailable', currentHead, stage: stageArg ?? null }));
    }
  },
});
