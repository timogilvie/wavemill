/**
 * Live workflow-state invariant checker (HOK-3229).
 *
 * One detection-only pass over live workflow state that fires an urgent
 * finding when the mill is in a shape that should be impossible. Runs as a
 * tracked async job each monitor tick (HOK-3206 pattern) so the hot path is
 * never blocked. Consumes the canonical primitives
 * (`task-progress.ts`, `deriveMergeLabel()`, `validateTaskRecord()`,
 * `enumerateRetrySentinels()`, `enumerateConditionSidecars()`) and never
 * re-derives their decisions.
 *
 * Invariants (acceptance from HOK-3229):
 *  - I1  non-terminal task is making progress or has a waiting-on reason
 *  - I2  slot accounting matches live non-stub rows; no orphan stubs
 *  - I3  wm:ready/wm:blocked label equals deriveMergeLabel for ≥ 2 ticks
 *  - I4  Ready-pass PR without wm:ready and no merge activity for X minutes
 *        (replay case for HOK-3212)
 *  - I5  No condition marker outlives its condition
 *  - I6  Every tasks[id] validates against the A1 schema
 *  - I7  Every .retry-*-exhausted sentinel has its condition companion
 *  - ledger-* side-effect ledger disagreements (routed through from CLI)
 *
 * The library is pure. All IO (progress CLI, filesystem reads, PR cache)
 * happens in the CLI wrapper (`tools/state-invariants.ts`); callers pass
 * the gathered inputs to `evaluateInvariants(...)`.
 *
 * @module state-invariants
 */

import type { TaskProgress } from './task-progress.ts';
import type { CachedPullRequest } from './session-gh-cache.ts';
import type { WorkflowState, TaskRecord } from './workflow-state.ts';
import {
  deriveMergeLabel,
  type MergeLabelTaskView,
  type MergeLabelLiveState,
} from './merge-labels.ts';
import {
  validateTaskRecord,
  validateWorkflowState,
  workflowTaskEntries,
} from './workflow-state.ts';
import { getBlastRadius } from './blast-radius.ts';
import { TEND_BLOCKED_LANE_FRESH_MS } from './wavemill-incident-tend-candidates.ts';

// ── Public types ─────────────────────────────────────────────────────────────

export type InvariantId =
  | 'I1-progress'
  | 'I2-slots'
  | 'I3-label-mismatch'
  | 'I4-ready-stuck'
  | 'I5-stale-marker'
  | 'I6-schema'
  | 'I7-missing-condition-companion'
  | 'I8-bake-gate-stall'
  | `ledger-${string}`;

export interface InvariantViolation {
  invariantId: InvariantId;
  taskId?: string;
  prNumber?: number;
  severity: 'urgent';
  detectedAt: string;
  evidence: Record<string, unknown>;
  /** Stable per-condition dedup key. */
  signature: string;
}

export interface InvariantConfig {
  /** Minutes a Ready-pass PR can idle without wm:ready before I4 fires. */
  readyStuckMinutes: number;
  /** Ticks a label mismatch must persist before I3 fires. */
  labelMismatchGraceTicks: number;
  /** Ticks a stale condition marker must persist before I5 fires. */
  markerGraceTicks: number;
  /**
   * HOK-3238 post-promotion bake gate. Minutes after a `high`-blast-radius
   * commit lands on `main` during which the gate watches throughput. `0`
   * disables the gate.
   */
  bakeWindowMinutes: number;
  /**
   * HOK-3238 post-promotion bake gate. Minutes `tendHeartbeat.laneCondition
   * === 'idle-blocked-stall'` must have persisted (relative to the bake
   * commit) before I8 fires.
   */
  tendIdleStallMinutes: number;
}

export const DEFAULT_INVARIANT_CONFIG: InvariantConfig = {
  readyStuckMinutes: 15,
  labelMismatchGraceTicks: 2,
  markerGraceTicks: 2,
  bakeWindowMinutes: 120,
  tendIdleStallMinutes: 30,
};

