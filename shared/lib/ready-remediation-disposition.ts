/**
 * The one Ready remediation in-flight/completion disposition (HOK-3322).
 *
 * "Is Ready remediation still in flight?" used to be answered by four private
 * predicates — the monitor's unconditional `status running + launch head ==
 * current head` hold, the ready-watchdog's `agentIdle` override of pane
 * ownership, its conflict-residue resume check, and its pre-launch same-head
 * skip. They disagreed: when a remediation agent re-ran flaky CI green without
 * pushing, then settled idle, the monitor held forever on the same-head rule
 * while the watchdog saw an idle owner. A running Ready result and a matching
 * launch SHA are *facts about a launch*, not liveness.
 *
 * This module decides from those facts plus the HOK-3101 task-progress
 * primitive (the owner's own idle/working record; pane existence is only an
 * exit fact, never progress) and returns one of:
 *
 * | kind         | meaning                                               | consumer action                         |
 * |--------------|-------------------------------------------------------|-----------------------------------------|
 * | `none`       | no remediation launch recorded at a known head, or the Ready result has concluded (not `running`) | stage result is authoritative |
 * | `superseded` | the remediation moved the head (it pushed)            | re-run the controller Ready check       |
 * | `in-flight`  | same head, Ready running, owner live or unknown       | hold — the owner is still working       |
 * | `settled`    | same head, Ready running, owner idle/exited since its launch | re-run the controller Ready check; a red result goes through the existing remediation bounded retry → escalation |
 *
 * `settled` never synthesises success: consumers resume the existing
 * controller-owned Ready check/completion/handoff path, which reads
 * current-head CI and publishes the handoff only on a real pass.
 *
 * Consumers: the monitor (`ready_remediation_disposition` in
 * `shared/lib/ready-remediation-disposition.sh`, via
 * `tools/ready-remediation-disposition.ts` for the owner) and the
 * ready-watchdog (`snapshotReadyTask` → `ReadyTaskSnapshot.remediationDisposition`).
 * Both are pinned against `tests/fixtures/ready-remediation-disposition-cases.json`.
 * `tools/check-ready-disposition.ts` forbids private same-head/launch-head
 * in-flight comparisons outside this module and its shell twin.
 */

import { readOwnershipRows, type SessionOwnershipRow } from './session-ownership.ts';
import type { TaskProgress } from './task-progress.ts';

export type ReadyRemediationDispositionKind = 'none' | 'superseded' | 'in-flight' | 'settled';

/**
 * Who owns the remediation right now, from task-progress evidence:
 * - `live`    — fresh working/attention record, a blocking prompt, live
 *               background work, or a live pane with no idle record;
 * - `idle`    — the agent's own idle/Stop record, written after the launch;
 * - `exited`  — the owner's pane/process is gone (an exit fact, not progress);
 * - `unknown` — no evidence either way (fail-safe: treated as in flight).
 */
export type RemediationOwner = 'live' | 'idle' | 'exited' | 'unknown';

/** The task-progress fields the owner derivation reads (HOK-3101). */
export type RemediationProgress = Partial<Pick<
  TaskProgress,
  'agentIdle' | 'agentState' | 'agentRecord' | 'agentBackgroundLive' | 'blockingPrompt'
>>;

export interface ReadyRemediationFacts {
  /** `.ready-result.json` status (`running`, `completed`, `failed`, …). */
  readyStatus: string | null | undefined;
  /** Head the last remediation (CI or conflict) launched at. */
  launchHead: string | null | undefined;
  /** The task worktree's current HEAD. */
  currentHead: string | null | undefined;
  /** The task-progress snapshot; `null` when the primitive could not run. */
  progress: RemediationProgress | null | undefined;
  /** Pane liveness fact: `false` = owner exited, `true` = pane holds a process, `null` = not probed. */
  ownerPaneLive?: boolean | null;
  /**
   * ISO launch time of the latest remediation session (session-ownership
   * row). An idle record older than this belongs to the previous owner (the
   * review agent, or the prior attempt) and is not this remediation settling.
   */
  launchedAt?: string | null;
}

export interface ReadyRemediationDisposition {
  kind: ReadyRemediationDispositionKind;
  owner: RemediationOwner;
  reason: string;
}

/** Fresh agent states that mean the owner is still at work or awaiting a human. */
const LIVE_AGENT_STATES: ReadonlySet<string> = new Set([
  'working',
  'waiting',
  'approval-needed',
  'blocked',
  'policy-denied',
]);

