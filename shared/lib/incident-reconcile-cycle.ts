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
import {
  buildFleetIncident,
  correlateFleetFailures,
  coveredTaskCandidates,
  jobFailureFacts,
  readTaskFailureFacts,
  type FailureFact,
  type FleetCorrelation,
} from './fleet-incident-correlation.ts';

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
  /**
   * HOK-3509 — fleet-cause correlation. When present, the cycle reads
   * per-task failure facts, groups them by cause key, upserts one fleet
   * incident for each correlation, and drops any candidate covered by one.
   * Unset: behaviour is unchanged (back-compat for existing replay fixtures).
   */
  failureSources?: Array<{ taskId: string; featureDir: string }>;
  correlation?: { windowMs: number; threshold: number; session?: string | null; now?: Date };
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
  /** HOK-3509: the fleet correlations the cycle upserted, if any. */
  fleetIncidents?: FleetCorrelation[];
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

  // HOK-3509 — fleet correlation.
  // When the caller supplied failure sources and a correlation config, read
  // per-task facts + job facts, group by cause key, and upsert a fleet
  // incident per correlation. Covered per-task candidates are dropped so a
  // fleet record replaces the N task records it stands in for.
  const correlations: FleetCorrelation[] = [];
  let effectiveCandidates = input.candidates;
  if (input.correlation && input.failureSources?.length) {
    const now = (input.correlation.now ?? new Date()).getTime();
    const windowMs = input.correlation.windowMs;
    const facts: FailureFact[] = [];
    for (const source of input.failureSources) {
      try {
        facts.push(...readTaskFailureFacts({ taskId: source.taskId, featureDir: source.featureDir, now, windowMs }));
      } catch {
        // Fail-soft: one bad task must not break the cycle.
      }
    }
    const jobs = input.jobs ?? readAuthoritativeWorkflowJobs(input.repoDir);
    facts.push(...jobFailureFacts(jobs.jobs ?? [], now, windowMs));
    const grouped = correlateFleetFailures(facts, { windowMs, threshold: input.correlation.threshold });
    correlations.push(...grouped);
    if (correlations.length > 0) {
      const covered = new Set(coveredTaskCandidates(input.candidates, correlations));
      effectiveCandidates = [
        ...input.candidates.filter((candidate) => !covered.has(candidate)),
        ...correlations.map((correlation) => buildFleetIncident(correlation, {
          session: input.correlation?.session ?? null,
          now: new Date(now),
        })),
      ];
    }
  }

  for (const candidate of effectiveCandidates) {
    try {
      const { record: stored, freshEvent } = await input.store.upsertDetailed(candidate);
      if (freshEvent) freshFingerprints.push(stored.fingerprint);
      observedFingerprints.add(stored.fingerprint);
      incidents.push(stored);
    } catch (error) {
      errors.push({ kind: 'store', error: toError(error), incident: candidate });
    }
  }

  // A failed persistence attempt leaves the observed set incomplete. Do not
  // evaluate recovery or accrue an absence miss from a partial cycle: an
  // existing record could otherwise be resolved while its re-observation
  // could not be written.
  if (!input.cycleComplete || errors.some((entry) => entry.kind === 'store')) {
    return { incidents, fresh: freshFingerprints, observed: [...observedFingerprints], recovered, errors, ...(correlations.length > 0 ? { fleetIncidents: correlations } : {}) };
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

  return { incidents, fresh: freshFingerprints, observed: [...observedFingerprints], recovered, errors, ...(correlations.length > 0 ? { fleetIncidents: correlations } : {}) };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