/** Minimum shape consumed from the retry-sentinel enumerator. */
export interface RetrySentinelInfo {
  taskId: string;
  bucket: string;
  exhaustedPath: string;
  exhaustedExists: boolean;
  conditionPath: string;
  conditionExists: boolean;
}

/** Minimum shape consumed from the condition-sidecar enumerator. */
export interface ConditionSidecarInfo {
  taskId: string;
  path: string;
  /** Parsed JSON contents of the sidecar (null when unreadable). */
  raw: Record<string, unknown> | null;
  /** `expiresOn` triggers; empty when the sidecar is malformed or legacy. */
  expiresOn: string[];
  /** Head sha recorded in the condition block, if any. */
  recordedHead?: string;
  /** PR head oid recorded under `.observed.prHeadRefOid`, if any. */
  recordedPrHeadOid?: string;
  /** Deadline (`recheckAfter`) ISO, if any. */
  recordedDeadline?: string;
  /** Operator event seq recorded, if any. */
  recordedOperatorEventSeq?: number;
}

/** Observed world against which I5 evaluates each sidecar. */
export interface StateInspection {
  /** Current worktree HEAD per task id. */
  worktreeHeadsByTaskId: Map<string, string>;
  /** Operator event seq per task id (highest consumed/produced). */
  operatorEventSeqByTaskId: Map<string, number>;
  /** Live PR head oid per PR number. */
  prHeadByNumber: Map<number, string>;
  /** PR number per task id (built from workflow state .tasks[id].pr). */
  prNumberByTaskId: Map<string, number>;
  /** Current time (ms). */
  nowMs: number;
}

/** Serializable per-tick cache persisted across invariant-job invocations. */
export interface StateInvariantsCache {
  schemaVersion: 1;
  lastTickAt?: string;
  pr: Record<
    string,
    {
      lastHeadSha?: string;
      /** Count of consecutive ticks the label mismatch has been seen. */
      labelMismatchStreak: number;
      /** wm:ready / wm:blocked / none label seen last tick (HOK-3316). */
      lastLabel?: 'wm:ready' | 'wm:blocked' | null;
      /**
       * Ticks at this head whose label changed while it disagreed with
       * deriveMergeLabel (HOK-3316): a label that flips back and forth never
       * builds a consecutive streak, so it is counted separately.
       */
      labelFlipsAgainstDerived?: number;
    }
  >;
  marker: Record<
    string,
    {
      /** Count of consecutive ticks the marker's condition has been stale. */
      staleStreak: number;
    }
  >;
  signatures: Record<
    string,
    { firstSeenAt: string; lastSeenAt: string; timesSeen: number }
  >;
}

export function createEmptyCache(): StateInvariantsCache {
  return { schemaVersion: 1, pr: {}, marker: {}, signatures: {} };
}

export interface EvaluateInvariantsInputs {
  state: WorkflowState;
  taskProgress: Map<string, TaskProgress>;
  prs: CachedPullRequest[];
  taskViews: Map<number, MergeLabelTaskView | null>;
  liveStates: Map<number, MergeLabelLiveState | null>;
  conditionSidecars: ConditionSidecarInfo[];
  retrySentinels: RetrySentinelInfo[];
  waitingOnByTaskId: Map<string, WaitingOnEvidence>;
  cache: StateInvariantsCache;
  stateInspection: StateInspection;
  config?: Partial<InvariantConfig>;
  /**
   * HOK-3238 bake-gate inputs. Each entry is a commit on `main` within the
   * bake window with its changed files; the checker filters to those still
   * within `bakeWindowMinutes` of `nowMs`. Default `[]` disables I8.
   */
  recentMainCommits?: ReadonlyArray<{ sha: string; committedAtMs: number; files: string[] }>;
  /**
   * HOK-3238 bake-gate input. The current tend heartbeat read from
   * `.wavemill/backstage-health.json` (`services.tend.{laneCondition,
   * heartbeatAt}`). `null` means the file is missing/malformed, which the
   * checker treats as "tend is not reporting a stall" → no violation.
   */
  tendHeartbeat?: TendHeartbeat | null;
}

