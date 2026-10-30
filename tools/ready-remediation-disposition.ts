#!/usr/bin/env -S npx tsx
/**
 * HOK-3322 — CLI over `shared/lib/ready-remediation-disposition.ts` for the
 * monitor (`ready_remediation_disposition` in wavemill-monitor.sh). Prints the
 * disposition JSON. Fail-safe: any error prints an `in-flight` disposition with
 * reason `progress-unavailable`, so a broken probe holds rather than relaunches.
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  evaluateReadyRemediationDisposition,
  gatherReadyTaskProgress,
} from '../shared/lib/ready-remediation-disposition.ts';
import { readStageResult } from '../shared/lib/stage-result.ts';
import { termCapture, termListPanes } from '../shared/lib/terminal-backend.ts';
import { readWorkflowState } from '../shared/lib/workflow-state.ts';

runTool({
  name: 'ready-remediation-disposition',
  description: 'HOK-3322 — is Ready remediation in flight, settled, advanced or inactive for this task?',
  options: {
    issue: { type: 'string', description: 'Task issue ID (required)' },
    'state-dir': { type: 'string', description: 'Ready state dir (features/<slug>)' },
    worktree: { type: 'string', description: 'Task worktree' },
    'current-head': { type: 'string', description: 'Current worktree HEAD' },
    'pane-target': { type: 'string', description: 'Task pane, for the blocking-prompt and background-work probes' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION or wavemill)' },
    'state-file': { type: 'string', description: 'workflow-state.json path' },
  },
  async run({ args }) {
    const issue = args.issue?.trim() ?? '';
    const stateDir = args['state-dir'] ?? '';
    const worktree = args.worktree ?? '';
    const currentHead = args['current-head']?.trim() || null;
    const target = args['pane-target'];
    try {
      if (!issue || !stateDir || !worktree) throw new Error('--issue, --state-dir and --worktree are required');
      const readyResult = await readStageResult(stateDir, 'ready');
      console.log(JSON.stringify(evaluateReadyRemediationDisposition({
        stateDir,
        readyResult,
        currentHead,
        getProgress: () => gatherReadyTaskProgress({
          issue,
          session: args.session?.trim() || process.env.WAVEMILL_SESSION || 'wavemill',
          worktree,
          stateDir,
          task: args['state-file'] ? readWorkflowState(args['state-file'])?.tasks?.[issue] : undefined,
          readyResult,
          paneText: target ? termCapture(target, { lines: 200, timeoutMs: 3000 }) ?? undefined : undefined,
          panePid: target ? termListPanes({ target, timeoutMs: 3000 })[0]?.pid ?? null : null,
        }),
      })));
    } catch {
      console.log(JSON.stringify({ kind: 'in-flight', reason: 'progress-unavailable', currentHead }));
    }
  },
});
