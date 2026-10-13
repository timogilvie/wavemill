/**
 * Ledger shadow write helpers (HOK-3184 — Ledger E Phase 2).
 *
 * Phase 2 of the durable task ledger is shadow-only: review/Ready/eval
 * launches, bounded-retry counters, HOK-3172 condition markers, and
 * agent-sourced hook events mirror into the ledger, but every read path
 * continues to read files. These helpers are the writer-side primitives.
 *
 * Every exported function is wrapped in {@link withShadowSuppressing} at
 * its CLI call site — shadow writes must never crash the primary path
 * (plan §3f). The CLI itself (`tools/ledger.ts`) exits 0 by default on
 * any error; `--strict` preserves the exit code for tests.
 */

import { createHash } from 'node:crypto';
import {
  LedgerBindingUnavailableError,
  type Ledger,
  type LedgerTx,
  type TaskRow,
  type WaitingTrigger,
} from './ledger.ts';

export type StepKind = 'review' | 'ready' | 'eval';

/** Canonical input tuple for step identity. Only present fields participate in the hash. */
export interface StepInputs {
  headSha?: string;
  baseSha?: string;
  prNumber?: number;
  pairId?: string;
  side?: 'primary' | 'challenger';
  promptIdentity?: string;
}

/**
 * Canonical-JSON SHA-256 of the step identity tuple. Fields are serialised
 * in a fixed order so the hash is stable across callers and processes. An
 * empty tuple returns a sentinel so step rows for recovery launches without
 * known inputs still get a distinct identity.
 */
export function computeStepInputsHash(input: StepInputs): string {
  const normalized: Record<string, unknown> = {};
  const order: (keyof StepInputs)[] = [
    'headSha',
    'baseSha',
    'prNumber',
    'pairId',
    'side',
    'promptIdentity',
  ];
  for (const key of order) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    normalized[key] = value;
  }
  const payload = JSON.stringify(normalized);
  return createHash('sha256').update(payload).digest('hex');
}

const DEFAULT_STEP_TTL_MINUTES: Readonly<Record<string, number>> = { review: 15, ready: 15, eval: 60 };
const FALLBACK_STEP_TTL_MINUTES = 30;

/**
 * Minutes a step may run before the Ledger F recovery loop (HOK-3185)
 * inspects it. Per-kind override `WAVEMILL_LEDGER_STEP_TTL_<KIND>_MINUTES`,
 * then `WAVEMILL_LEDGER_STEP_TTL_MINUTES`.
 */
