// HOK-3242: deliberate swap fixture. Running `npx tsc --noEmit` on this
// file must produce a type error on the swapped-argument call so a
// regression of the HOK-3242 class (fixed in #1651) cannot land again.
// Positive counterpart lives next door at `./correct.ts`.
//
// The signature is kept locally in `./signature.ts` because the real
// `shared/lib/stage-result.ts` module transitively imports several files
// whose types are pre-existing-red under `tsconfig.static.json`, which
// would drown out the swap detection noise.
import { readStageResult } from './signature.ts';

async function swapped() {
  const featureDir = '/some/path';
  // Second arg is a path, not a StageName — must fail type-check.
  await readStageResult('ready', featureDir);
  // Object form: `stage` is a path, not a StageName — must fail type-check.
  await readStageResult({ featureDir: 'ready', stage: featureDir });
}
swapped();
