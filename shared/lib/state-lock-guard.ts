import type { GuardSpec } from '../../tools/lib/source-guard.ts';
export const STATE_LOCK_GUARD: GuardSpec = {
  name: 'state-lock', findingNoun: 'private state-lock site(s)', suppressionMarker: 'allow-state-lock', allowlistFile: 'tools/state-lock-allowlist.txt',
  invariantDocs: ['docs/invariants/state-lock.md'],
  invariantPaths: ['shared/lib/state-lock.ts', 'shared/lib/state-lock.sh', 'shared/lib/process-identity.ts', 'shared/lib/process-identity.sh', 'shared/lib/state-lock-guard.ts'],
  excludedPrefixes: ['features/', '.wavemill/', 'node_modules/', 'worktrees/', 'spike/', '.git/', 'tests/'],
  patterns: [
    { name: 'private-exclusive-file-lock', description: 'use state-lock instead of an exclusive lock file', lang: 'ts', re: /\bopenSync\([^\n]*(?:lock|\.lock)[^\n]*['"]wx['"]|\bopenSync\([^\n]*['"]wx['"][^\n]*(?:lock|\.lock)/i },
    { name: 'private-directory-lock-ts', description: 'use state-lock instead of a lock directory', lang: 'ts', re: /\bmkdirSync\(\s*(?!dirname\(|path\.dirname\()[^\n]*(?:\.lock|lockPath|lock_path|lock_dir)/i },
    { name: 'private-directory-lock-sh', description: 'use state-lock instead of a lock directory', lang: 'sh', re: /\bmkdir\s+(?:-p\s+)?[^\n]*(?:\.lock|lock_path|lock_dir)/i },
    { name: 'private-flock', description: 'use state-lock instead of flock for state writes', lang: 'sh', re: /\bflock\s+(?:-[A-Za-z]+\s+)?(?:\d+|['"]?\$)/ },
    { name: 'private-shell-pid-liveness', description: 'use process-identity instead of PID-only lock-owner liveness', lang: 'sh', re: /\bkill\s+-0\s+/ },
    { name: 'private-node-pid-liveness', description: 'use process-identity instead of PID-only lock-owner liveness', lang: 'ts', re: /\bprocess\.kill\([^,]+,\s*0\)/ },
  ],
  remediation: ['Use shared/lib/state-lock.{ts,sh} and process-identity.{ts,sh}.'],
};