export function stepTtlMinutes(kind: string, env: NodeJS.ProcessEnv = process.env): number {
  for (const raw of [env[`WAVEMILL_LEDGER_STEP_TTL_${kind.toUpperCase()}_MINUTES`], env.WAVEMILL_LEDGER_STEP_TTL_MINUTES]) {
    const parsed = Number.parseFloat(raw ?? '');
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_STEP_TTL_MINUTES[kind] ?? FALLBACK_STEP_TTL_MINUTES;
}

/** Default `deadline` for a step launched at `now`; `upsertStep` stamps it when the launcher passes none. */
export function defaultStepDeadline(kind: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): string {
  return new Date(now.getTime() + stepTtlMinutes(kind, env) * 60_000).toISOString();
}

export interface UpsertStepArgs {
  issueKey: string;
  kind: StepKind;
  inputsHash: string;
  owner?: string;
  nextAction?: string;
  deadline?: string;
  maxAttempts?: number;
}

export interface UpsertStepResult {
  id: string;
  inputsHash: string;
  isNew: boolean;
}

/**
 * Idempotently upsert the issue root row for a Linear issue key. The root
 * row is a `kind='issue'` task with `parent_id IS NULL` and a slug matching
 * the issue key. The unique index on `(slug) WHERE parent_id IS NULL`
 * enforces one root per issue. Returns the existing row when present.
 */
export function ensureIssueRoot(ledger: Ledger, issueKey: string): TaskRow {
  const roots = ledger.listTasks({ kind: 'issue' });
  const existing = roots.find((row) => row.slug === issueKey && row.parent_id === null);
  if (existing) return existing;
  return ledger.transaction((tx) =>
    tx.insertTask({ kind: 'issue', slug: issueKey, state: 'running' }),
  );
}

/**
 * Insert a child step row keyed on `(parent_id, slug, inputs_hash)`. If a
 * row with the same inputs hash exists, returns the existing id without
 * clobbering state. New rows are promoted directly to `running` (plan
 * §10 Q2) because the stage is about to launch.
 */
export function upsertStep(ledger: Ledger, args: UpsertStepArgs): UpsertStepResult {
  const root = ensureIssueRoot(ledger, args.issueKey);
  const existing = ledger
    .listChildren(root.id)
    .find(
      (row) => row.kind === 'step' && row.slug === args.kind && row.inputs_hash === args.inputsHash,
    );
  if (existing) return { id: existing.id, inputsHash: args.inputsHash, isNew: false };
  const inserted = ledger.transaction((tx) => {
    const row = tx.insertTask({
      parentId: root.id,
      kind: 'step',
      slug: args.kind,
      inputsHash: args.inputsHash,
      owner: args.owner,
      nextAction: args.nextAction,
      deadline: args.deadline ?? defaultStepDeadline(args.kind),
      maxAttempts: args.maxAttempts,
    });
    tx.transitionState(row.id, 'running');
    return row;
  });
  return { id: inserted.id, inputsHash: args.inputsHash, isNew: true };
}

/**
 * Return the newest non-settled step row for an issue (optionally filtered
 * by step kind). Used by the evidence writer to resolve a target step when
 * an agent hook fires. Returns null when no live step exists — the caller
 * silently drops the evidence (plan §3e).
 */
export function findActiveStep(
  ledger: Ledger,
  issueKey: string,
  kind?: StepKind,
): TaskRow | null {
  const roots = ledger.listTasks({ kind: 'issue' });
  const root = roots.find((row) => row.slug === issueKey && row.parent_id === null);
  if (!root) return null;
  const children = ledger.listChildren(root.id).filter(
    (row) => row.kind === 'step' && row.settled_as === null && (kind === undefined || row.slug === kind),
  );
  if (children.length === 0) return null;
  // listChildren orders by created_at then id; newest is last.
  return children[children.length - 1];
}

/** Increment the step's attempt counter. Thin wrapper around tx.incrementAttempt. */
export function recordRetryAttempt(ledger: Ledger, stepId: string): number {
  return ledger.transaction((tx) => tx.incrementAttempt(stepId));
}

/**
 * Terminalise a step row with a bounded-retry exhaustion reason. The ledger
 * mirror of writing a `.retry-<bucket>-exhausted` sentinel on disk.
 */
export function markRetryExhausted(
  ledger: Ledger,
  stepId: string,
  bucket: string,
  reason?: string,
): void {
  const settledReason = reason ? `exhausted:${bucket}:${reason}` : `exhausted:${bucket}`;
  ledger.transaction((tx) => tx.settleTask(stepId, 'aborted', settledReason));
}

/** Mirror a HOK-3172 marker_write — writes a waiting_on row for a step/issue id. */
export function setWaitingOnFromMarker(
  ledger: Ledger,
  stepOrIssueId: string,
  trigger: WaitingTrigger,
  condition: unknown,
  recheckAfter?: string,
): void {
  ledger.transaction((tx) => tx.setWaitingOn(stepOrIssueId, trigger, condition, recheckAfter));
}

/** Mirror a HOK-3172 marker removal — deletes one or all waiting_on rows for a step/issue id. */
export function clearWaitingOnFromMarker(
  ledger: Ledger,
  stepOrIssueId: string,
  trigger?: WaitingTrigger,
): void {
  ledger.transaction((tx) => tx.clearWaitingOn(stepOrIssueId, trigger));
}

/**
 * Record an agent-sourced hook event as an evidence row on the newest
 * running step. Returns null when no live step is found (benign gap during
 * planning or between stages). Writer=agent is enforced by construction —
 * only agent-hook writes should ever call this.
 */
export function recordAgentEvidence(
  ledger: Ledger,
  issueKey: string,
  event: string,
  detail?: string,
): { stepId: string; eventId: string } | null {
  const step = findActiveStep(ledger, issueKey);
  if (!step) return null;
  const row = ledger.transaction((tx) =>
    tx.recordEvidence(step.id, 'agent-hook', event, detail),
  );
  return { stepId: step.id, eventId: row.id };
}

/** Settle a step with the given terminal state and optional reason. */
export function settleStep(
  ledger: Ledger,
  stepId: string,
  settledAs: 'done' | 'aborted' | 'interrupted',
  reason?: string,
): void {
  ledger.transaction((tx) => tx.settleTask(stepId, settledAs, reason));
}

export interface SuppressingOptions {
  logger?: (message: string, error: unknown) => void;
  strict?: boolean;
}

/**
 * Run a shadow write, swallowing every error (including the binding-missing
 * error on older Node). Returns null on failure. Used at every CLI entry
 * point so a stale lock, missing binding, or malformed input never crashes
 * the shell caller.
 *
 * When `strict` is true, errors are re-thrown (used by tests).
 */
export function withShadowSuppressing<T>(
  fn: () => T,
  options: SuppressingOptions = {},
): T | null {
  try {
    return fn();
  } catch (error) {
    if (options.strict) throw error;
    const logger = options.logger ?? defaultLogger;
    const code = error instanceof LedgerBindingUnavailableError ? 'binding_unavailable' : 'shadow_error';
    logger(code, error);
    return null;
  }
}

function defaultLogger(message: string, error: unknown): void {
  if (process.env.WAVEMILL_LEDGER_SHADOW_DEBUG === '1') {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ledger-shadow] ${message}: ${detail}\n`);
  }
}

/** Build a {@link StepInputs} tuple from loose string inputs (for the CLI). */
export function stepInputsFromCliArgs(args: Record<string, string | undefined>): StepInputs {
  const result: StepInputs = {};
  if (args.head) result.headSha = args.head;
  if (args.base) result.baseSha = args.base;
  if (args.pr) {
    const parsed = Number.parseInt(args.pr, 10);
    if (Number.isFinite(parsed)) result.prNumber = parsed;
  }
  if (args.pair) result.pairId = args.pair;
  if (args.side === 'primary' || args.side === 'challenger') result.side = args.side;
  if (args.prompt) result.promptIdentity = args.prompt;
  return result;
}

/** Allowlist of HOK-3172 triggers used by the shell → CLI bridge. */
export function parseWaitingTrigger(value: string): WaitingTrigger {
  switch (value) {
    case 'head':
    case 'operator-event':
    case 'review-artifact':
    case 'review-artifact-substantive':
    case 'ready-artifact':
    case 'remote':
    case 'waiting-on':
    case 'deadline':
      return value;
    default:
      throw new Error(`invalid waiting_on trigger: ${value}`);
  }
}

/** Compact canonical JSON digest of condition object — used by the consistency checker. */
export function canonicalConditionJson(input: unknown): string {
  if (input === null || input === undefined) return 'null';
  if (typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalConditionJson).join(',')}]`;
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${canonicalConditionJson(value)}`).join(',')}}`;
}

/**
 * Idempotently upsert a top-level `kind='pair'` row for a challenge pair.
 * The unique index on `(slug) WHERE parent_id IS NULL` enforces one pair
 * row per pairId. On create, records the execution intent as evidence.
 * Returns the existing row when present (idempotent).
 */
export function ensurePair(ledger: Ledger, pairId: string, intent?: unknown): TaskRow {
  const roots = ledger.listTasks({ kind: 'pair' });
  const existing = roots.find((row) => row.slug === pairId && row.parent_id === null);
  if (existing) return existing;

  const row = ledger.transaction((tx) => {
    const pairRow = tx.insertTask({ kind: 'pair', slug: pairId, state: 'running' });
    if (intent !== undefined && intent !== null) {
      const detail = canonicalConditionJson(intent);
      tx.recordEvidence(pairRow.id, 'controller', 'pair-intent-recorded', detail);
    }
    return pairRow;
  });
  return row;
}

/**
 * Idempotently upsert a `kind='arm'` child row for one side of a challenge
 * pair. The unique index on `(parent_id, slug, inputs_hash)` enforces one
 * arm per issue key per pair. State starts at 'running'. Returns the
 * existing row when present (idempotent).
 */
export function ensureArm(
  ledger: Ledger,
  pairId: string,
  armIssueKey: string,
  role: 'primary' | 'challenger',
  intent?: unknown,
): TaskRow {
  const pairRow = ensurePair(ledger, pairId, intent);

  const existing = ledger
    .listChildren(pairRow.id)
    .find((row) => row.kind === 'arm' && row.slug === armIssueKey);
  if (existing) return existing;

  const row = ledger.transaction((tx) =>
    tx.insertTask({
      parentId: pairRow.id,
      kind: 'arm',
      slug: armIssueKey,
      state: 'running',
      owner: role,
    }),
  );
  return row;
}

/**
 * Read the newest `pair-intent-recorded` evidence row for a pair and
 * parse its detail as the execution intent. Returns null when no such
 * evidence exists.
 */
export function readPairIntent(ledger: Ledger, pairId: string): unknown | null {
  const roots = ledger.listTasks({ kind: 'pair' });
  const pairRow = roots.find((row) => row.slug === pairId && row.parent_id === null);
  if (!pairRow) return null;

  const evidence = ledger.listEvidence(pairRow.id);
  const intentEvidence = evidence
    .filter((row) => row.source === 'controller' && row.event === 'pair-intent-recorded')
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));

  if (intentEvidence.length === 0) return null;

  const detail = intentEvidence[0].detail;
  if (!detail) return null;

  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

