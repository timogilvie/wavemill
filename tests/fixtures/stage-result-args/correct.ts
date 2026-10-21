// HOK-3242: positive counterpart to ./swapped.ts. This file must
// type-check clean against the current `readStageResult` signature so the
// swap-detection test can tell a signature regression from an unrelated
// baseline error elsewhere.
import { readStageResult } from './signature.ts';

async function correct() {
  const featureDir = '/some/path';
  await readStageResult(featureDir, 'ready');
  await readStageResult({ featureDir, stage: 'ready' });
}
correct();
