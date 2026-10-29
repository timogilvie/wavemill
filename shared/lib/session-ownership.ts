/**
 * Session ownership (HOK-3328): the one record of which harness sessions a
 * task launched, under which kind of work, and with which model.
 *
 * Only Wavemill knows its own launches, so every launch path writes one row to
 * `<state_dir>/.session-ownership.jsonl` *before* the child starts:
 *
 * - shell launchers (`agent-adapters.sh`) through the bash twin
 *   `session-ownership.sh`;
 * - native runs (`native-agent/launch-*.ts`) and `llm-cli.ts` helpers through
 *   {@link appendOwnershipRow}.
 *
 * Readers never re-derive ownership. Cost (`sdk-task-cost/meter.ts`) measures
 * exactly the owned session ids with `@hokusai/costs`; stage labels
 * (`execution-economics.ts`) and the executed model
 * (`executed-model-resolver.ts`) read the row that names a session. A session
 * found in the worktree with no row is reported as `operator` / `unowned` and
 * never charged to the task. This module is the only place that turns a row
 * into a `stageRole` (`tools/check-session-ownership.ts` enforces it).
 *
 * `sessionRef` is exact: the Claude Code `--session-id` the launcher minted,
 * the native runtime session id, or a Codex thread id. Codex picks its own
 * thread id, so a Codex launch records `pending:<nonce>` and the nonce is
 * resolved to the thread id once — from the `codex exec --json` stream
 * (helpers) or from the rollout whose first prompt carries the launch nonce
 * (`codex-rollout-resolver.ts`) — by appending a `resolution` line. An
 * unresolved pending row keeps its kind/stage but contributes no cost.
 *
 * The file is archived with the task under the same name
 * (`archive_stage_artifacts` in `wavemill-common.sh`), so post-reap evals read
 * it through {@link locateOwnershipRows} exactly like live ones.
 *
 * @module session-ownership
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionEconomicsStageRole } from './eval-schema.ts';

/** File name, identical live and in the archive. */
export const SESSION_OWNERSHIP_FILE = '.session-ownership.jsonl';

/** Row schema version; bump only for incompatible changes. */
export const SESSION_OWNERSHIP_SCHEMA_VERSION = 1;

export type SessionHarness = 'claude-code' | 'codex' | 'native';
export const SESSION_HARNESSES: readonly SessionHarness[] = ['claude-code', 'codex', 'native'];

export type OwnershipStage = 'planning' | 'coding' | 'review';
export const OWNERSHIP_STAGES: readonly OwnershipStage[] = ['planning', 'coding', 'review'];

/** Kinds of work a launch can own. Helper kinds carry their purpose. */
export const OWNERSHIP_KINDS = [
  'planning',
  'coding',
  'review',
  'ready-remediation',
  'conflict-resolution',
  'ci-fix',
  'native-arm',
] as const;
export type OwnershipKind = (typeof OWNERSHIP_KINDS)[number] | `helper:${string}`;

/** Label for a worktree session no launch row names. */
export const UNOWNED_SESSION_KIND = 'operator';

/** Prefix of a Codex sessionRef awaiting its thread id. */
const PENDING_PREFIX = 'pending:';

/** Marker line prepended to a Codex prompt so its rollout can be matched. */
const LAUNCH_NONCE_MARKER = 'wavemill-launch-nonce';

const HELPER_KIND_RE = /^helper:[a-z0-9][a-z0-9._-]{0,63}$/;

export interface SessionOwnershipRow {
  /** Exact session id, or `pending:<nonce>` until a Codex thread id resolves. */
  sessionRef: string;
  harness: SessionHarness;
  kind: OwnershipKind;
  /** Present when the kind is a canonical stage (or a native arm's stage). */
  stage?: OwnershipStage;
  /** Model the launch asked for (registry id); the executed model comes from telemetry. */
  model: string;
  /** ISO-8601, written before the child starts. */
  launchedAt: string;
  /** `<kind>@<head7>#<epoch-seconds>`; see {@link buildAttemptId}. */
  attemptId: string;
  /** Working directory of the launch (Codex rollouts are matched on it). */
  cwd?: string;
}

interface LaunchLine extends SessionOwnershipRow {
  schemaVersion: number;
  type: 'launch';
}

interface ResolutionLine {
  schemaVersion: number;
  type: 'resolution';
  pendingRef: string;
  sessionRef: string;
  resolvedAt: string;
}