/**
 * Settle an arm row as aborted with the given reason. Thin wrapper around
 * tx.settleTask with error translation for the caller's convenience.
 */
export function settleArmAbort(ledger: Ledger, armId: string, reason: string): void {
  ledger.transaction((tx) => tx.settleTask(armId, 'aborted', reason));
}

/**
 * Read the pair's execution intent with fallback to the arm's local intent
 * copy (compat shim for the shadow window). Prefers the pair-row intent
 * (authoritative). When both exist, compares them and warns on mismatch,
 * recording drift as evidence. The pair row remains authoritative during
 * mismatch.
 *
 * Warn-and-continue — never throws during the shadow window.
 */
export function readPairIntentWithFallback(
  ledger: Ledger,
  pairId: string,
  armLocalIntent?: unknown,
): unknown | null {
  const pairIntent = readPairIntent(ledger, pairId);

  // Pair row is authoritative when present
  if (pairIntent !== null && pairIntent !== undefined) {
    // Compare with local copy if both exist
    if (armLocalIntent !== null && armLocalIntent !== undefined) {
      const pairJson = canonicalConditionJson(pairIntent);
      const localJson = canonicalConditionJson(armLocalIntent);

      if (pairJson !== localJson) {
        // Intent drift detected — warn and record evidence
        const pairHash = createHash('sha256').update(pairJson).digest('hex').slice(0, 8);
        const localHash = createHash('sha256').update(localJson).digest('hex').slice(0, 8);

        process.stderr.write(
          `[ledger-pair-intent-drift] pair=${pairId} local=${localHash} row=${pairHash}\n`,
        );

        // Record mismatch as evidence on the pair row
        try {
          const roots = ledger.listTasks({ kind: 'pair' });
          const pairRow = roots.find((row) => row.slug === pairId && row.parent_id === null);
          if (pairRow) {
            ledger.transaction((tx) =>
              tx.recordEvidence(
                pairRow.id,
                'controller',
                'pair-intent-mismatch',
                `local_hash=${localHash} row_hash=${pairHash}`,
              ),
            );
          }
        } catch (error) {
          // Shadow write failed — continue anyway
          if (process.env.WAVEMILL_LEDGER_SHADOW_DEBUG === '1') {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[ledger-pair-intent-drift] evidence write failed: ${message}\n`);
          }
        }
      }
    }
    return pairIntent;
  }

  // Fallback to local intent when pair row has none
  if (armLocalIntent !== null && armLocalIntent !== undefined) {
    return armLocalIntent;
  }

  return null;
}

/** Re-exported for convenience so bash callers see one surface. */
export { type Ledger, type LedgerTx };
