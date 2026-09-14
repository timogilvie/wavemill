/**
 * Capture replay instances from incidents.
 *
 * When an incident is discovered and resolved, this module converts it into a
 * patch-selection fixture for the replay corpus. The fixture captures:
 * - The task that was being worked on
 * - The patch that failed (known-bad)
 * - The patch that fixed it (known-good)
 * - Provenance and curation status
 */

import { randomUUID } from 'node:crypto';
import type { IncidentRecord } from './wavemill-incident-model.ts';
import type {
  ReplayPatchSelectionInstance,
  ReplayPatchCandidate,
  ReplayPatchSelectionSource,
} from '../fixtures/harness-replay/patch-selection-v1/schema.ts';

export interface CaptureReplayIncidentOptions {
  /** The incident to capture */
  incident: IncidentRecord;
  /** Known-bad patch content */
  badPatchContent?: string;
  /** Known-good patch content */
  goodPatchContent?: string;
  /** Task description */
  taskDescription?: string;
  /** Task title */
  taskTitle?: string;
  /** Git SHA of the base commit */
  baseSha?: string;
  /** Whether the instance is ready for scoring (has both patches) */
  markScorable?: boolean;
}

export interface CaptureReplayIncidentResult {
  instance: ReplayPatchSelectionInstance;
  isComplete: boolean;
  missingFields: string[];
}

/**
 * Extract patch or evidence reference from incident evidence.
 */
function extractPatchesFromEvidence(evidence: IncidentRecord['evidence']): string[] {
  const patches: string[] = [];
  const seen = new Set<string>();
  for (const ev of evidence || []) {
    let patch: string | undefined;
    if (ev.type === 'diff' && typeof ev.redactedData === 'string') {
      patch = ev.redactedData;
    } else if (ev.type === 'artifact_content' && typeof ev.redactedData === 'string') {
      // Might be a patch artifact
      if (ev.redactedData.includes('---') || ev.redactedData.includes('@@')) {
        patch = ev.redactedData;
      }
    }

    if (patch && !seen.has(patch)) {
      patches.push(patch);
      seen.add(patch);
    }
  }
  return patches;
}

function firstDistinctPatch(
  patches: string[],
  excludedPatch: string | undefined,
): string | undefined {
  return patches.find((patch) => patch !== excludedPatch);
}

/**
 * Capture a replay instance from an incident.
 * Returns a partially-filled instance if patches are missing.
 * Mark `markScorable: true` only when both patches are present.
 */
export function captureReplayIncident(
  options: CaptureReplayIncidentOptions,
): CaptureReplayIncidentResult {
  const incident = options.incident;
  const evidencePatches = extractPatchesFromEvidence(incident.evidence);
  const badPatch = options.badPatchContent ?? evidencePatches[0];
  const rawGoodPatch =
    options.goodPatchContent ??
    firstDistinctPatch(evidencePatches, badPatch);
  const goodPatch = rawGoodPatch && rawGoodPatch !== badPatch ? rawGoodPatch : undefined;

  const missingFields: string[] = [];
  if (!badPatch) missingFields.push('badPatchContent');
  if (!goodPatch) missingFields.push('goodPatchContent');
  if (badPatch && rawGoodPatch && badPatch === rawGoodPatch) {
    missingFields.push('distinctGoodAndBadPatchContent');
  }
  if (!options.taskDescription && !options.taskTitle) missingFields.push('taskDescription/taskTitle');

  // Use provided values or synthesize from incident
  const taskTitle = options.taskTitle ?? `Fix for incident ${incident.fingerprint.slice(0, 8)}`;
  const taskDescription = options.taskDescription ?? `Task derived from incident: ${incident.rootCauseClass}`;

  // Build candidates
  const badCandidateId = `bad-${randomUUID()}`;
  const goodCandidateId = `good-${randomUUID()}`;

  const candidates: ReplayPatchCandidate[] = [];

  if (badPatch) {
    candidates.push({
      id: badCandidateId,
      patch: badPatch,
      patchSizeBytes: Buffer.byteLength(badPatch, 'utf8'),
      label: 'known-bad',
    });
  }

  if (goodPatch) {
    candidates.push({
      id: goodCandidateId,
      patch: goodPatch,
      patchSizeBytes: Buffer.byteLength(goodPatch, 'utf8'),
      label: 'known-good',
    });
  }

  // Build source provenance
  const source: ReplayPatchSelectionSource = {
    incidentFingerprint: incident.fingerprint,
    curationRationale: 'incident_fix',
    sanitized: true, // Assume sanitized for now; override with explicit flag if needed
  };

  // Build instance
  const instance: ReplayPatchSelectionInstance = {
    id: `incident-${incident.fingerprint.slice(0, 12)}`,
    taskTitle,
    taskDescription,
    baseSha: options.baseSha ?? incident.taskId,
    candidates,
    knownGoodCandidateId: goodCandidateId,
    knownBadCandidateIds: badPatch ? [badCandidateId] : [],
    source,
    heldOut: false,
    curatedAt: new Date().getTime(),
    notes: `Captured from incident ${incident.fingerprint.slice(0, 8)}; status: ${missingFields.length === 0 ? 'complete' : 'draft'}`,
  };

  return {
    instance,
    isComplete: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Utility: mark an instance as ready for scoring.
 * Updates heldOut and curation status.
 */
export function markInstanceReady(instance: ReplayPatchSelectionInstance, heldOut = false): ReplayPatchSelectionInstance {
  return {
    ...instance,
    heldOut,
    curatedAt: new Date().getTime(),
    notes: `${instance.notes || ''} [marked ready for scoring]`,
  };
}

/**
 * Utility: draft instance for later completion.
 */
export function markInstanceDraft(instance: ReplayPatchSelectionInstance, reason: string): ReplayPatchSelectionInstance {
  return {
    ...instance,
    notes: `${instance.notes || ''} [draft - ${reason}]`,
  };
}
