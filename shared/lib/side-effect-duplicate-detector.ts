/**
 * Side-effect duplicate detector (HOK-3183 — Ledger D Phase 1).
 *
 * Runs from the monitor tick (`monitor_side_effect_detector_tick`) and reports
 * the two signals the Ledger D Gate is measured on:
 *
 * - `duplicate`: a side-effect key requested more than once — read from the
 *   `side-effect-duplicate-attempt` evidence rows `shadowRecordSideEffect`
 *   writes, so a duplicate is reported once, inside the window it happened in.
 * - `missing-row`: an effect observed externally with no ledger row. Phase 1
 *   covers PR labels only, cross-checked against the HOK-3182 mill
 *   label-write audit log (`.wavemill/label-writes.jsonl`). Pushes, merges
 *   and Linear transitions have no external audit log yet; Phase 2 adds one
 *   before the detector can report missing rows for them.
 *
 * Shell-side `git push --delete` and archive-ref pushes are out of Phase 1
 * scope: none of the class-S incidents the Gate measures involve them.
 *
 * @module side-effect-duplicate-detector
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Ledger, SideEffectKind } from './ledger.ts';
import { LABEL_WRITE_MATCH_WINDOW_MS, readMillLabelWrites, type LabelWriteEntry } from './label-write-ledger.ts';
import { DUPLICATE_ATTEMPT_EVENT, prLabelKeyPrefix } from './side-effect-ledger.ts';

export const SIDE_EFFECT_DUPLICATE_LOG_FILENAME = 'side-effect-duplicates.jsonl';
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const SIDE_EFFECT_KINDS: SideEffectKind[] = ['git-push', 'pr-label', 'pr-merge', 'linear-transition', 'pr-comment'];

export interface DuplicateFinding {
  category: 'duplicate';
  kind: SideEffectKind;
  idempotencyKey: string;
  applied: boolean;
  attempt: number;
  stepId: string;
  firstRequestedAt: string;
  observedAt: string;
}

export interface MissingRowFinding {
  category: 'missing-row';
  kind: SideEffectKind;
  prNumber: number;
  label: string;
  action: LabelWriteEntry['action'];
  observedAt: string;
}

export type SideEffectFinding = DuplicateFinding | MissingRowFinding;

export interface DetectDuplicatesOptions {
  /** Scan window; findings older than `now - sinceMs` are not reported. Default 30 min. */
  sinceMs?: number;
  /** Repo whose label-write audit log is cross-checked. Omit to skip the missing-row check. */
  repoDir?: string;
  /** Pre-read label writes (tests). */
  labelWrites?: LabelWriteEntry[];
  now?: Date;
}

export interface DetectDuplicatesResult {
  findings: SideEffectFinding[];
  duplicates: number;
  missingRows: number;
  /** Keys whose `attempt` is above zero, all time — the cumulative Gate counter. */
  duplicateKeysAllTime: number;
  scanned: { duplicateEvents: number; labelWrites: number };
  windowStart: string;
  tookMs: number;
}

export const DEFAULT_DETECTOR_WINDOW_MS = 30 * 60 * 1000;

function splitEvidenceDetail(detail: string | null): { kind: SideEffectKind; key: string } | null {
  if (!detail) return null;
  const separator = detail.indexOf('|');
  if (separator <= 0) return null;
  const kind = detail.slice(0, separator) as SideEffectKind;
  if (!SIDE_EFFECT_KINDS.includes(kind)) return null;
  return { kind, key: detail.slice(separator + 1) };
}

function findDuplicates(ledger: Ledger, windowStart: string): { findings: DuplicateFinding[]; scanned: number } {
  const events = ledger.listEvidenceByEvent(DUPLICATE_ATTEMPT_EVENT, windowStart);
  const latestByKey = new Map<string, DuplicateFinding>();
  for (const event of events) {
    const parsed = splitEvidenceDetail(event.detail);
    if (!parsed) continue;
    const row = ledger.findSideEffect(parsed.kind, parsed.key);
    if (!row) continue;
    latestByKey.set(`${parsed.kind}|${parsed.key}`, {
      category: 'duplicate',
      kind: parsed.kind,
      idempotencyKey: parsed.key,
      applied: row.applied_at !== null,
      attempt: row.attempt,
      stepId: row.step_id,
      firstRequestedAt: row.requested_at,
      observedAt: event.recorded_at,
    });
  }
  return { findings: [...latestByKey.values()], scanned: events.length };
}

