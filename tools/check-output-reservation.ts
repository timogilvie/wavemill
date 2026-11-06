#!/usr/bin/env -S npx tsx
/** Preflight: input reservations cannot decide a transport's generated-output cap. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGuardCli, type GuardSpec } from './lib/source-guard.ts';

export const OUTPUT_RESERVATION_GUARD: GuardSpec = {
  name: 'output-reservation',
  findingNoun: 'output reservation/cap conflation(s)',
  suppressionMarker: 'allow-output-reservation',
  allowlistFile: 'tools/output-reservation-allowlist.txt',
  invariantPaths: ['tools/check-output-reservation.ts'], // install-paths: allow source-guard file identity, not an executable argv
  patterns: [
    {
      name: 'reservation-as-invocation-cap',
      description: 'Input preflight reserves context space; only an explicit invocation cap may limit generated output.',
      lang: 'ts',
      scopedPaths: ['shared/lib/model-adapters/'],
      re: /\bmaxOutputTokens\s*:\s*[^\n;]*\breservedOutputTokens\b/,
    },
    {
      name: 'native-ceiling-in-cli-review',
      description: 'CLI review uses its transport adapter contract, not the native concise-JSON output ceiling.',
      lang: 'ts',
      scopedPaths: ['shared/lib/review-engine.ts'],
      re: /\bREVIEW_MAX_OUTPUT_TOKENS\b/,
    },
  ],
  remediation: [
    'Expose preflight output space as AdapterLimits.reservedOutputTokens.',
    'Keep explicit AdapterInvokeOptions.maxOutputTokens separate; let the CLI own its model-aware default.',
  ],
};

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] === filename) {
  runGuardCli(OUTPUT_RESERVATION_GUARD, process.argv[2] ?? join(dirname(filename), '..'));
}
