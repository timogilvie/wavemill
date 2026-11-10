/**
 * The one operator-escalation decision — TypeScript twin of
 * `shared/lib/operator-escalation.sh` (HOK-3360).
 *
 * Operator attention (`.needs-attention`, kind `ready-attention`) is raised by
 * exactly one step. {@link escalateOperatorAttention} writes the marker only
 * after the failure policy has escalated:
 *
 *   * `exhausted`         — a bounded-retry bucket is terminalized
 *                           (checked through {@link createStateDirRetry});
 *   * `policy-terminal`   — a decision whose class is `terminal`;
 *   * `operator-decision` — a code in {@link isOperatorDecisionCode}
 *                           (OPERATOR_DECISIONS).
 *
 * A basis that does not hold refuses the write (returns `false`, logs
 * `[escalation-refused]`), so a caller cannot page on a first occurrence by
 * mislabelling it. The marker shape matches the shell writer exactly (kind
 * `ready-attention`, headSha, reason = first line of the message, the basis in
 * `detail.escalationBasis`), so every existing reader keeps working.
 *
 * Enforced by `tools/check-failure-policy.ts`
 * (`attention-write-outside-escalation`): `writeReadyAttention` and raw
 * `writeMarker`/`path: '.needs-attention'` writes outside this module fail
 * preflight.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { writeMarker, type MarkerCondition } from './transient-marker.ts';
import { createStateDirRetry } from './bounded-retry.ts';
import { isOperatorDecisionCode } from './failure-policy.ts';

export type EscalationBasis =
  | { kind: 'exhausted'; bucket: string; maxAttempts?: number }
  | { kind: 'policy-terminal'; decisionClass: string }
  | { kind: 'operator-decision'; code: string };

export interface EscalateOperatorAttentionArgs {
  stateDir: string;
  headSha: string;
  basis: EscalationBasis;
  message: string;
  condition?: MarkerCondition;
  /** Override the warn sink (tests). */
  warn?: (message: string) => void;
}

function basisLabel(basis: EscalationBasis): string {
  switch (basis.kind) {
    case 'exhausted':
      return `exhausted:${basis.bucket}`;
    case 'policy-terminal':
      return `policy-terminal:${basis.decisionClass}`;
    case 'operator-decision':
      return `operator-decision:${basis.code}`;
  }
}

function basisHolds(stateDir: string, basis: EscalationBasis): { ok: boolean; reason?: string } {
  switch (basis.kind) {
    case 'exhausted': {
      // isExhausted only reads the sentinel; maxAttempts is irrelevant here.
      const retry = createStateDirRetry(basis.bucket, { maxAttempts: basis.maxAttempts ?? 1 });
      return retry.isExhausted(stateDir)
        ? { ok: true }
        : { ok: false, reason: `bucket ${basis.bucket} is not terminalized` };
    }
    case 'policy-terminal':
      return basis.decisionClass === 'terminal'
        ? { ok: true }
        : { ok: false, reason: `decision class='${basis.decisionClass}'` };
    case 'operator-decision':
      return isOperatorDecisionCode(basis.code)
        ? { ok: true }
        : { ok: false, reason: `'${basis.code}' is not a known OPERATOR_DECISIONS code` };
  }
}

export interface EscalationMarker {
  /** First line of the escalation message (JSON `reason`, else legacy text). */
  reason: string | null;
  headSha: string | null;
  /** ISO write time (JSON markers only; HOK-3468 reporting evidence). */
  writtenAt?: string;
  detail?: Record<string, unknown>;
  condition?: MarkerCondition;
  /** A pre-HOK-3360 plain-text body (no JSON `schemaVersion`). */
  legacy: boolean;
}

/**
 * The one `.needs-attention` path. Readers outside this module (the tend merge
 * gate, the monitor stage gates, the watchdog snapshot, the state invariants
 * and the replay harness) must use this — and {@link readEscalationMarker} for
 * content — so no file re-derives the marker path (HOK-3424).
 */
export function escalationMarkerPath(stateDir: string): string {
  return path.join(stateDir, '.needs-attention');
}

/**
 * Read the operator-escalation marker, JSON (HOK-3360) or legacy plain text.
 * Returns `null` when the file is absent or unreadable. Never throws.
 */
export function readEscalationMarker(stateDir: string): EscalationMarker | null {
  let content: string;
  try {
    content = readFileSync(escalationMarkerPath(stateDir), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as {
      schemaVersion?: unknown;
      reason?: unknown;
      headSha?: unknown;
      writtenAt?: unknown;
      detail?: unknown;
      condition?: unknown;
    };
    if (parsed && parsed.schemaVersion === 1 && typeof parsed === 'object') {
      return {
        reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
        headSha: typeof parsed.headSha === 'string' && parsed.headSha ? parsed.headSha : null,
        ...(typeof parsed.writtenAt === 'string' && parsed.writtenAt ? { writtenAt: parsed.writtenAt } : {}),
        ...(parsed.detail && typeof parsed.detail === 'object'
          ? { detail: parsed.detail as Record<string, unknown> }
          : {}),
        ...(parsed.condition && typeof parsed.condition === 'object'
          ? { condition: parsed.condition as MarkerCondition }
          : {}),
        legacy: false,
      };
    }
  } catch {
    // Legacy plain-text marker.
  }
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return { reason: firstLine || null, headSha: null, legacy: true };
}

/**
 * Raise operator attention for `stateDir` when `basis` holds. Returns whether
 * the marker was written; a refused basis never writes and is logged.
 */
export function escalateOperatorAttention(args: EscalateOperatorAttentionArgs): boolean {
  const { stateDir, headSha, basis, message, condition } = args;
  const warn = args.warn ?? ((m: string) => console.warn(m));

  const held = basisHolds(stateDir, basis);
  if (!held.ok) {
    warn(`[escalation-refused] basis=${basisLabel(basis)} does not hold for ${stateDir} (${held.reason}); refusing operator attention write`);
    return false;
  }

  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || message;
  writeMarker(
    { path: path.join(stateDir, '.needs-attention'), kind: 'ready-attention' },
    {
      headSha: headSha || 'unknown',
      reason: firstLine,
      detail: { escalationBasis: basisLabel(basis) },
      ...(condition ? { condition } : {}),
    },
  );
  return true;
}
