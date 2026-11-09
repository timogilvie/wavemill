// allow-defect-escalation: this file *is* the defect-escalation guard spec;
// its pattern table names every forbidden shape. It is auto-excluded from its
// own scan via invariantPaths; the marker above is defensive.
/**
 * Preflight guard for the one defect escalation contract (HOK-3325): a
 * confirmed Wavemill condition that is not repairable within existing authority
 * is investigated via the root-cause skill and transported to Linear only
 * through shared/lib/incident-to-linear-synchronizer.ts.
 *
 * Shapes caught:
 * - raw-issueCreate-mutation — a direct GraphQL issueCreate mutation outside
 *   the authorised Linear-write seam in shared/lib/linear.ts.
 * - raw-createIssue-call — a call to createIssue( / client.createIssue(
 *   outside the authorised transport in shared/lib/incident-to-linear-synchronizer.ts.
 * - generateIssueBody-reference — any import or re-export of the deleted
 *   symptom-body renderer; investigated payloads are required instead.
 */
import type { GuardSpec } from '../../tools/lib/source-guard.ts';

export const DEFECT_ESCALATION_GUARD: GuardSpec = {
  name: 'defect-escalation',
  findingNoun: 'unauthorised defect escalation path(s)',
  suppressionMarker: 'allow-defect-escalation',
  allowlistFile: 'tools/defect-escalation-allowlist.txt',
  invariantPaths: [
    'shared/lib/defect-escalation-guard.ts',
    'tools/check-defect-escalation.ts', // install-paths: allow invariantPaths list, not an argv target
    'shared/lib/linear.ts', // authorised Linear-write seam
  ],
  patterns: [
    {
      name: 'raw-issueCreate-mutation',
      description: 'raw issueCreate GraphQL mutation — route Linear writes through shared/lib/incident-to-linear-synchronizer.ts',
      lang: 'ts',
      re: /issueCreate\s*\(/,
    },
    {
      name: 'raw-createIssue-call',
      description: 'raw createIssue call — route Linear writes through shared/lib/incident-to-linear-synchronizer.ts',
      lang: 'ts',
      re: /\bcreateIssue\s*\(/,
      excludePaths: ['shared/lib/incident-to-linear-synchronizer.ts'],
    },
    {
      name: 'generateCommentBody-reference',
      description: 'reference to deleted uninvestigated comment renderer — transport investigated payloads only',
      lang: 'ts',
      re: /\bgenerateCommentBody\b/,
    },
    {
      name: 'generateIssueBody-reference',
      description: 'reference to deleted symptom-body renderer — use the root-cause investigation payload instead',
      lang: 'ts',
      re: /\bgenerateIssueBody\b/,
    },
  ],
  remediation: [
    'HOK-3325: exactly one defect escalation path governed by the root-cause skill.',
    'Route all Linear writes through shared/lib/incident-to-linear-synchronizer.ts',
    'and render only investigated payloads from shared/lib/root-cause-escalation.ts.',
  ],
};
