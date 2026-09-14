import { readFileSync } from 'node:fs';
import { runWavemillRouterEval, runPatchSelectionEval } from '../src/evaluation/adapters/wavemill-router-adapter.ts';

interface CliArgs {
  policy?: 'replay_exact_match' | 'challenge_prospective';
  fixture?: string;
  evalsDir?: string;
  repoDir?: string;
  persist?: boolean;
  modelsAvailable?: string[];
  patchSelectionCorpus?: string;
  corpus?: string;
  split?: 'train' | 'held-out' | 'all';
  selections?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--policy' && next) {
      args.policy = next as CliArgs['policy'];
      index += 1;
    } else if (token === '--fixture' && next) {
      args.fixture = next;
      index += 1;
    } else if (token === '--evals-dir' && next) {
      args.evalsDir = next;
      index += 1;
    } else if (token === '--repo-dir' && next) {
      args.repoDir = next;
      index += 1;
    } else if (token === '--persist') {
      args.persist = true;
    } else if (token === '--models-available' && next) {
      args.modelsAvailable = next.split(',').map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (token === '--patch-selection-corpus' && next) {
      args.patchSelectionCorpus = next;
      index += 1;
    } else if (token === '--corpus' && next) {
      args.corpus = next;
      index += 1;
    } else if (token === '--split' && next) {
      args.split = next as CliArgs['split'];
      index += 1;
    } else if (token === '--selections' && next) {
      args.selections = next;
      index += 1;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = args.repoDir ?? process.cwd();

  // Check if this is a patch-selection evaluation
  const manifestPath = args.patchSelectionCorpus ?? args.corpus;
  if (manifestPath) {
    const selections = args.selections
      ? JSON.parse(readFileSync(args.selections, 'utf-8'))
      : undefined;
    const result = await runPatchSelectionEval({
      manifestPath,
      split: args.split ?? 'train',
      modelsAvailable: args.modelsAvailable,
      repoDir,
      selections,
    });

    console.log(JSON.stringify({
      patch_selection_accuracy: result.score.patch_selection_accuracy,
      diagnostics: result.score.wavemill_router_diagnostics,
      loadInfo: result.loadInfo,
    }, null, 2));
    return;
  }

  // Otherwise, run traditional router eval
  const fixture = args.fixture;
  const evalsDir = args.evalsDir ?? (fixture ? `${fixture}/evals` : undefined);
  const artifactsDir = fixture ? `${fixture}/artifacts` : undefined;

  if (!args.policy) {
    throw new Error('Missing required --policy argument');
  }

  const result = await runWavemillRouterEval({
    repoDir,
    policy: args.policy,
    evalsDir,
    artifactsDir,
    persist: args.persist ?? false,
    modelsAvailable: args.modelsAvailable,
  });

  console.log(JSON.stringify(result.hemRecord, null, 2));
}

await main();