/** Session-ownership kinds whose sessions are Ready remediation owners. */
const REMEDIATION_OWNERSHIP_KINDS: ReadonlySet<string> = new Set(['ready-remediation', 'conflict-resolution']);

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Hook timestamps are epoch seconds; tolerate a millisecond writer. */
function hookTimestampMs(timestamp: unknown): number | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

/**
 * Did the agent's idle record land after the remediation launched? Without a
 * recorded launch the idle fact stands on its own; with one, the record must
 * carry a timestamp at or after the launch second.
 */
function idleSinceLaunch(progress: RemediationProgress, launchedAt: string | null | undefined): boolean {
  const launchMs = launchedAt ? Date.parse(launchedAt) : Number.NaN;
  if (!Number.isFinite(launchMs)) return true;
  const record = progress.agentRecord;
  if (!record || record.state !== 'idle') return false;
  const idleMs = hookTimestampMs(record.timestamp);
  return idleMs !== null && idleMs >= Math.floor(launchMs / 1000) * 1000;
}

/** Derive the remediation owner from task-progress evidence. */
export function deriveRemediationOwner(
  progress: RemediationProgress | null | undefined,
  options: { ownerPaneLive?: boolean | null; launchedAt?: string | null } = {},
): RemediationOwner {
  if (options.ownerPaneLive === false) return 'exited';
  if (progress) {
    if (progress.blockingPrompt) return 'live';
    if (progress.agentBackgroundLive === true) return 'live';
    if (progress.agentState && LIVE_AGENT_STATES.has(progress.agentState)) return 'live';
    if (progress.agentIdle === true && idleSinceLaunch(progress, options.launchedAt)) return 'idle';
  }
  if (options.ownerPaneLive === true) return 'live';
  return 'unknown';
}

/** The one Ready remediation disposition. Pure; see the module header. */
export function decideReadyRemediationDisposition(facts: ReadyRemediationFacts): ReadyRemediationDisposition {
  const owner = deriveRemediationOwner(facts.progress, {
    ownerPaneLive: facts.ownerPaneLive,
    launchedAt: facts.launchedAt,
  });
  const launchHead = nonEmpty(facts.launchHead);
  const currentHead = nonEmpty(facts.currentHead);

  if (!launchHead || !currentHead) {
    return { kind: 'none', owner, reason: 'no remediation launch recorded at a known head' };
  }
  if (launchHead !== currentHead) {
    return {
      kind: 'superseded',
      owner,
      reason: `remediation moved the head (${launchHead.slice(0, 7)} → ${currentHead.slice(0, 7)})`,
    };
  }
  if (facts.readyStatus !== 'running') {
    return {
      kind: 'none',
      owner,
      reason: `Ready result is ${facts.readyStatus ?? 'missing'}; the stage result is authoritative`,
    };
  }
  if (owner === 'idle' || owner === 'exited') {
    return {
      kind: 'settled',
      owner,
      reason: `remediation owner ${owner} at launch head ${currentHead.slice(0, 7)}; controller re-checks Ready`,
    };
  }
  return {
    kind: 'in-flight',
    owner,
    reason: `remediation owner ${owner} at launch head ${currentHead.slice(0, 7)}`,
  };
}

/** Whether the disposition hands control back to the controller Ready check. */
export function readyRemediationNeedsRecheck(disposition: Pick<ReadyRemediationDisposition, 'kind'>): boolean {
  return disposition.kind === 'superseded' || disposition.kind === 'settled';
}

/**
 * Launch time of the latest remediation session recorded in `stateDir`'s
 * session-ownership file (HOK-3328 rows are written before the child starts),
 * or `null` when none is recorded or the file is unreadable.
 */
export function readLatestRemediationLaunchAt(
  stateDir: string,
  readRows: (dir: string) => readonly SessionOwnershipRow[] = readOwnershipRows,
): string | null {
  let rows: readonly SessionOwnershipRow[];
  try {
    rows = readRows(stateDir);
  } catch {
    return null;
  }
  let latest: { at: string; ms: number } | null = null;
  for (const row of rows) {
    if (!REMEDIATION_OWNERSHIP_KINDS.has(row.kind)) continue;
    const ms = Date.parse(row.launchedAt);
    if (Number.isFinite(ms) && (!latest || ms > latest.ms)) latest = { at: row.launchedAt, ms };
  }
  return latest?.at ?? null;
}