export interface AppendOwnershipRowInput {
  sessionRef: string;
  harness: SessionHarness;
  kind: OwnershipKind;
  /** Required for `native-arm`; derived from the kind otherwise. */
  stage?: OwnershipStage;
  model: string;
  attemptId?: string;
  launchedAt?: string | Date;
  cwd?: string;
  /** Worktree HEAD used for the default attempt id. */
  head?: string | null;
}

// ────────────────────────────────────────────────────────────────
// Kinds, refs, attempts
// ────────────────────────────────────────────────────────────────

export function isOwnershipKind(value: unknown): value is OwnershipKind {
  return typeof value === 'string'
    && ((OWNERSHIP_KINDS as readonly string[]).includes(value) || HELPER_KIND_RE.test(value));
}

/** `helper:<purpose>`, with the purpose slugged to the allowed alphabet. */
export function helperKind(purpose: string): OwnershipKind {
  const slug = purpose.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
  return `helper:${slug || 'unnamed'}`;
}

/** Canonical stage a kind belongs to, when it is one. */
export function stageForKind(kind: OwnershipKind): OwnershipStage | undefined {
  return (OWNERSHIP_STAGES as readonly string[]).includes(kind) ? kind as OwnershipStage : undefined;
}

/** Fresh exact session id (lowercase UUID v4, accepted by `claude --session-id`). */
export function newSessionRef(): string {
  return randomUUID();
}

export function pendingSessionRef(nonce: string): string {
  return `${PENDING_PREFIX}${nonce}`;
}

export function isPendingSessionRef(ref: string): boolean {
  return ref.startsWith(PENDING_PREFIX);
}

/** Nonce of a pending ref, or null for an exact ref. */
export function pendingNonce(ref: string): string | null {
  return isPendingSessionRef(ref) ? ref.slice(PENDING_PREFIX.length) : null;
}

/** First prompt line that lets a Codex rollout prove which launch started it. */
export function launchNonceLine(nonce: string): string {
  return `<!-- ${LAUNCH_NONCE_MARKER}: ${nonce} -->`;
}

/** The launch nonce a prompt carries, or null. */
export function extractLaunchNonce(text: string): string | null {
  const match = new RegExp(`<!-- ${LAUNCH_NONCE_MARKER}: ([0-9a-f-]{8,64}) -->`).exec(text);
  return match ? match[1] : null;
}

/** `<kind>@<head7>#<epoch-seconds>` — identical to the shell twin's format. */
export function buildAttemptId(kind: OwnershipKind, head: string | null | undefined, at: Date): string {
  const head7 = typeof head === 'string' && /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7).toLowerCase() : 'nohead';
  return `${kind}@${head7}#${Math.floor(at.getTime() / 1000)}`;
}

// ────────────────────────────────────────────────────────────────
// Writers
// ────────────────────────────────────────────────────────────────

function appendLine(stateDir: string, line: LaunchLine | ResolutionLine): void {
  mkdirSync(stateDir, { recursive: true });
  // One O_APPEND write of a short line: concurrent launchers never interleave.
  appendFileSync(join(stateDir, SESSION_OWNERSHIP_FILE), `${JSON.stringify(line)}\n`, 'utf8');
}

/**
 * Record one launch. Throws on a malformed row (a programmer error at the
 * launch site); I/O errors propagate so the caller decides whether a launch
 * may proceed unrecorded.
 */
