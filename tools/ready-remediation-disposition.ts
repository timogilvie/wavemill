#!/usr/bin/env -S npx tsx
/**
 * HOK-3322 — CLI over `shared/lib/ready-remediation-disposition.ts` for the
 * monitor (`ready_remediation_disposition` in
 * `shared/lib/ready-remediation-disposition.sh`).
 *
 * Reads the Ready result status from `--state-dir`, the latest remediation
 * launch time from its session-ownership rows, and the owner's evidence from
 * the HOK-3101 task-progress primitive, then prints the disposition JSON:
 * `{"kind":"none|superseded|in-flight|settled","owner":"…","reason":"…"}`.
 *
 * Fail-safe direction: any error prints `{}` and exits 0; the shell wrapper
 * then holds (`in-flight`), which is the pre-HOK-3322 behaviour.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  decideReadyRemediationDisposition,
  readLatestRemediationLaunchAt,
} from '../shared/lib/ready-remediation-disposition.ts';
import { readStageResult } from '../shared/lib/stage-result.ts';
import { getTaskProgress, type TaskProgress } from '../shared/lib/task-progress.ts';
import { readWorkflowState } from '../shared/lib/workflow-state.ts';

runTool({
  name: 'ready-remediation-disposition',
  description: 'HOK-3322 — the one Ready remediation in-flight/completion disposition.',
  options: {
    issue: { type: 'string', description: 'Task issue ID (required)' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION or wavemill)' },
    'state-dir': { type: 'string', description: 'Ready state dir holding .ready-result.json (required)' },
    'launch-head': { type: 'string', description: 'Head the last remediation launched at' },
    'current-head': { type: 'string', description: 'Current worktree HEAD' },
    worktree: { type: 'string', description: 'Task worktree (progress evidence)' },
    'state-file': { type: 'string', description: 'workflow-state.json path (terminal evidence)' },
  },
  async run({ args }) {
    const issue = args.issue?.trim();
    const stateDir = args['state-dir']?.trim();
    if (!issue || !stateDir) {
      console.log('{}');
      return;
    }
    try {
      const session = args.session?.trim() || process.env.WAVEMILL_SESSION || 'wavemill';
      const task = args['state-file'] ? readWorkflowState(args['state-file'])?.tasks?.[issue] : undefined;
      const readyResult = await readStageResult({ featureDir: stateDir, stage: 'ready' });

      let progress: TaskProgress | null = null;
      try {
        progress = getTaskProgress({
          issue,
          session,
          task: task ?? undefined,
          worktree: args.worktree ?? task?.worktree,
          featureDir: stateDir,
          phase: 'ready',
        });
      } catch {
        progress = null;
      }

      const disposition = decideReadyRemediationDisposition({
        readyStatus: readyResult?.status ?? null,
        launchHead: args['launch-head'],
        currentHead: args['current-head'],
        progress,
        launchedAt: readLatestRemediationLaunchAt(stateDir),
      });
      console.log(JSON.stringify(disposition));
    } catch {
      console.log('{}');
    }
  },
});
