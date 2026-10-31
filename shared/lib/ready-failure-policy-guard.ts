// allow-ready-failure-policy: this file *is* the Ready-failure-policy guard;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan (see invariantPaths); the marker above is defensive.
/**
 * Preflight guard for the one Ready-failure disposition (HOK-3371): every
 * Ready-failure branch in the monitor is classified by the single failure
 * policy (`failure_policy_decide` / `classifyFailure`) through
 * `ready_failure_classify_and_act`. A Ready-failure branch that acts on a
 * stage name, a private counter, or a bare default is exactly what the
 * invariant forbids.
 *
 * Shapes caught:
 * - a Ready-failure branch (the `set_ready_pass_labels` failure caller, the
 *   `ready_status == failed` block) with no policy call in its block;
 * - the `transition_stage="github-api"` magic default that used to hide every
 *   untyped failure as a GitHub API failure;
 * - any live reference to the retired `failed-ready-recheck` private bucket
 *   (the upgrade-compatibility shims in bounded-retry.sh /
 *   condition-reconciler.sh / ledger-consistency.ts / observer.ts are
 *   allowlisted with a reason; the ratchet forces them out once they go).
 */
import type { GuardSpec, StructuralMatch } from '../../tools/lib/source-guard.ts';

/** How far past an anchor the enclosing Ready-failure branch can extend. */
const MAX_BRANCH_LINES = 60;

const POLICY_CALL = /failure_policy_decide|classifyFailure|ready_failure_classify_and_act/;

export const READY_FAILURE_POLICY_GUARD: GuardSpec = {
  name: 'ready-failure-policy',
  findingNoun: 'unclassified Ready-failure branch(es)',
  suppressionMarker: 'allow-ready-failure-policy',
  allowlistFile: 'tools/ready-failure-policy-allowlist.txt',
  invariantPaths: [
    'shared/lib/ready-failure-policy-guard.ts',
  ],
  structuralChecks: [{
    name: 'ready-failure-branch-without-policy',
    description: 'a Ready-failure branch that never names the failure policy; route it through ready_failure_classify_and_act',
    paths: ['shared/lib/wavemill-monitor.sh'],
    find(source) {
      const lines = source.split('\n');
      const findings: StructuralMatch[] = [];
      // Each anchor opens a Ready-failure branch: the set_ready_pass_labels
      // failure caller (records the typed transitionFailure) and the
      // failed-status block (the one dispatch site). The policy call — or the
      // documented handoff to ready_failure_classify_and_act — must appear
      // within the branch's own lines.
      const anchors: ReadonlyArray<RegExp> = [
        /if ! label_output=\$\(set_ready_pass_labels/,
        /if \[\[ "\$ready_status" == "failed" \]\]; then/,
      ];
      for (let i = 0; i < lines.length; i += 1) {
        let matched = false;
        for (const anchor of anchors) {
          if (!anchor.test(lines[i])) continue;
          matched = true;
          break;
        }
        if (!matched) continue;
        const end = Math.min(lines.length, i + MAX_BRANCH_LINES);
        if (!POLICY_CALL.test(lines.slice(i, end).join('\n'))) {
          findings.push({ line: i + 1, detail: `anchor matched line ${i + 1}` });
        }
      }
      return findings;
    },
  }],
  patterns: [
    {
      name: 'github-api-fallback-stage-default',
      description: 'the `transition_stage=github-api` default hides the real failure; keep the failure untyped and let the policy classify the detail',
      lang: 'sh',
      re: /transition_stage=["']?github-api["']?/,
    },
    {
      name: 'legacy-failed-ready-recheck-bucket',
      description: 'the private failed-ready-recheck counter is retired; use the shared stage-failure-ready bucket via maybe_retry_failed_stage',
      lang: 'both',
      re: /failed[-_]ready[-_]recheck/,
    },
  ],
  remediation: [
    'Every Ready failure is classified through ready_failure_classify_and_act',
    '(HOK-3371): base drift first, then failure_policy_decide against the',
    'recorded evidence — terminal retires a challenge arm, code-failure from a',
    'transition tool goes to the operator with the excerpt, everything else',
    'relaunches through the shared stage-failure-ready bounded budget. Never',
    'add a stage-name switch or a private Ready retry counter.',
  ],
};