/** Current tend heartbeat read for the bake gate (HOK-3238). */
export interface TendHeartbeat {
  laneCondition: string;
  heartbeatAtMs: number | null;
  blockedStreakMs?: number;
}

export interface WaitingOnEvidence {
  /** True iff any of `.needs-attention`, `.needs-attention-transient`, `.ready-waiting-on.json` exists. */
  hasWaitingOnMarker: boolean;
  /** Human-readable detail for evidence (which marker was found). */
  detail?: string;
}

export interface EvaluateInvariantsResult {
  violations: InvariantViolation[];
  nextCache: StateInvariantsCache;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set([
  'aborted',
  'merged',
  'closed',
  'superseded',
  'done',
  'complete',
  'completed',
  'completed-external',
  'error',
]);

function isTerminalTask(task: TaskRecord, progress: TaskProgress | undefined): boolean {
  if (progress?.terminal) return true;
  if (typeof task.phase === 'string' && TERMINAL_PHASES.has(task.phase)) return true;
  if (typeof task.status === 'string' && TERMINAL_PHASES.has(task.status)) return true;
  const outcome = task.lifecycle?.workflowOutcome;
  if (typeof outcome === 'string' && outcome !== 'active') return true;
  return false;
}

/**
 * Classify a task row as a slot-consuming "live non-stub" row versus an
 * "orphan stub" (missing all four of phase/status/slug/lifecycle). Mirrors
 * `wm_orphan_stub` from `shared/lib/wavemill-common.sh`.
 */
export function isOrphanStub(task: TaskRecord): boolean {
  const phase = typeof task.phase === 'string' ? task.phase : '';
  const status = typeof task.status === 'string' ? task.status : '';
  const slug = typeof task.slug === 'string' ? task.slug : '';
  const lifecycle = task.lifecycle;
  return phase === '' && status === '' && slug === '' && (lifecycle === undefined || lifecycle === null);
}

export function evaluateInvariants(inputs: EvaluateInvariantsInputs): EvaluateInvariantsResult {
  const violations: InvariantViolation[] = [];
  const nextCache: StateInvariantsCache = {
    schemaVersion: 1,
    lastTickAt: new Date(inputs.stateInspection.nowMs).toISOString(),
    pr: {},
    marker: {},
    signatures: { ...inputs.cache.signatures },
  };
  const config: InvariantConfig = { ...DEFAULT_INVARIANT_CONFIG, ...(inputs.config ?? {}) };

  checkInvariant1Progress(inputs, violations);
  checkInvariant2Slots(inputs, violations);
  checkInvariant3LabelMismatch(inputs, violations, nextCache, config);
  checkInvariant4ReadyStuck(inputs, violations, config);
  checkInvariant5StaleMarker(inputs, violations, nextCache, config);
  checkInvariant6Schema(inputs, violations);
  checkInvariant7MissingConditionCompanion(inputs, violations);
  checkInvariant8BakeGate(inputs, violations, config);

  // Update signatures journal: first-seen (new) and last-seen (repeat).
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  const activeSignatures = new Set<string>();
  for (const v of violations) {
    activeSignatures.add(v.signature);
    const prev = nextCache.signatures[v.signature];
    if (prev) {
      nextCache.signatures[v.signature] = {
        firstSeenAt: prev.firstSeenAt,
        lastSeenAt: nowIso,
        timesSeen: prev.timesSeen + 1,
      };
    } else {
      nextCache.signatures[v.signature] = {
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        timesSeen: 1,
      };
    }
  }
  // Garbage-collect signatures whose underlying violation no longer fires.
  for (const sig of Object.keys(nextCache.signatures)) {
    if (!activeSignatures.has(sig)) delete nextCache.signatures[sig];
  }

  return { violations, nextCache };
}

/** True iff `signature` is NEW this tick (not already in `cache.signatures`). */
export function isNewSignature(signature: string, previousCache: StateInvariantsCache): boolean {
  return !(signature in previousCache.signatures);
}

// ── I1: progress ─────────────────────────────────────────────────────────────

export function checkInvariant1Progress(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  for (const [taskId, task] of workflowTaskEntries(inputs.state)) {
    const progress = inputs.taskProgress.get(taskId);
    if (!progress) continue;
    if (isTerminalTask(task, progress)) continue;
    if (!progress.stalled) continue;
    // Agent self-declared waiting (approval-needed, blocked, policy-denied,
    // waiting) is already suppressed inside `deriveTaskProgress`; a stalled
    // task that nonetheless has an on-disk waiting-on marker is also not a
    // violation (the operator has evidence).
    const waiting = inputs.waitingOnByTaskId.get(taskId);
    if (waiting?.hasWaitingOnMarker) continue;
    // Keyed on lastProgressAt so the signature stays stable while the stall
    // persists (each tick's rising stallMinutes would otherwise mint a fresh
    // signature and trigger an OS notification every tick — HOK-3229 §F9).
    const sig = `I1-progress:task=${taskId}:lastProgressAt=${progress.lastProgressAt ?? 'unknown'}`;
    out.push({
      invariantId: 'I1-progress',
      taskId,
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        taskId,
        phase: task.phase ?? null,
        status: task.status ?? null,
        lastProgressAt: progress.lastProgressAt,
        progressAgeMinutes: progress.progressAgeMinutes,
        stallMinutes: progress.stallMinutes,
        agentState: progress.agentState,
      },
      signature: sig,
    });
  }
}

