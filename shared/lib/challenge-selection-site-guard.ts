import type { GuardSpec } from '../tools/lib/source-guard.ts';

/** Preflight guard for HOK-3506: challenge-vs-single is decided once at launch. */
export const CHALLENGE_SELECTION_SITE_GUARD: GuardSpec = {
  name: 'challenge-selection-site',
  findingNoun: 'challenge-selection re-roll site(s)',
  suppressionMarker: 'allow-challenge-selection-site',
  allowlistFile: 'tools/challenge-selection-site-allowlist.txt',
  invariantPaths: [
    'docs/invariants/challenge-route.md',
    'shared/lib/challenge-selection-site-guard.ts',
    'shared/lib/challenge-selection-site-guard.test.ts',
  ],
  invariantDocs: ['docs/invariants/challenge-route.md'],
  patterns: [
    { name: 'sh-run-tool-no-resolve-sealed', description: 'resolve-challenge-task.ts must use --resolve-sealed outside the launch lottery', lang: 'sh', re: /^(?!.*--resolve-sealed).*resolve-challenge-task\.ts/ },
    { name: 'sh-challenger-never-launched', description: 'challenger_never_launched is the historic symptom of a phantom pair', lang: 'sh', re: /challenger_never_launched/ },
  ],
  remediation: ['Challenge-vs-single is decided once at launch; readers must use resolve-challenge-task.ts --resolve-sealed.', 'Suppress the two launch sites inline with # allow-challenge-selection-site: launch.'],
};
