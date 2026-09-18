#!/usr/bin/env -S npx tsx

import { createStatusRenderer } from '../shared/lib/tend-status-renderer.ts';
import { executeMerge, formatStatusLine, selectNextCandidate } from '../shared/lib/tend-controller.ts';
import { runPromotion } from '../shared/lib/promotion-controller.ts';
import { acquireTendLock } from '../shared/lib/tend-singleton.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { runTendLoop, statusActionForResult } from '../shared/lib/tend-loop.ts';
import { reconcileStalledMerges, type TendPrepStateDeps } from '../shared/lib/tend-prep-state.ts';
import { getPullRequest, addPullRequestComment } from '../shared/lib/github.ts';
import { setWavemillReady, setWavemillBlocked, setWavemillMerging } from '../shared/lib/pr-state-labels.ts';
import { execShellCommand } from '../shared/lib/shell-utils.ts';

runTool({
  name: 'tend',
  description: 'Tend the integration queue',
  options: {
    once: {
      type: 'boolean',
      description: 'Run once and exit',
    },
    loop: {
      type: 'boolean',
      description: 'Run continuously inside the mill tmux session',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print status line without mutating',
    },
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
      default: process.cwd(),
    },
  },
  examples: [
    'npx tsx tools/tend.ts --once --dry-run',
    'npx tsx tools/tend.ts --once --repo-dir /path/to/repo',
    'npx tsx tools/tend.ts --loop --repo-dir /path/to/repo',
    'npx tsx tools/tend.ts promote --repo-dir /path/to/repo',
  ],
  positional: {
    name: 'command',
    description: 'Optional subcommand (supported: promote)',
  },
  async run({ args, positional }) {
    const subcommand = positional[0];
    if (!args.once && !args.loop) {
      if (subcommand === 'promote') {
        const repoDir = String(args['repo-dir'] || process.cwd());
        const result = await runPromotion({ repoDir, dryRun: args['dry-run'] });
        console.log(`promote: ${result.status}${result.prUrl ? ` url=${result.prUrl}` : ''}`);
        if (result.checkSummary) {
          console.log(`checks: ${result.checkSummary}`);
        }
        return;
      }
      throw new Error('one of --once or --loop is required');
    }

    const repoDir = String(args['repo-dir'] || process.cwd());

    if (args.loop) {
      const renderer = createStatusRenderer(process.stdout as NodeJS.WriteStream);
      const lock = acquireTendLock({
        repoDir,
        session: process.env.WAVEMILL_SESSION,
      });

      if (lock.outcome === 'skipped') {
        renderer.finalize();
        return;
      }

      const handleSignal = (signal: NodeJS.Signals) => {
        renderer.finalize();
        process.kill(process.pid, signal);
      };
      process.once('SIGINT', () => handleSignal('SIGINT'));
      process.once('SIGTERM', () => handleSignal('SIGTERM'));

      try {
        const exit = await runTendLoop({ repoDir, renderer });
        if (exit.reason === 'halted') {
          process.exitCode = 1;
        }
      } finally {
        lock.release();
      }
      return;
    }

    // Startup reconciliation for --once mode to recover from prior crashes/timeouts
    try {
      const reconcileDeps: TendPrepStateDeps = {
        readPrHeadSha: async (prNumber) => {
          try {
            const pr = await getPullRequest(prNumber, repoDir);
            return pr?.headRefOid || null;
          } catch {
            return null;
          }
        },
        readPrMergeState: async (prNumber) => {
          try {
            const pr = await getPullRequest(prNumber, repoDir);
            if (!pr) return null;
            if (pr.merged) return 'MERGED';
            if (!pr.closed) return 'OPEN';
            return null;
          } catch {
            return null;
          }
        },
        restoreWmReady: (prNumber) => {
          try {
            setWavemillReady(prNumber, repoDir);
          } catch (err) {
            console.warn(`Failed to restore wm:ready for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
          }
        },
        restoreWmBlocked: (prNumber, reason) => {
          try {
            setWavemillBlocked(prNumber, reason, repoDir);
          } catch (err) {
            console.warn(`Failed to restore wm:blocked for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
          }
        },
        restoreWmMerging: (prNumber) => {
          try {
            setWavemillMerging(prNumber, repoDir);
          } catch (err) {
            console.warn(`Failed to restore wm:merging for PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
          }
        },
        addPrComment: async (prNumber: number, body: string) => {
          try {
            await addPullRequestComment(prNumber, body, repoDir);
          } catch (err) {
            console.error(`Failed to add comment to PR #${prNumber}: ${err instanceof Error ? err.message : err}`);
          }
        },
      };
      await reconcileStalledMerges(repoDir, reconcileDeps);
    } catch (err) {
      // Reconciliation failure is best-effort; don't fail the run
      console.warn(`Startup reconciliation failed: ${err instanceof Error ? err.message : err}`);
    }

    const decision = await selectNextCandidate({
      repoDir,
      loserCleanup: args['dry-run'] ? () => {} : undefined,
    });
    if (args['dry-run'] || decision.nextPR === null) {
      console.log(formatStatusLine(decision, { action: 'idle' }));
      return;
    }

    const candidate = decision.eligible.find((item) => item.number === decision.nextPR);
    if (!candidate) {
      throw new Error(`tend: selected PR #${decision.nextPR} was not found in eligible candidates`);
    }

    const result = await executeMerge(candidate, { repoDir });
    console.log(formatStatusLine(decision, {
      action: statusActionForResult(result.status, result.prNumber),
      lastPR: result.status === 'merged' ? result.prNumber : null,
    }));
    if (result.status === 'halted') {
      process.exitCode = 1;
    }
  },
});
