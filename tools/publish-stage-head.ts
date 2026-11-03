#!/usr/bin/env -S npx tsx
/**
 * publish-stage-head — thin CLI over `publishStageHead` (HOK-3370).
 *
 * The one publication seam for task-branch head moves: verifies the local
 * ref, fast-forwards the remote (never force), appends a `head-move/v1` row
 * and shadow-records the push (HOK-3183). Called by the monitor at stage
 * exits (`publish_stage_head` in wavemill-common.sh).
 *
 * Emits one JSON object on stdout and exits:
 *   0  — success (`outcome`: pushed | reused | remote-ahead)
 *   10 — remote-divergence (conflict-shaped; flows to remediation)
 *   11 — local ref missing / expected SHA mismatch
 *   13 — push or verification failed (retryable transport)
 *   1  — any other failure
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { publishStageHead } from '../shared/lib/branch-publication.ts';
import type { HeadMoveActor, HeadMoveKind, HeadMoveStage } from '../shared/lib/head-move-record.ts';

const EXIT_CODE_BY_REASON: Record<string, number> = {
  'remote-divergence': 10,
  'local-ref-missing': 11,
  'stale-reviewed-sha': 11,
  'remote-lookup-failed': 13,
  'push-failed': 13,
  'post-push-verification-failed': 13,
};

const STAGES = new Set(['planning', 'coding', 'review', 'ready', 'tend']);
const ACTORS = new Set(['agent', 'mill', 'tend']);
const KINDS = new Set(['coding', 'review-fix', 'remediation', 'conflict', 'base-merge', 'rebase']);

runTool({
  name: 'publish-stage-head',
  description: 'Publish a task branch head at a stage exit through the one seam (HOK-3370)',
  options: {
    worktree: { type: 'string', description: 'Path to the task worktree' },
    branch: { type: 'string', description: 'Branch to publish (no refs/heads/ prefix)' },
    'state-dir': { type: 'string', description: 'Task state dir for the head-move record' },
    issue: { type: 'string', description: 'Issue id recorded on the head-move row' },
    stage: { type: 'string', description: 'Stage exiting: planning|coding|review|ready|tend' },
    kind: { type: 'string', description: 'Move kind: coding|review-fix|remediation|conflict|base-merge|rebase' },
    actor: { type: 'string', description: 'Publisher: agent|mill|tend (default: mill)', default: 'mill' },
    'expected-sha': { type: 'string', description: 'Refuse unless the local branch names exactly this SHA' },
    remote: { type: 'string', description: 'Remote name (default: origin)', default: 'origin' },
  },
  examples: [
    'npx tsx tools/publish-stage-head.ts --worktree ./wt --branch task/foo --state-dir ./state --issue HOK-1 --stage coding --kind coding',
  ],
  async run({ args }) {
    const worktree = args.worktree as string | undefined;
    const branch = args.branch as string | undefined;
    const stateDir = args['state-dir'] as string | undefined;
    const issue = args.issue as string | undefined;
    const stage = args.stage as string | undefined;
    const kind = args.kind as string | undefined;
    const actor = (args.actor as string | undefined) || 'mill';

    if (!worktree || !branch || !stateDir || !issue || !stage || !kind) {
      console.error('Error: --worktree, --branch, --state-dir, --issue, --stage, and --kind are all required');
      process.exit(1);
    }
    if (!STAGES.has(stage) || !KINDS.has(kind) || !ACTORS.has(actor)) {
      console.error(`Error: invalid --stage/--kind/--actor (${stage}/${kind}/${actor})`);
      process.exit(1);
    }

    const result = publishStageHead({
      worktreeDir: worktree,
      remote: (args.remote as string | undefined) || 'origin',
      branch,
      expectedSha: (args['expected-sha'] as string | undefined) || undefined,
      stateDir,
      issue,
      stage: stage as HeadMoveStage,
      actor: actor as HeadMoveActor,
      kind: kind as HeadMoveKind,
    });

    // JSON verbatim from the module so future field additions reach the
    // shell wrapper without a schema tweak here.
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok) {
      process.exit(0);
    }
    console.error(`publish-stage-head: ${result.reason} — ${result.message}`);
    process.exit(EXIT_CODE_BY_REASON[result.reason] ?? 1);
  },
});