// ── I2: slot accounting / orphan stubs ───────────────────────────────────────

export function checkInvariant2Slots(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  for (const [taskId, task] of workflowTaskEntries(inputs.state)) {
    if (!isOrphanStub(task)) continue;
    out.push({
      invariantId: 'I2-slots',
      taskId,
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        taskId,
        missingFields: ['phase', 'status', 'slug', 'lifecycle'],
        consumesSlot: true,
      },
      signature: `I2-slots:task=${taskId}`,
    });
  }
}

// ── I3: label mismatch (with streak) ─────────────────────────────────────────

export function checkInvariant3LabelMismatch(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
  nextCache: StateInvariantsCache,
  config: InvariantConfig,
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  // I3 fires at `streak >= graceTicks + 1` so default 2 → fires on tick 3
  // (matches task-packet §6 REQ-F3: "persists for at most 2 ticks"). I5 fires
  // at `streak >= graceTicks` (tick 2); the asymmetry is intentional.
  const graceTicks = Math.max(1, config.labelMismatchGraceTicks);

  for (const pr of inputs.prs) {
    if (pr.state && pr.state.toUpperCase() !== 'OPEN') continue;
    const prKey = String(pr.number);
    const prevEntry = inputs.cache.pr?.[prKey];
    const task = inputs.taskViews.get(pr.number);
    const liveState = inputs.liveStates.get(pr.number);
    if (!task || !liveState) {
      // Not a wavemill PR (no task view) or live state unavailable; skip.
      continue;
    }

    const labels = (pr.labels ?? [])
      .map((l) => (typeof l?.name === 'string' ? l.name : ''))
      .filter(Boolean);
    const hasReady = labels.includes('wm:ready');
    const hasBlocked = labels.includes('wm:blocked');
    const currentLabel: 'wm:ready' | 'wm:blocked' | null = hasReady
      ? 'wm:ready'
      : hasBlocked
        ? 'wm:blocked'
        : null;

    const decision = deriveMergeLabel(
      task,
      { number: pr.number, labels, headSha: pr.headRefOid ?? '' },
      liveState,
    );
    const derivedLabel = decision.label;
    const matches = derivedLabel === currentLabel;

    const prevHead = prevEntry?.lastHeadSha;
    const curHead = pr.headRefOid ?? '';
    const headChanged = prevHead && prevHead !== curHead;

    let streak = matches ? 0 : (prevEntry?.labelMismatchStreak ?? 0) + 1;
    if (headChanged) streak = matches ? 0 : 1;

    // HOK-3316: a writer outside deriveMergeLabel fighting the reconciler
    // flips the label every poll (PR #1697: wm:blocked ↔ wm:ready ~90s), so
    // the consecutive streak keeps resetting. Count flips at this head where
    // either side of the flip disagreed with the derived label.
    const labelChanged = prevEntry !== undefined && !headChanged && prevEntry.lastLabel !== undefined
      && prevEntry.lastLabel !== currentLabel;
    const flippedAgainstDerived = labelChanged && (!matches || prevEntry?.lastLabel !== derivedLabel);
    const flips = headChanged ? 0 : (prevEntry?.labelFlipsAgainstDerived ?? 0) + (flippedAgainstDerived ? 1 : 0);
    const flapping = flips >= graceTicks + 1;

    nextCache.pr[prKey] = {
      lastHeadSha: curHead,
      labelMismatchStreak: streak,
      lastLabel: currentLabel,
      labelFlipsAgainstDerived: flips,
    };

    if (!matches && (streak >= graceTicks + 1 || flapping)) {
      out.push({
        invariantId: 'I3-label-mismatch',
        prNumber: pr.number,
        severity: 'urgent',
        detectedAt: nowIso,
        evidence: {
          prNumber: pr.number,
          currentLabel,
          derivedLabel,
          reason: decision.label === 'wm:ready' ? undefined : decision.reason,
          streak,
          labelFlips: flips,
          headSha: curHead,
          taskId: task.linearIssueId,
        },
        signature: `I3-label-mismatch:pr=${pr.number}:head=${curHead}`,
      });
    }
  }
}