export function appendOwnershipRow(stateDir: string, input: AppendOwnershipRowInput): SessionOwnershipRow {
  if (!stateDir) throw new Error('appendOwnershipRow: stateDir is required');
  if (typeof input.sessionRef !== 'string' || input.sessionRef.trim() === '') {
    throw new Error('appendOwnershipRow: sessionRef is required');
  }
  if (!SESSION_HARNESSES.includes(input.harness)) {
    throw new Error(`appendOwnershipRow: unknown harness ${String(input.harness)}`);
  }
  if (!isOwnershipKind(input.kind)) {
    throw new Error(`appendOwnershipRow: unknown kind ${String(input.kind)}`);
  }
  const stage = input.stage ?? stageForKind(input.kind);
  if (input.kind === 'native-arm' && !stage) {
    throw new Error('appendOwnershipRow: a native-arm row needs its stage');
  }
  const launchedAt = input.launchedAt instanceof Date
    ? input.launchedAt
    : input.launchedAt ? new Date(input.launchedAt) : new Date();
  const row: SessionOwnershipRow = {
    sessionRef: input.sessionRef.trim(),
    harness: input.harness,
    kind: input.kind,
    ...(stage ? { stage } : {}),
    model: input.model ?? '',
    launchedAt: launchedAt.toISOString(),
    attemptId: input.attemptId ?? buildAttemptId(input.kind, input.head, launchedAt),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
  appendLine(stateDir, { schemaVersion: SESSION_OWNERSHIP_SCHEMA_VERSION, type: 'launch', ...row });
  return row;
}

/**
 * Launch-site wrapper: record a launch, but never fail it. A missing state
 * dir (a launch outside any task) records nothing — the session then shows up
 * as unowned, never as task cost. An I/O error is logged.
 */
export function recordLaunch(
  stateDir: string | null | undefined,
  input: AppendOwnershipRowInput,
  logger: Pick<Console, 'warn'> = console,
): SessionOwnershipRow | null {
  if (!stateDir) return null;
  try {
    return appendOwnershipRow(stateDir, input);
  } catch (error) {
    logger.warn(`[session-ownership] launch row not recorded: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Kind of a native launch: `$WAVEMILL_SESSION_KIND` when a remediation
 * launcher set it, else `native-arm` (whose stage is the native phase).
 */
export function nativeLaunchKind(env: NodeJS.ProcessEnv = process.env): OwnershipKind {
  const kind = env.WAVEMILL_SESSION_KIND;
  return isOwnershipKind(kind) ? kind : 'native-arm';
}

/** Resolve a `pending:<nonce>` row to its exact Codex thread id (once). */
export function appendSessionRefResolution(stateDir: string, pendingRef: string, sessionRef: string, at = new Date()): void {
  if (!isPendingSessionRef(pendingRef)) throw new Error(`appendSessionRefResolution: ${pendingRef} is not pending`);
  if (!sessionRef || isPendingSessionRef(sessionRef)) throw new Error('appendSessionRefResolution: exact sessionRef required');
  appendLine(stateDir, {
    schemaVersion: SESSION_OWNERSHIP_SCHEMA_VERSION,
    type: 'resolution',
    pendingRef,
    sessionRef,
    resolvedAt: at.toISOString(),
  });
}

// ────────────────────────────────────────────────────────────────
// Readers
// ────────────────────────────────────────────────────────────────

export interface OwnershipReadResult {
  rows: SessionOwnershipRow[];
  /** Lines skipped as malformed (count only). */
  malformedLines: number;
}

function parseLaunch(value: Record<string, unknown>): SessionOwnershipRow | null {
  const { sessionRef, harness, kind, stage, model, launchedAt, attemptId, cwd } = value;
  if (typeof sessionRef !== 'string' || sessionRef === '') return null;
  if (!SESSION_HARNESSES.includes(harness as SessionHarness)) return null;
  if (!isOwnershipKind(kind)) return null;
  if (typeof launchedAt !== 'string' || !Number.isFinite(Date.parse(launchedAt))) return null;
  const validStage = (OWNERSHIP_STAGES as readonly unknown[]).includes(stage) ? stage as OwnershipStage : undefined;
  return {
    sessionRef,
    harness: harness as SessionHarness,
    kind,
    ...(validStage ? { stage: validStage } : {}),
    model: typeof model === 'string' ? model : '',
    launchedAt,
    attemptId: typeof attemptId === 'string' ? attemptId : '',
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
  };
}

function readFileLines(file: string, launches: SessionOwnershipRow[], resolutions: Map<string, string>): number {
  let malformed = 0;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!value || typeof value !== 'object') {
      malformed++;
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.type === 'resolution') {
      if (typeof record.pendingRef === 'string' && typeof record.sessionRef === 'string'
        && isPendingSessionRef(record.pendingRef) && !isPendingSessionRef(record.sessionRef)) {
        if (!resolutions.has(record.pendingRef)) resolutions.set(record.pendingRef, record.sessionRef);
      } else {
        malformed++;
      }
      continue;
    }
    const launch = parseLaunch(record);
    if (launch) launches.push(launch);
    else malformed++;
  }
  return malformed;
}

/**
 * Read and merge ownership files. Resolutions replace pending refs; a
 * sessionRef named by several rows (a native session id reused by a
 * relaunch) keeps its earliest launch. Rows are returned in launch order.
 */
export function readOwnershipFiles(files: readonly string[]): OwnershipReadResult {
  const launches: SessionOwnershipRow[] = [];
  const resolutions = new Map<string, string>();
  let malformedLines = 0;
  for (const file of files) {
    if (existsSync(file)) malformedLines += readFileLines(file, launches, resolutions);
  }

  const byRef = new Map<string, SessionOwnershipRow>();
  for (const launch of launches) {
    const sessionRef = resolutions.get(launch.sessionRef) ?? launch.sessionRef;
    const row = { ...launch, sessionRef };
    const existing = byRef.get(sessionRef);
    if (!existing || Date.parse(row.launchedAt) < Date.parse(existing.launchedAt)) {
      byRef.set(sessionRef, row);
    }
  }
  const rows = [...byRef.values()].sort((a, b) => Date.parse(a.launchedAt) - Date.parse(b.launchedAt));
  return { rows, malformedLines };
}

/** Rows recorded in one state directory. */
export function readOwnershipRows(stateDir: string): SessionOwnershipRow[] {
  return readOwnershipFiles([join(stateDir, SESSION_OWNERSHIP_FILE)]).rows;
}

export interface LocateOwnershipInput {
  repoDir?: string;
  issueId?: string;
  slug?: string | null;
  worktreePath?: string;
}

/**
 * Every place a task's ownership file can live, live first: the worktree's
 * and the repo's `features|bugs/<slug>/`, then the eval archive
 * `.wavemill/evals/artifacts/<issue>/`. Same file name everywhere.
 */
export function ownershipFileCandidates(input: LocateOwnershipInput): string[] {
  const dirs: string[] = [];
  if (input.slug) {
    for (const root of [input.worktreePath, input.repoDir]) {
      if (!root) continue;
      for (const kind of ['features', 'bugs']) dirs.push(join(root, kind, input.slug));
    }
  }
  if (input.repoDir && input.issueId) {
    dirs.push(join(input.repoDir, '.wavemill', 'evals', 'artifacts', input.issueId));
  }
  return [...new Set(dirs)].map((dir) => join(dir, SESSION_OWNERSHIP_FILE));
}

/** The task's owned sessions, from whichever live/archive copies exist. */
export function locateOwnershipRows(input: LocateOwnershipInput): OwnershipReadResult & { files: string[] } {
  const files = ownershipFileCandidates(input).filter((file) => existsSync(file));
  return { ...readOwnershipFiles(files), files };
}

// ────────────────────────────────────────────────────────────────
// Groupings and the stage label
// ────────────────────────────────────────────────────────────────

/** Rows whose sessionRef is exact (pending Codex rows are excluded). */
export function exactRows(rows: readonly SessionOwnershipRow[]): SessionOwnershipRow[] {
  return rows.filter((row) => !isPendingSessionRef(row.sessionRef));
}

export function groupByHarness(rows: readonly SessionOwnershipRow[]): Map<SessionHarness, SessionOwnershipRow[]> {
  const groups = new Map<SessionHarness, SessionOwnershipRow[]>();
  for (const row of rows) groups.set(row.harness, [...(groups.get(row.harness) ?? []), row]);
  return groups;
}

export function groupByKind(rows: readonly SessionOwnershipRow[]): Map<OwnershipKind, SessionOwnershipRow[]> {
  const groups = new Map<OwnershipKind, SessionOwnershipRow[]>();
  for (const row of rows) groups.set(row.kind, [...(groups.get(row.kind) ?? []), row]);
  return groups;
}

export function indexBySessionRef(rows: readonly SessionOwnershipRow[]): Map<string, SessionOwnershipRow> {
  return new Map(rows.map((row) => [row.sessionRef, row]));
}

/** Rows that did the given stage's work (stage kinds and native arms of that stage). */
export function rowsForStage(rows: readonly SessionOwnershipRow[], stage: OwnershipStage): SessionOwnershipRow[] {
  return rows.filter((row) => row.stage === stage);
}

/**
 * The `executionEconomics` stage label for a session: read from the row that
 * names it, or `operator` / `unowned` when no launch recorded it. The only
 * producer of a session's `stageRole`.
 */
export function ownershipStageRole(row: SessionOwnershipRow | undefined): ExecutionEconomicsStageRole {
  if (!row) {
    return {
      value: null,
      kind: UNOWNED_SESSION_KIND,
      confidence: 'unowned',
      evidence: 'no launch row in .session-ownership.jsonl names this session',
    };
  }
  return {
    value: row.stage ?? null,
    kind: row.kind,
    confidence: 'launch_record',
    evidence: `launch ${row.attemptId} at ${row.launchedAt}`,
  };
}
