/**
 * HOK-3231 — Shared Observer incident cycle.
 *
 * One pass of the Observer's incident loop: dedupe candidates, upsert each
 * through `IncidentStore`, run authoritative currentness for job-backed
 * records, evaluate recovery predicates for everything else, and finish with
 * `runResolutionSweep` under the caller's absence gate. The Observer's
 * `reconcileIncidents` composes this with its own candidate collection and
 * finding emission; the HOK-3231 replay harness feeds synthesised candidates
 * from recorded evidence.
 *
 * The code is a verbatim move of the body between
 * `tools/observer.ts :: reconcileIncidents` and the sweep call. Errors are
 * surfaced as typed `errors[]` instead of findings; the Observer wraps them.
 *
 * @module incident-reconcile-cycle
 */

import {
  isJobBackedIncident,
  reconcileIncidentForFiling,
  readAuthoritativeWorkflowJobs,
} from './incident-filing-reconciler.ts';
import { evaluateRecoveryPredicate, type RecoveryReaders } from './wavemill-incident-recovery.ts';
import type { IncidentRecord } from './wavemill-incident-model.ts';
import type { IncidentStore } from './wavemill-incident-store.ts';

export interface IncidentCycleInput {
  /** The shared store the cycle writes to. */
  store: IncidentStore;
  /** Candidates collected this cycle, already deduplicated by the caller. */
  candidates: IncidentRecord[];
  /**
   * Whether candidate collection fully completed. The resolution sweep only
   * runs on a complete cycle; a partial cycle preserves open records.
   */
  cycleComplete: boolean;
  /** Repo path used for recovery readers and authoritative job reads. */
  repoDir: string;
  /** Pre-read job snapshot (one read per Observer tick). */
  jobs?: ReturnType<typeof readAuthoritativeWorkflowJobs>;
  /**
   * Absence gate: when it returns false, missed cycles still accrue but the
   * record stays active (see HOK-3045).
   */
  canResolveByAbsence?: (record: IncidentRecord) => boolean;
  /** Injectable recovery readers (test seam; defaults match production). */
  recoveryReaders?: Partial<RecoveryReaders>;
}

export type IncidentCycleErrorKind = 'store' | 'recovery' | 'sweep';

export interface IncidentCycleError {
  kind: IncidentCycleErrorKind;
  error: Error;
  incident?: IncidentRecord;
}

export interface IncidentCycleResult {
  /** Incidents observed or persisted this cycle (fresh + still-open job-backed). */
  incidents: IncidentRecord[];
  /** Fingerprints that produced a fresh event this cycle. */
  fresh: string[];
  /** Fingerprints that were observed (fresh or re-poll). */
  observed: string[];
  /** Records that transitioned to resolved via a recovery predicate. */
  recovered: Array<{ fingerprint: string; rootCauseClass: string; reason: string; evidence?: string }>;
  /** Typed errors; the caller may map these to findings. */
  errors: IncidentCycleError[];
}

/**
 * One cycle of the Observer's incident loop. Pure with respect to the store:
 * the store itself is where state changes land.
 *
 * This is the body between `tools/observer.ts :: reconcileIncidents` upsert
 * and the sweep call. The Observer's `reconcileIncidents` composes this with
 * its own candidate collection and translates errors into findings.
 */
export async function reconcileIncidentCycle(
  input: IncidentCycleInput,
): Promise<IncidentCycleResult> {
  const errors: IncidentCycleError[] = [];
  const incidents: IncidentRecord[] = [];
  const freshFingerprints: string[] = [];
  const observedFingerprints = new Set<string>();
  const recovered: IncidentCycleResult['recovered'] = [];

  for (const candidate of input.candidates) {
    try {
      const { record: stored, freshEvent } = await input.store.upsertDetailed(candidate);
      if (freshEvent) freshFingerprints.push(stored.fingerprint);
      observedFingerprints.add(stored.fingerprint);
      incidents.push(stored);
    } catch (error) {
      errors.push({ kind: 'store', error: toError(error), incident: candidate });
    }
  }

  if (!input.cycleComplete) {
    return { incidents, fresh: freshFingerprints, observed: [...observedFingerprints], recovered, errors };
  }

  const jobs = input.jobs ?? readAuthoritativeWorkflowJobs(input.repoDir);

  try {
    for (const record of await input.store.getIncidents()) {
      const current = reconcileIncidentForFiling(record, input.repoDir, jobs);
      const jobBacked = isJobBackedIncident(record);
      if (!jobBacked && observedFingerprints.has(record.fingerprint)) continue;
      const recovery = jobBacked
        ? {
            satisfied: current.outcome === 'recovered' || current.outcome === 'superseded',
            reason: `current_disposition:${current.outcome}`,
            evidence: JSON.stringify(current.evidence),
          }
        : evaluateRecoveryPredicate(record, input.repoDir, input.recoveryReaders ?? {});
      if (jobBacked && !recovery.satisfied && !observedFingerprints.has(record.fingerprint)) {
        incidents.push(record);
        observedFingerprints.add(record.fingerprint);
      }
      if (!recovery.satisfied || !recovery.reason) continue;
      const resolved = await input.store.autoResolve(record.fingerprint, { reason: recovery.reason });
      if (resolved) {
        recovered.push({
          fingerprint: resolved.fingerprint,
          rootCauseClass: resolved.rootCauseClass,
          reason: recovery.reason,
          ...(recovery.evidence ? { evidence: recovery.evidence } : {}),
        });
      }
    }
  } catch (error) {
    errors.push({ kind: 'recovery', error: toError(error) });
  }

  try {
    await input.store.runResolutionSweep(
      { fresh: freshFingerprints, observed: observedFingerprints },
      input.canResolveByAbsence
        ? (record) => !isJobBackedIncident(record) && input.canResolveByAbsence!(record)
        : (record) => !isJobBackedIncident(record),
    );
  } catch (error) {
    errors.push({ kind: 'sweep', error: toError(error) });
  }

  return { incidents, fresh: freshFingerprints, observed: [...observedFingerprints], recovered, errors };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
