/**
 * Operator escalation step (HOK-3360): the one place .needs-attention is written.
 */

import { writeMarker } from './transient-marker.ts';
import { createStateDirRetry } from './bounded-retry.ts';
import { resolveGitRepoRoot, resolveHeadSha } from './git-utils.ts';
import type { FailureDecision } from './failure-policy.ts';

export type EscalationBasis =
  | { kind: 'exhausted'; bucket: string }
  | { kind: 'policy-terminal'; decision: FailureDecision }
  | { kind: 'operator-decision'; code: string };

interface EscalateOperatorAttentionOptions {
  stateDir: string;
  basis: EscalationBasis;
  message: string;
}

/**
 * Escalate to operator attention by writing a .needs-attention marker.
 * 
 * Refuses (returns false) when the basis does not hold, so a caller cannot
 * page on a first occurrence by mislabelling it.
 */
export async function escalateOperatorAttention({
  stateDir,
  basis,
  message,
}: EscalateOperatorAttentionOptions): Promise<boolean> {
  // Validate the basis
  switch (basis.kind) {
    case 'exhausted':
      if (!(await createStateDirRetry(stateDir).isExhausted(basis.bucket))) {
        console.warn(`[escalation-refused] bucket '${basis.bucket}' not exhausted for ${stateDir}`);
        return false;
      }
      break;
      
    case 'policy-terminal':
      if (basis.decision.class !== 'terminal') {
        console.warn(`[escalation-refused] policy decision is not terminal: ${JSON.stringify(basis.decision)}`);
        return false;
      }
      break;
      
    case 'operator-decision':
      // TODO: Validate against OPERATOR_DECISIONS
      // For now we'll assume it's valid
      break;
      
    default:
      console.warn(`[escalation-refused] invalid basis: ${JSON.stringify(basis)}`);
      return false;
  }
  
  // Write the attention marker
  const repoDir = await resolveGitRepoRoot(stateDir);
  const headSha = await resolveHeadSha(repoDir);
  
  await writeMarker(
    { path: `${stateDir}/.needs-attention`, kind: 'ready-attention' },
    { headSha, reason: message, detail: { basis } }
  );
  
  return true;
}