/**
 * A label write is explained by a `pr-label` row for the same (PR, label,
 * action) requested within the match window, or by an earlier row whose
 * attempt counter shows it was re-requested.
 */
function hasMatchingLabelRow(ledger: Ledger, entry: LabelWriteEntry): boolean {
  const at = Date.parse(entry.at);
  const rows = ledger.listSideEffectsByKind('pr-label', { keyPrefix: prLabelKeyPrefix(entry.prNumber, entry.label, entry.action) });
  return rows.some((row) => {
    const requested = Date.parse(row.requested_at);
    if (Math.abs(requested - at) <= LABEL_WRITE_MATCH_WINDOW_MS) return true;
    return row.attempt > 0 && requested <= at + LABEL_WRITE_MATCH_WINDOW_MS;
  });
}

function findMissingLabelRows(ledger: Ledger, writes: LabelWriteEntry[], windowStartMs: number, nowMs: number): MissingRowFinding[] {
  const findings: MissingRowFinding[] = [];
  for (const entry of writes) {
    const at = Date.parse(entry.at);
    // Writes still inside the match window may not have their shadow row yet.
    if (!Number.isFinite(at) || at < windowStartMs || at > nowMs - LABEL_WRITE_MATCH_WINDOW_MS) continue;
    if (hasMatchingLabelRow(ledger, entry)) continue;
    findings.push({ category: 'missing-row', kind: 'pr-label', prNumber: entry.prNumber, label: entry.label, action: entry.action, observedAt: entry.at });
  }
  return findings;
}

/** Scan the ledger (and the label-write audit log) for class-S anomalies. Read-only. */
export function detectDuplicates(ledger: Ledger, options: DetectDuplicatesOptions = {}): DetectDuplicatesResult {
  const start = performance.now();
  const nowMs = (options.now ?? new Date()).getTime();
  const windowStartMs = nowMs - (options.sinceMs ?? DEFAULT_DETECTOR_WINDOW_MS);
  const windowStart = new Date(windowStartMs).toISOString();

  const duplicates = findDuplicates(ledger, windowStart);
  const labelWrites = options.labelWrites ?? (options.repoDir ? readMillLabelWrites(options.repoDir) : []);
  const inWindow = labelWrites.filter((entry) => Date.parse(entry.at) >= windowStartMs);
  const missing = findMissingLabelRows(ledger, inWindow, windowStartMs, nowMs);
  const duplicateKeysAllTime = SIDE_EFFECT_KINDS.reduce(
    (total, kind) => total + ledger.listSideEffectsByKind(kind, { minAttempt: 1 }).length,
    0,
  );

  return {
    findings: [...duplicates.findings, ...missing],
    duplicates: duplicates.findings.length,
    missingRows: missing.length,
    duplicateKeysAllTime,
    scanned: { duplicateEvents: duplicates.scanned, labelWrites: inWindow.length },
    windowStart,
    tookMs: Math.round(performance.now() - start),
  };
}

/** One greppable warn line per finding. */
export function formatFinding(finding: SideEffectFinding): string {
  if (finding.category === 'duplicate') {
    return `[side-effect-duplicate] duplicate kind=${finding.kind} key=${finding.idempotencyKey} attempt=${finding.attempt} applied=${finding.applied} at=${finding.observedAt}`;
  }
  return `[side-effect-duplicate] missing-row kind=${finding.kind} pr=${finding.prNumber} label=${finding.label} action=${finding.action} at=${finding.observedAt}`;
}

/** Append one JSONL audit record per run to `.wavemill/side-effect-duplicates.jsonl` (10 MiB rotation). */
export function appendDuplicateLog(repoDir: string, result: DetectDuplicatesResult, now: Date = new Date()): void {
  try {
    const dir = join(repoDir, '.wavemill');
    const path = join(dir, SIDE_EFFECT_DUPLICATE_LOG_FILENAME);
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(path, `${JSON.stringify({ at: now.toISOString(), ...result })}\n`);
  } catch {
    /* best-effort audit trail */
  }
}