// ── I4: Ready-pass PR stuck without wm:ready (HOK-3212 replay) ───────────────

const LANE_LABELS = new Set(['wm:ready', 'wm:merging', 'wm:merged', 'wm:superseded']);

function isAllGreen(pr: CachedPullRequest): boolean {
  const rollup = (pr.statusCheckRollup ?? []) as Array<{
    name?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }>;
  if (!Array.isArray(rollup) || rollup.length === 0) return false;
  for (const check of rollup) {
    const status = (check.status ?? '').toUpperCase();
    const conclusion = (check.conclusion ?? '').toUpperCase();
    // Treat empty status/conclusion as pending.
    if (status && status !== 'COMPLETED') return false;
    if (conclusion && conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL' && conclusion !== 'SKIPPED') {
      return false;
    }
    if (!conclusion) return false;
  }
  return true;
}

export function checkInvariant4ReadyStuck(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
  config: InvariantConfig,
): void {
  const nowMs = inputs.stateInspection.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  const thresholdMs = config.readyStuckMinutes * 60_000;

  for (const pr of inputs.prs) {
    if (pr.state && pr.state.toUpperCase() !== 'OPEN') continue;
    const task = inputs.taskViews.get(pr.number);
    if (!task) continue; // Not a wavemill PR.
    const labels = (pr.labels ?? [])
      .map((l) => (typeof l?.name === 'string' ? l.name : ''))
      .filter(Boolean);
    // Any lane label present means tend is driving it; not stuck.
    if (labels.some((l) => LANE_LABELS.has(l))) continue;
    if (!isAllGreen(pr)) continue;

    const updatedAt = pr.updatedAt ? Date.parse(pr.updatedAt) : NaN;
    if (!Number.isFinite(updatedAt)) continue;
    const ageMs = nowMs - updatedAt;
    if (ageMs < thresholdMs) continue;

    const liveState = inputs.liveStates.get(pr.number);
    const derived = liveState
      ? deriveMergeLabel(
          task,
          { number: pr.number, labels, headSha: pr.headRefOid ?? '' },
          liveState,
        )
      : null;

    out.push({
      invariantId: 'I4-ready-stuck',
      prNumber: pr.number,
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        prNumber: pr.number,
        headSha: pr.headRefOid ?? '',
        labels,
        statusCheckRollup: pr.statusCheckRollup ?? [],
        updatedAt: pr.updatedAt ?? null,
        ageMinutes: Math.floor(ageMs / 60_000),
        thresholdMinutes: config.readyStuckMinutes,
        derivedLabel: derived?.label ?? null,
        taskId: task.linearIssueId,
      },
      signature: `I4-ready-stuck:pr=${pr.number}:head=${pr.headRefOid ?? ''}`,
    });
  }
}

