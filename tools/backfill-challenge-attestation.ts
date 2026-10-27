#!/usr/bin/env -S npx tsx

import { join, resolve } from 'node:path';
import { backfillChallengeAttestation } from '../shared/lib/challenge-attestation-backfill.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

function defaultEvalLog(repoDir: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');
}

runTool({
  name: 'backfill-challenge-attestation',
  description: 'Quarantine challenge eval records whose execution evidence disagrees with their intent',
  options: {
    file: { type: 'string', description: 'JSONL eval log (default: configured evals/evals.jsonl)' },
    'repo-dir': { type: 'string', description: 'Repository root used to resolve the default eval log' },
    apply: { type: 'boolean', description: 'Rewrite the JSONL file in place; default is dry-run' },
    'dry-run': { type: 'boolean', description: 'Report changes without writing (default)' },
  },
  examples: [
    'npx tsx tools/backfill-challenge-attestation.ts',
    'npx tsx tools/backfill-challenge-attestation.ts --file .wavemill/evals/evals.jsonl --apply',
  ],
  run({ args }) {
    const repoDir = resolve((args['repo-dir'] as string | undefined) || '.');
    const file = args.file ? resolve(args.file as string) : defaultEvalLog(repoDir);
    const summary = backfillChallengeAttestation({
      file,
      apply: args.apply === true,
      repoDir,
    });
    console.log(JSON.stringify(summary, null, 2));
  },
});
