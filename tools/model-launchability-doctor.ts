#!/usr/bin/env tsx
import { buildLaunchabilityMatrix, LAUNCHABILITY_STAGES } from '../shared/lib/launchable-models.ts';
import { exitOnHelp } from '../shared/lib/tool-runner.ts';

function parseArgs(argv: string[]): { repoDir?: string; json: boolean; certificationRoot?: string } {
  const parsed: { repoDir?: string; json: boolean; certificationRoot?: string } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--repo-dir') {
      parsed.repoDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--certification-root') {
      parsed.certificationRoot = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return parsed;
}

exitOnHelp(
  'Usage: npx tsx tools/model-launchability-doctor.ts [--repo-dir DIR] [--certification-root DIR] [--json]\n'
    + 'Shows which models each stage can launch, and why the others are blocked.',
);
const options = parseArgs(process.argv.slice(2));
const matrix = buildLaunchabilityMatrix({
  repoDir: options.repoDir,
  certificationRoot: options.certificationRoot,
});

if (options.json) {
  console.log(JSON.stringify(matrix, null, 2));
  process.exit(0);
}

console.log(`Model launchability doctor (${matrix.repoDir})`);
console.log('');
for (const stage of LAUNCHABILITY_STAGES) {
  console.log(`${stage}: ${matrix.advertisedModels[stage].join(', ') || '(none)'}`);
}
console.log('');

const blockerEntries = Object.entries(matrix.blockers).sort(([left], [right]) => left.localeCompare(right));
if (blockerEntries.length === 0) {
  console.log('No blockers.');
} else {
  console.log('Blockers:');
  for (const [reason, cells] of blockerEntries) {
    const labels = cells
      .map((cell) => `${cell.modelId}:${cell.stage}`)
      .sort()
      .join(', ');
    console.log(`- ${reason}: ${labels}`);
  }
}
