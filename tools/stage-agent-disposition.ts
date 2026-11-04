#!/usr/bin/env -S npx tsx
/**
 * HOK-3386 — CLI over `shared/lib/stage-agent-disposition.ts` for the monitor
 * (`stage_agent_disposition` in wavemill-monitor.sh). Prints the disposition
 * JSON. Fail-safe: any error prints an `in-flight / progress-unavailable`
 * disposition so a broken probe holds rather than relaunches.
 */

import { writeFileSync, renameSync } from 'node:fs';
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

/**
 * Best-effort atomic write of the shared `/tmp/wavemill-<session>-<issue>.
 * progress.json` cache — the same path `tools/task-progress.ts --write-cache`
 * writes. Previously only the coding stage's (now-deleted)
 * `coding_stage_stalled` wrote this; every stage's disposition check now
 * computes a `TaskProgress` snapshot anyway, so it keeps the dashboard
 * (`wavemill-status.sh` → `task_progress_cached_json`) fed for every stage,
 * not just coding. Never throws.
 */
function writeProgressCache(session: string, issue: string, progress: unknown): void {
  try {
    const path = `/tmp/wavemill-${session}-${issue}.progress.json`;
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(progress), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // Best-effort; the disposition decision never depends on this write.
  }
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
      const session = args.session?.trim() || process.env.WAVEMILL_SESSION || 'wavemill';
      let progressCache: ReturnType<typeof gatherStageTaskProgress> | null = null;
      const getProgress = () => {
        progressCache = gatherStageTaskProgress({
          issue,
          session,
          worktree,
          stateDir,
          stage: stageArg,
          task: args['state-file'] ? readWorkflowState(args['state-file'])?.tasks?.[issue] : undefined,
          stageResult,
          paneText: target ? termCapture(target, { lines: 200, timeoutMs: 3000 }) ?? undefined : undefined,
          panePid: target ? termListPanes({ target, timeoutMs: 3000 })[0]?.pid ?? null : null,
        });
        return progressCache;
      };
      const disposition = evaluateStageAgentDisposition({
        stateDir,
        stage: stageArg,
        stageResult,
        currentHead,
        launchHead,
        getProgress,
      });
      if (progressCache) writeProgressCache(session, issue, progressCache);
      console.log(JSON.stringify(disposition));
    } catch {
      console.log(JSON.stringify({ kind: 'in-flight', reason: 'progress-unavailable', currentHead, stage: stageArg ?? null }));
    }
  },
});
