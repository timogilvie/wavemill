import type { GuardSpec } from '../../tools/lib/source-guard.ts';
export const STATE_LOCK_GUARD: GuardSpec = {
  name: 'state-lock', findingNoun: 'private state-lock site(s)', suppressionMarker: 'allow-state-lock', allowlistFile: 'tools/state-lock-allowlist.txt',
  invariantPaths: ['shared/lib/state-lock.ts', 'shared/lib/state-lock.sh', 'shared/lib/process-identity.ts', 'shared/lib/process-identity.sh', 'shared/lib/state-lock-guard.ts'],
  excludedPrefixes: ['features/', '.wavemill/', 'node_modules/', 'worktrees/', 'spike/', '.git/', 'tests/fixtures/'],
  patterns: [
    { name: 'private-lock-owner-liveness', description: 'use process-identity instead of PID-only lock-owner liveness', lang: 'sh', re: /\bkill\s+-0\s+[^\n]*(owner|holder)/ },
    { name: 'private-node-lock-owner-liveness', description: 'use process-identity instead of PID-only lock-owner liveness', lang: 'ts', re: /process\.kill\([^,]*(owner|holder)[^,]*,\s*0\)/ },
  ],
  remediation: ['Use shared/lib/state-lock.{ts,sh} and process-identity.{ts,sh}.'],
};
