#!/usr/bin/env -S npx tsx
/**
 * change-identity — thin CLI over the one head-freshness primitive
 * (HOK-3370, shared/lib/change-identity.ts).
 *
 * Modes:
 *   --compute: print the change identity JSON for --head against --base-ref.
 *   (default): judge evidence freshness; prints the freshness JSON.
 *     Exit 0 = fresh, 1 = stale, 2 = usage error.
 *
 * Used by `change_identity_fresh` in wavemill-common.sh.
 */
import { runTool } from '../shared/lib/tool-runner.ts';
import { computeChangeIdentity, isEvidenceFresh } from '../shared/lib/change-identity.ts';

runTool({
  name: 'change-identity',
  description: 'Compute a task change identity or judge evidence freshness (HOK-3370)',
  options: {
    worktree: { type: 'string', description: 'Git worktree the SHAs resolve in' },
    'base-ref': { type: 'string', description: 'Base ref for the merge-base (e.g. origin/auto/integration)' },
    compute: { type: 'boolean', description: 'Compute the identity of --head instead of judging freshness', default: false },
    head: { type: 'string', description: 'Head SHA for --compute' },
    'evidence-head': { type: 'string', description: 'Head SHA the evidence was recorded at' },
    'current-head': { type: 'string', description: 'Current head SHA' },
    'evidence-change-id': { type: 'string', description: 'Change id stored with the evidence (optional fast path)' },
  },
  examples: [
    'npx tsx tools/change-identity.ts --worktree ./wt --base-ref origin/auto/integration --evidence-head <sha> --current-head <sha>',
    'npx tsx tools/change-identity.ts --compute --worktree ./wt --base-ref origin/auto/integration --head <sha>',
  ],
  async run({ args }) {
    const worktree = args.worktree as string | undefined;
    const baseRef = args['base-ref'] as string | undefined;
    if (!worktree || !baseRef) {
      console.error('Error: --worktree and --base-ref are required');
      process.exit(2);
    }

    if (args.compute) {
      const head = args.head as string | undefined;
      if (!head) {
        console.error('Error: --compute requires --head');
        process.exit(2);
      }
      const identity = computeChangeIdentity(worktree, head, baseRef);
      if (!identity) {
        process.stdout.write(`${JSON.stringify({ ok: false, reason: 'unreachable' })}\n`);
        process.exit(1);
      }
      process.stdout.write(`${JSON.stringify({ ok: true, ...identity })}\n`);
      process.exit(0);
    }

    const evidenceHeadSha = args['evidence-head'] as string | undefined;
    const currentHeadSha = args['current-head'] as string | undefined;
    if (!evidenceHeadSha || !currentHeadSha) {
      console.error('Error: --evidence-head and --current-head are required');
      process.exit(2);
    }
    const result = isEvidenceFresh({
      gitDir: worktree,
      evidenceHeadSha,
      currentHeadSha,
      baseRef,
      evidenceChangeId: (args['evidence-change-id'] as string | undefined) || undefined,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.fresh ? 0 : 1);
  },
});
