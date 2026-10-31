// allow-ready-remediation-disposition: this is the invariant definition.
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

/**
 * HOK-3322: "is Ready remediation still in flight?" is decided only by
 * shared/lib/ready-remediation-disposition.ts (shell: ready_remediation_disposition).
 * A running result plus a launch head equal to HEAD is a fact about the
 * launch, not liveness; these shapes re-derive the decision privately.
 */
export const READY_REMEDIATION_DISPOSITION_GUARD: GuardSpec = {
  name: 'ready-remediation-disposition',
  findingNoun: 'private Ready remediation in-flight decision(s)',
  suppressionMarker: 'allow-ready-remediation-disposition',
  allowlistFile: 'tools/ready-remediation-disposition-allowlist.txt',
  invariantPaths: ['shared/lib/ready-remediation-disposition.ts', 'shared/lib/ready-remediation-disposition-guard.ts'],
  patterns: [
    { name: 'same-head-hold', lang: 'sh',
      re: /\$\{?\w*launch_head\}?"?\s*[!=]=\s*"?\$\{?\w*current_head|\$\{?\w*current_head\}?"?\s*[!=]=\s*"?\$\{?\w*launch_head/,
      description: 'Comparing a remediation launch head with HEAD is the retired same-head hold; read ready_remediation_disposition.' },
    { name: 'retired-shell-predicate', lang: 'sh', re: /\b(?:ready_remediation_launch_head|conflict_remediation_in_flight)\b/,
      description: 'Retired private in-flight predicate; call ready_remediation_disposition.' },
    { name: 'private-launch-identity', lang: 'sh', re: /\.detail\.launchHead\b|bounded_retry_head\b[^#]*ready-remediation/,
      description: 'Remediation launch identity is read only by readReadyRemediationLaunch.' },
    { name: 'launch-head-equality', lang: 'ts',
      re: /\b(?:remediationLaunchHead|launchHead)\s*[!=]==|[!=]==\s*[\w.?]*\b(?:remediationLaunchHead|launchHead)\b/,
      description: 'Comparing a remediation launch head with HEAD re-derives in-flight; read the ReadyRemediationDisposition.' },
    { name: 'pane-activity-in-flight', lang: 'ts', re: /\bremediationPaneActive\b/,
      description: 'Pane activity is not liveness (HOK-3101); read the ReadyRemediationDisposition.' },
    { name: 'private-launch-bucket', lang: 'ts', re: /createStateDirRetry\(\s*['"]ready-remediation['"]/,
      description: 'The ready-remediation bucket head is launch identity; read it through readReadyRemediationLaunch.' },
  ],
  remediation: [
    'Ready remediation in-flight/completion is one decision (HOK-3322):',
    '  TS: evaluateReadyRemediationDisposition / decideReadyRemediationDisposition (shared/lib/ready-remediation-disposition.ts)',
    '  shell: ready_remediation_disposition <issue> <state_dir> <wt_dir> <current_head>',
  ],
};
