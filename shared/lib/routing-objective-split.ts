/**
 * Deterministically assigns a Hokusai routing objective to a task identity.
 *
 * The assignment is based on the base Linear issue ID, so challenge arms and
 * re-routes remain on the same experimental arm.
 */

import { createHash } from 'node:crypto';
import type { HokusaiModel30Objective } from './hokusai-schema.ts';
import { parseTaskId } from './task-identity.ts';

/**
 * Return the stable routing objective for a valid task ID.
 *
 * Invalid IDs deliberately return undefined so callers preserve Hokusai's
 * existing server-default behavior rather than assigning an arbitrary arm.
 */
export function deriveRoutingObjectiveForIssue(taskId: string): HokusaiModel30Objective | undefined {
  const parsed = parseTaskId(taskId);
  if (!parsed) return undefined;

  const firstByte = createHash('sha256').update(parsed.linearId).digest()[0];
  return firstByte % 2 === 0 ? 'lowest_cost' : 'highest_reliability';
}
