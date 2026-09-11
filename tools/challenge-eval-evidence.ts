#!/usr/bin/env -S npx tsx

/**
 * Report whether one challenge arm has valid eval evidence at its current
 * PR head (HOK-2963). Thin wrapper over the HOK-2949 selector so shell-side
 * orchestration never reimplements JSONL selection.
 *
 * Prints a single JSON object:
 *   { ok: true,  evalId, evaluatedPrHeadSha, currentHeadSha }
 *   { ok: false, reason, currentHeadSha, candidates }
 *
 * Exit code is 0 for both outcomes; infrastructure failures (unresolvable PR
 * identity, unreadable records) exit non-zero so callers can distinguish
 * "evidence is stale" from "could not check".
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { resolvePrIdentityMetadata } from '../shared/lib/pr-comparison.ts';
import { selectCurrentChallengeEval, type ChallengeEvalSide } from '../shared/lib/current-challenge-eval-selector.ts';

runTool({
  name: 'challenge-eval-evidence',
  description: 'Check current-head challenge eval evidence for one arm',
  options: {
    'pair-id': { type: 'string', description: 'Challenge pair identifier' },
    side: { type: 'string', description: 'Challenge side: primary or challenger' },
    pr: { type: 'string', description: 'PR number or URL for the arm' },
    'repo-dir': { type: 'string', description: 'Repository directory' },
  },
  examples: [
    'npx tsx tools/challenge-eval-evidence.ts --pair-id HOK-1234 --side challenger --pr 42',
  ],
  async run({ args }) {
    const pairId = args['pair-id'] as string;
    const side = args.side as string;
    const pr = args.pr as string;
    const repoDir = (args['repo-dir'] as string) || process.cwd();
    if (!pairId || !pr || (side !== 'primary' && side !== 'challenger')) {
      throw new Error('Required: --pair-id, --pr, and --side primary|challenger');
    }

    const identity = resolvePrIdentityMetadata(pr, repoDir);
    const records = readEvalRecords({ dir: resolveEvalsDir(undefined, repoDir).dir });
    const selection = selectCurrentChallengeEval(records, {
      pairId,
      side: side as ChallengeEvalSide,
      prUrl: identity.url,
      currentHeadSha: identity.head_sha,
      // Score validity is judged by the comparison path; presence at the
      // current head is what eval-launch dedupe needs here.
      requireScore: false,
    });

    if (selection.ok) {
      console.log(JSON.stringify({
        ok: true,
        evalId: selection.evalId,
        evaluatedPrHeadSha: selection.evaluatedPrHeadSha,
        currentHeadSha: identity.head_sha,
      }));
      return;
    }
    console.log(JSON.stringify({
      ok: false,
      reason: selection.reason,
      currentHeadSha: identity.head_sha,
      candidates: selection.diagnostics.candidates,
    }));
  },
});
