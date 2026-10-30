// allow-incident-currentness: this is the invariant definition.
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const INCIDENT_CURRENTNESS_GUARD: GuardSpec = {
  name: 'incident-currentness', findingNoun: 'private incident currentness decision(s)',
  suppressionMarker: 'allow-incident-currentness', allowlistFile: 'tools/incident-currentness-allowlist.txt',
  invariantPaths: ['shared/lib/incident-filing-reconciler.ts', 'shared/lib/incident-currentness-guard.ts'],
  patterns: [
    { name: 'private-job-reader', lang: 'ts', re: /function\s+read(?:AuthoritativeWorkflow)?Jobs\s*\(/,
      description: 'Read persisted jobs through readAuthoritativeWorkflowJobs in incident-filing-reconciler.ts.' },
    { name: 'result-presence-recovery', lang: 'ts', re: /\bresultExists\s*\(repoDir/,
      description: 'A filename cannot prove recovery; consume the current incident disposition.' },
    { name: 'observed-skips-recovery', lang: 'ts', re: /if \(observedFingerprints\.has\(record\.fingerprint\)\) continue/,
      description: 'Re-observation must not bypass authoritative recovery evaluation.' },
  ],
};
