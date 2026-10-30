// allow-ready-disposition: this file *is* the Ready remediation disposition
// guard; its pattern table names every forbidden shape. It is auto-excluded
// from its own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one Ready remediation disposition (HOK-3322): "is
 * Ready remediation still in flight?" is decided only by
 * `decideReadyRemediationDisposition` (shared/lib/ready-remediation-disposition.ts)
 * and its shell twin `ready_remediation_disposition`
 * (shared/lib/ready-remediation-disposition.sh).
 *
 * The HOK-3316 incident: the monitor held a PR in Ready forever on
 * `status running + retry launch head == current head` after the remediation
 * agent re-ran flaky CI green without pushing and settled idle, while the
 * watchdog's private copy saw the idle owner. A running result and a matching
 * launch SHA are facts about a launch, not liveness.
 *
 * Shapes caught:
 * - a TS comparison against a remediation launch head
 *   (`remediationLaunchHead` / `launchHead` with `===` / `!==`);
 * - a shell comparison against a launch head variable
 *   (`$launch_head`, `$remediation_launch_head`, `$conflict_launch_head`
 *   with `==` / `!=`);
 * - the retired watchdog override that let `agentIdle` rewrite pane
 *   ownership (`paneActive … agentIdle`).
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const READY_DISPOSITION_GUARD: GuardSpec = {
  name: 'ready-disposition',
  findingNoun: 'private Ready remediation in-flight decision(s)',
  suppressionMarker: 'allow-ready-disposition',
  allowlistFile: 'tools/ready-disposition-allowlist.txt',
  invariantPaths: [
    'shared/lib/ready-remediation-disposition.ts',
    'shared/lib/ready-remediation-disposition.sh',
    'shared/lib/ready-disposition-guard.ts',
  ],
  patterns: [
    {
      name: 'launch-head-equality',
      description: 'private launch-head comparison — read decideReadyRemediationDisposition(...).kind (or ReadyTaskSnapshot.remediationDisposition)',
      lang: 'ts',
      re: /\b(?:remediationLaunchHead|launchHead)\b\s*(?:===|!==)|(?:===|!==)\s*[\w.$?]*\b(?:remediationLaunchHead|launchHead)\b/,
    },
    {
      name: 'shell-launch-head-equality',
      description: 'private launch-head comparison — call ready_remediation_disposition <issue> <state_dir> <launch_head> <current_head>',
      lang: 'sh',
      re: /\$\{?(?:remediation_|conflict_)?launch_head\}?"?\s*(?:==|!=)|(?:==|!=)\s*"?\$\{?(?:remediation_|conflict_)?launch_head\b/,
    },
    {
      name: 'pane-idle-override',
      description: 'private agentIdle override of pane ownership — the disposition derives the owner from task-progress and the pane fact',
      lang: 'ts',
      re: /\bpaneActive\b.*\bagentIdle\b|\bagentIdle\b.*\bpaneActive\b/,
    },
  ],
  remediation: [
    'Every Ready remediation in-flight/completion decision goes through the one',
    'disposition (HOK-3322): decideReadyRemediationDisposition in TypeScript,',
    'ready_remediation_disposition in shell. A running Ready result and a matching',
    'launch SHA are facts, not liveness; the owner comes from task-progress.',
  ],
};