// ── I5: stale condition markers ─────────────────────────────────────────────

/**
 * Return the first expiry trigger that fires for the given sidecar against the
 * current state inspection, or `null` when none fires.
 *
 * Mirrors the predicates from `shared/lib/condition-reconciler.sh` (`head`,
 * `remote`, `deadline`, `operator-event`). The reconciler also handles
 * `review-artifact`, `review-artifact-substantive`, `ready-artifact`,
 * `waiting-on`: for I5 we only fire on the subset the detector can observe
 * cheaply (the reconciler-race safety grace handles the rest).
 */
export function expiredTriggerForSidecar(
  sidecar: ConditionSidecarInfo,
  inspection: StateInspection,
): string | null {
  for (const trigger of sidecar.expiresOn) {
    switch (trigger) {
      case 'head': {
        const current = inspection.worktreeHeadsByTaskId.get(sidecar.taskId);
        const recorded = sidecar.recordedHead;
        if (recorded && current && recorded !== current) {
          return `head:${recorded.slice(0, 7)}→${current.slice(0, 7)}`;
        }
        break;
      }
      case 'operator-event': {
        const seqNow = inspection.operatorEventSeqByTaskId.get(sidecar.taskId) ?? 0;
        const recorded = sidecar.recordedOperatorEventSeq ?? 0;
        if (seqNow > recorded) return `operator-event:${recorded}→${seqNow}`;
        break;
      }
      case 'deadline': {
        const recorded = sidecar.recordedDeadline;
        if (recorded) {
          const ms = Date.parse(recorded);
          if (Number.isFinite(ms) && inspection.nowMs >= ms) {
            return `deadline:${recorded}`;
          }
        }
        break;
      }
      case 'remote': {
        const recorded = sidecar.recordedPrHeadOid;
        if (!recorded) break;
        // Scope the comparison to the sidecar's own PR to avoid firing on
        // other active PRs whose heads naturally differ in a multi-PR mill.
        const ownPr = inspection.prNumberByTaskId.get(sidecar.taskId);
        if (ownPr === undefined) break;
        const headOid = inspection.prHeadByNumber.get(ownPr);
        if (headOid && headOid !== recorded) {
          return `remote:${recorded.slice(0, 7)}→${headOid.slice(0, 7)}`;
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

export function checkInvariant5StaleMarker(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
  nextCache: StateInvariantsCache,
  config: InvariantConfig,
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  const graceTicks = Math.max(1, config.markerGraceTicks);

  for (const sidecar of inputs.conditionSidecars) {
    const cacheKey = sidecar.path;
    const prev = inputs.cache.marker?.[cacheKey]?.staleStreak ?? 0;
    const trigger = expiredTriggerForSidecar(sidecar, inputs.stateInspection);
    const streak = trigger ? prev + 1 : 0;
    nextCache.marker[cacheKey] = { staleStreak: streak };

    if (trigger && streak >= graceTicks) {
      out.push({
        invariantId: 'I5-stale-marker',
        taskId: sidecar.taskId,
        severity: 'urgent',
        detectedAt: nowIso,
        evidence: {
          taskId: sidecar.taskId,
          markerPath: sidecar.path,
          expiredTrigger: trigger,
          streak,
        },
        signature: `I5-stale-marker:marker=${sidecar.path}:${trigger}`,
      });
    }
  }
}

// ── I6: schema ───────────────────────────────────────────────────────────────

export function checkInvariant6Schema(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  // Whole-state check first.
  const whole = validateWorkflowState(inputs.state);
  if (!whole.valid) {
    out.push({
      invariantId: 'I6-schema',
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        scope: 'workflow-state',
        issues: whole.issues.slice(0, 5),
      },
      signature: `I6-schema:scope=workflow-state`,
    });
  }
  // Per-task check so an operator sees exactly which row is bad.
  for (const [taskId, task] of workflowTaskEntries(inputs.state)) {
    const res = validateTaskRecord(taskId, task);
    if (res.valid) continue;
    out.push({
      invariantId: 'I6-schema',
      taskId,
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        scope: 'task',
        taskId,
        issues: res.issues.slice(0, 5),
      },
      signature: `I6-schema:task=${taskId}`,
    });
  }
}

// ── I7: retry sentinel missing its condition companion ──────────────────────

export function checkInvariant7MissingConditionCompanion(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
): void {
  const nowIso = new Date(inputs.stateInspection.nowMs).toISOString();
  for (const sentinel of inputs.retrySentinels) {
    if (!sentinel.exhaustedExists) continue;
    if (sentinel.conditionExists) continue;
    out.push({
      invariantId: 'I7-missing-condition-companion',
      taskId: sentinel.taskId,
      severity: 'urgent',
      detectedAt: nowIso,
      evidence: {
        taskId: sentinel.taskId,
        bucket: sentinel.bucket,
        exhaustedPath: sentinel.exhaustedPath,
        conditionPath: sentinel.conditionPath,
      },
      signature: `I7-missing-condition-companion:task=${sentinel.taskId}:bucket=${sentinel.bucket}`,
    });
  }
}

// ── I8: post-promotion bake gate (HOK-3238) ─────────────────────────────────

/**
 * Post-promotion bake gate.
 *
 * After a `high`-blast-radius commit lands on `main`, watch throughput for
 * `bakeWindowMinutes` (default 120 min). Fire an urgent `I8-bake-gate-stall`
 * finding when tend is in an `idle-blocked-stall` for more than
 * `tendIdleStallMinutes` (default 30 min) after the promotion — which encodes
 * "nothing is moving" without a separate merge-rate meter. The signature is
 * stable per promotion so repeat ticks never spam past the first notification.
 *
 * `bakeWindowMinutes === 0` disables the gate (`WAVEMILL_BAKE_GATE_MINUTES=0`).
 */
export function checkInvariant8BakeGate(
  inputs: EvaluateInvariantsInputs,
  out: InvariantViolation[],
  config: InvariantConfig,
): void {
  if (!config.bakeWindowMinutes || config.bakeWindowMinutes <= 0) return;
  const commits = inputs.recentMainCommits ?? [];
  if (commits.length === 0) return;
  const nowMs = inputs.stateInspection.nowMs;
  const nowIso = new Date(nowMs).toISOString();
  const windowMs = config.bakeWindowMinutes * 60_000;
  const stallThresholdMs = config.tendIdleStallMinutes * 60_000;

  // The commit closest to `now` wins the signature — deterministic even when
  // two mill-core commits land within the window. All reports share one
  // signature so the OS notification fires once per promotion.
  let bakeCommit: { sha: string; committedAtMs: number; files: string[] } | null = null;
  for (const commit of commits) {
    if (commit.committedAtMs > nowMs) continue; // Future-dated — ignore.
    if (nowMs - commit.committedAtMs > windowMs) continue;
    if (getBlastRadius(commit.files) !== 'high') continue;
    if (!bakeCommit || commit.committedAtMs > bakeCommit.committedAtMs) {
      bakeCommit = commit;
    }
  }
  if (!bakeCommit) return;

  const tend = inputs.tendHeartbeat ?? null;
  if (!tend || tend.laneCondition !== 'idle-blocked-stall') return;
  const heartbeatMs = tend.heartbeatAtMs;
  if (heartbeatMs === null || !Number.isFinite(heartbeatMs)) return;
  // Heartbeat must be fresh — a stale heartbeat means tend is not reporting
  // the lane right now, so we cannot claim an ongoing stall (HOK-2595).
  if (nowMs - heartbeatMs > TEND_BLOCKED_LANE_FRESH_MS) return;
  // The stall must be *after* the promotion, by at least the configured
  // tendIdleStallMinutes margin.
  const stallDeltaMs = heartbeatMs - bakeCommit.committedAtMs;
  if (stallDeltaMs <= stallThresholdMs) return;

  const readyPrNumbers: number[] = [];
  for (const pr of inputs.prs) {
    const labels = (pr.labels ?? [])
      .map((l) => (typeof l?.name === 'string' ? l.name : ''))
      .filter(Boolean);
    if (labels.includes('wm:ready')) readyPrNumbers.push(pr.number);
  }

  out.push({
    invariantId: 'I8-bake-gate-stall',
    severity: 'urgent',
    detectedAt: nowIso,
    evidence: {
      commitSha: bakeCommit.sha,
      committedAt: new Date(bakeCommit.committedAtMs).toISOString(),
      bakeWindowMinutes: config.bakeWindowMinutes,
      tendLaneCondition: tend.laneCondition,
      tendHeartbeatAt: new Date(heartbeatMs).toISOString(),
      tendStallMinutes: Math.floor(stallDeltaMs / 60_000),
      tendStallThresholdMinutes: config.tendIdleStallMinutes,
      readyPrNumbers,
      filesChanged: bakeCommit.files.slice(0, 10),
      revertCommand: `git revert ${bakeCommit.sha}`,
    },
    signature: `I8:${bakeCommit.sha}`,
  });
}

// ── Helpers for CLI (sidecar parser, waiting-on evidence) ────────────────────

/**
 * Parse a raw condition-sidecar JSON payload into the structured info the
 * invariant checker needs. Fail-safe: a malformed sidecar yields an entry
 * with empty `expiresOn`, which never fires.
 */
export function parseConditionSidecar(
  taskId: string,
  path: string,
  raw: string | null,
): ConditionSidecarInfo {
  if (raw === null) {
    return { taskId, path, raw: null, expiresOn: [] };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    return { taskId, path, raw: null, expiresOn: [] };
  }
  if (!parsed) return { taskId, path, raw: null, expiresOn: [] };
  const condition = parsed.condition && typeof parsed.condition === 'object' && !Array.isArray(parsed.condition)
    ? (parsed.condition as Record<string, unknown>)
    : parsed;
  const expiresOnRaw = Array.isArray(condition.expiresOn) ? (condition.expiresOn as unknown[]) : [];
  const expiresOn = expiresOnRaw
    .filter((v): v is string => typeof v === 'string');
  const headRaw = typeof condition.head === 'string' ? condition.head : undefined;
  const recordedHead = headRaw ? headRaw.split(':')[0] : undefined;
  const observed = condition.observed && typeof condition.observed === 'object' && !Array.isArray(condition.observed)
    ? (condition.observed as Record<string, unknown>)
    : undefined;
  const recordedPrHeadOid = typeof observed?.prHeadRefOid === 'string' ? (observed.prHeadRefOid as string) : undefined;
  const recordedDeadline = typeof condition.recheckAfter === 'string' ? (condition.recheckAfter as string) : undefined;
  const seq = typeof condition.operatorEventSeq === 'number' ? (condition.operatorEventSeq as number) : undefined;
  return {
    taskId,
    path,
    raw: parsed,
    expiresOn,
    recordedHead,
    recordedPrHeadOid,
    recordedDeadline,
    recordedOperatorEventSeq: seq,
  };
}
