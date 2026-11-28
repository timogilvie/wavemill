// allow-incident-currentness: this is the invariant definition.
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const INCIDENT_CURRENTNESS_GUARD: GuardSpec = {
  name: 'incident-currentness', findingNoun: 'private incident currentness decision(s)',
  invariantDocs: ['docs/invariants/incident-currentness.md'],
  suppressionMarker: 'allow-incident-currentness', allowlistFile: 'tools/incident-currentness-allowlist.txt',
  invariantPaths: [
    'shared/lib/wavemill-incident-detector.ts',
    'shared/lib/incident-filing-reconciler.ts',
    'shared/lib/incident-currentness-guard.ts',
    // HOK-3509: the one cross-task correlation step and its row-builder reader.
    'shared/lib/fleet-incident-correlation.ts',
    'shared/lib/incident-reconcile-cycle.ts',
  ],
  patterns: [
    { name: 'job-result-presence-classification', lang: 'ts', re: /existsSync\s*\(\s*job\.resultPath\s*\)/,
      description: 'Job incident class must come from its recorded outcome, never result-file presence.' },
    { name: 'private-job-reader', lang: 'ts', re: /function\s+read(?:AuthoritativeWorkflow)?Jobs\s*\(/,
      description: 'Read persisted jobs through readAuthoritativeWorkflowJobs in incident-filing-reconciler.ts.' },
    { name: 'result-presence-recovery', lang: 'ts', re: /\bresultExists\s*\(repoDir/,
      description: 'A filename cannot prove recovery; consume the current incident disposition.' },
    { name: 'observed-skips-recovery', lang: 'ts', re: /if \(observedFingerprints\.has\(record\.fingerprint\)\) continue/,
      description: 'Re-observation must not bypass authoritative recovery evaluation.' },
    // HOK-3509: a second cause-key derivation or a private cross-task grouping
    // defeats the one correlation step.
    { name: 'private-cause-key', lang: 'ts', re: /function\s+\w*[Cc]auseKey\s*\(/,
      description: 'The cause key lives in fleet-incident-correlation.ts; do not derive one privately.' },
    { name: 'task-less-failure-incident', lang: 'ts', re: /rootCauseClass\s*:\s*['"](?:fleet_shared_endpoint_failure|remote_dependency_rate_limited)['"]/,
      description: 'A fleet root cause class must be written through buildFleetIncident in fleet-incident-correlation.ts.' },
    { name: 'private-cross-task-grouping', lang: 'ts', re: /new\s+(?:Map|Set)<[^>]*taskId|groupBy\([^\n]*taskId|\.reduce\([^\n]*(?:taskId|attemptId)/,
      description: 'Cross-task failure grouping belongs in correlateFleetFailures in fleet-incident-correlation.ts.' },
  ],
  remediation: [
    'HOK-3324 / HOK-3509: the one incident currentness decision for job-backed records is reconcileIncidentForFiling; the one cross-task correlation step is correlateFleetFailures in fleet-incident-correlation.ts.',
    'Do not derive a cause key or group failures across tasks privately — extend fleet-incident-correlation.ts, or read the fleet cause through fleetCauseForAttempt.',
  ],
};
