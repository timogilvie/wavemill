import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import { computeForkIdentity } from '../shared/lib/fork-identity.ts';
import type { ChallengeStage } from '../shared/lib/challenge-mode.ts';

const INSTALL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = new Set(['plan', 'implementation', 'review']);

function parseStages(raw: string | undefined, flag: string): ChallengeStage[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((stage) => !STAGES.has(stage))) {
    throw new Error(`${flag} must be a JSON array of challenge stages`);
  }
  return parsed as ChallengeStage[];
}

runTool({
  name: 'compute-fork-identity',
  description: 'Compute the ForkIdentity envelope for a challenge pair at fork materialisation',
  options: {
    'repo-dir': { type: 'string', description: 'Repository root' },
    'fork-stage': { type: 'string', description: 'Stage at which the pair forks (plan|implementation|review)' },
    'fork-commit': { type: 'string', description: 'Shared commit both arms start from' },
    'primary-worktree': { type: 'string', description: 'Primary arm worktree root' },
    'challenger-worktree': { type: 'string', description: 'Challenger arm worktree root' },
    'primary-feature-dir': { type: 'string', description: 'Primary arm feature dir' },
    'challenger-feature-dir': { type: 'string', description: 'Challenger arm feature dir' },
    'primary-inherited': { type: 'string', description: 'JSON array of stages the primary inherited (default [])' },
    'challenger-inherited': { type: 'string', description: 'JSON array of stages the challenger inherited (default [])' },
    diagnostics: { type: 'boolean', description: 'Emit {identity, diagnostics} instead of the bare identity' },
  },
  examples: [
    'npx tsx tools/compute-fork-identity.ts --repo-dir . --fork-stage review --fork-commit HEAD \\',
    '  --primary-worktree wt/a --challenger-worktree wt/a-challenger \\',
    '  --primary-feature-dir wt/a/features/a --challenger-feature-dir wt/a-challenger/features/a-challenger \\',
    '  --challenger-inherited \'["plan","implementation"]\'',
  ],
  async run({ args }) {
    const required = [
      'repo-dir', 'fork-stage', 'fork-commit',
      'primary-worktree', 'challenger-worktree',
      'primary-feature-dir', 'challenger-feature-dir',
    ] as const;
    for (const flag of required) {
      if (!args[flag]) throw new Error(`--${flag} is required`);
    }
    const forkStage = String(args['fork-stage']);
    if (!STAGES.has(forkStage)) throw new Error(`--fork-stage must be one of plan|implementation|review`);

    const result = computeForkIdentity({
      repoDir: resolve(String(args['repo-dir'])),
      installDir: INSTALL_DIR,
      forkStage: forkStage as ChallengeStage,
      forkCommit: String(args['fork-commit']),
      primaryWorktree: resolve(String(args['primary-worktree'])),
      challengerWorktree: resolve(String(args['challenger-worktree'])),
      primaryFeatureDir: resolve(String(args['primary-feature-dir'])),
      challengerFeatureDir: resolve(String(args['challenger-feature-dir'])),
      primaryInheritedStages: parseStages(args['primary-inherited'] as string | undefined, '--primary-inherited'),
      challengerInheritedStages: parseStages(args['challenger-inherited'] as string | undefined, '--challenger-inherited'),
    });
    console.log(JSON.stringify(args.diagnostics ? result : result.identity));
  },
});
