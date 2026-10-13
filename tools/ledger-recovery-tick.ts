#!/usr/bin/env -S npx tsx
/**
 * Thin wrapper around the Ledger F recovery loop for the monitor tick (HOK-3185).
 *
 * Default: decide recovery for every open step past its deadline and append
 * the non-skip decisions to `.wavemill/ledger-recovery.jsonl`. Shadow mode
 * (the default) writes nothing else; `--live` or WAVEMILL_LEDGER_RECOVERY_LIVE=1
 * also applies them. `--reconcile` instead clears `waiting_on: operator-event`
 * escalations whose condition no longer holds (HOK-3172 reconciler).
 *
 * Usage:
 *   npx tsx tools/ledger-recovery-tick.ts [--repo-dir <dir>] [--state-file <f>]
 *     [--worktree-root <dir>] [--session <s>] [--live] [--reconcile] [--json] [--strict]
 */
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { createStateDirRetry } from '../shared/lib/bounded-retry.ts';
import { Ledger } from '../shared/lib/ledger.ts';
import { withShadowSuppressing } from '../shared/lib/ledger-shadow.ts';
import {
  appendRecoveryLog,
  createMillEnvResolver,
  createRecoveryRetryBudget,
  reconcileRecoveryEscalations,
  recoverStalledSteps,
} from '../shared/lib/ledger-recovery.ts';
import { DEFAULT_RETRY_ATTEMPTS } from '../shared/lib/failure-policy.ts';

runTool({
  name: 'ledger-recovery-tick',
  description: 'Run the one recovery loop over ledger step rows past their deadline.',
  options: {
    'repo-dir': { type: 'string', description: 'Milled repository directory' },
    'state-file': { type: 'string', description: 'workflow-state.json (default <repo>/.wavemill/workflow-state.json)' },
    'worktree-root': { type: 'string', description: 'Worktree root for tasks without a recorded worktree' },
    session: { type: 'string', description: 'Wavemill session (default $WAVEMILL_SESSION)' },
    live: { type: 'boolean', description: 'Apply decisions (default: shadow, decide and log only)' },
    reconcile: { type: 'boolean', description: 'Clear expired operator-event escalations instead of recovering' },
    json: { type: 'boolean', description: 'Print a JSON summary' },
    strict: { type: 'boolean', description: 'Fail with non-zero exit on error' },
  },
  examples: [
    'npx tsx tools/ledger-recovery-tick.ts --repo-dir . --json',
    'npx tsx tools/ledger-recovery-tick.ts --repo-dir . --reconcile',
  ],
  run({ args }) {
    const repoDir = args['repo-dir'] || process.env.WAVEMILL_MILLED_REPO_DIR || process.cwd();
    const live = args.live === true || process.env.WAVEMILL_LEDGER_RECOVERY_LIVE === '1';
    const now = new Date();
    const resolveEnv = createMillEnvResolver({
      stateFile: args['state-file'] || join(repoDir, '.wavemill', 'workflow-state.json'),
      worktreeRoot: args['worktree-root'] || process.env.WORKTREE_ROOT,
      session: args.session || process.env.WAVEMILL_SESSION,
    });

    const runImpl = () => {
      const ledger = Ledger.open({ repoDir });
      try {
        if (args.reconcile) {
          const cleared = reconcileRecoveryEscalations(ledger, { resolveEnv });
          return { mode: 'reconcile' as const, cleared };
        }
        const retry = createRecoveryRetryBudget(
          (bucket) => createStateDirRetry(bucket, { maxAttempts: DEFAULT_RETRY_ATTEMPTS }),
          { shadow: !live },
        );
        const decisions = recoverStalledSteps(ledger, {
          now,
          shadow: !live,
          retry,
          resolveEnv,
          onApplyError: (decision, error) =>
            console.warn(`[ledger-recovery] apply failed step=${decision.stepId} action=${decision.action}: ${error instanceof Error ? error.message : String(error)}`),
        });
        const logged = appendRecoveryLog(repoDir, decisions, { mode: live ? 'live' : 'shadow', at: now.toISOString() });
        return { mode: live ? 'live' as const : 'shadow' as const, steps: decisions.length, logged, decisions };
      } finally {
        ledger.close();
      }
    };

    const result = args.strict === true ? runImpl() : withShadowSuppressing(runImpl);
    if (!result) {
      if (args.json) console.log(JSON.stringify({ shadow: 'suppressed' }));
      return;
    }
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.mode === 'reconcile') {
      for (const row of result.cleared) console.log(`[ledger-recovery] cleared escalation ${row.issueKey} step=${row.stepId} (${row.reason})`);
    } else {
      console.log(`[ledger-recovery] mode=${result.mode} steps=${result.steps} actions=${result.logged}`);
    }
  },
});
