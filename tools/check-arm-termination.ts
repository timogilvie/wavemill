#!/usr/bin/env -S npx tsx
/** Preflight guard for the one arm-termination recorder (HOK-3358). */
import { resolve } from 'node:path';
import { runGuardCli, type GuardSpec } from './lib/source-guard.ts';

const spec: GuardSpec = {
  name: 'arm-termination',
  findingNoun: 'arm-termination invariant violation(s)',
  suppressionMarker: 'allow-arm-termination',
  allowlistFile: 'tools/arm-termination-allowlist.txt',
  invariantPaths: ['shared/lib/arm-termination.ts', 'shared/lib/arm-termination-guard.ts', 'tools/check-arm-termination.ts'],
  patterns: [
    { name: 'challenge-aborted-write', description: 'direct challengeAborted writes must use recordArmTermination', lang: 'both', re: /\.challengeAborted\s*=(?!=)/ },
    { name: 'stored-fault-class', description: 'fault class must be derived by classifyArmFault', lang: 'ts', re: /faultClass\s*:\s*'(?:harness|selection|provider|model|unknown)-fault'/, excludePaths: ['shared/lib/arm-failure-taxonomy.ts'] },
    { name: 'retired-operator-marker', description: 'OPERATOR_ABORT_MARKER is retired; use a typed failure kind', lang: 'both', re: /OPERATOR_ABORT_MARKER/ },
  ],
  remediation: ['Route the termination through recordArmTermination and derive its fault class.'],
};

runGuardCli(spec, resolve(process.argv[2] ?? '.'));
