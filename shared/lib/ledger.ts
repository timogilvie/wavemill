import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from './ledger-sqlite.ts';

type Db = InstanceType<typeof DatabaseSync>;
export type TaskKind = 'issue' | 'pair' | 'arm' | 'phase' | 'step' | 'side-effect';
export type TaskState = 'pending' | 'running' | 'waiting' | 'background' | 'done' | 'aborted' | 'interrupted';
export type SettledAs = 'done' | 'aborted' | 'interrupted';
export type Replay = 'safe' | 'unsafe' | 'atomic';
export type SideEffectKind = 'git-push' | 'pr-label' | 'pr-merge' | 'linear-transition';
export type WaitingTrigger = 'head' | 'operator-event' | 'review-artifact' | 'review-artifact-substantive' | 'ready-artifact' | 'remote' | 'waiting-on' | 'deadline';
export type EvidenceSource = 'agent-hook' | 'monitor' | 'controller' | 'operator';
export interface LedgerOpenOptions { repoDir?: string; dbPath?: string; readOnly?: boolean }
export interface TaskRow { id: string; parent_id: string | null; kind: TaskKind; slug: string; inputs_hash: string | null; state: TaskState; owner: string | null; next_action: string | null; deadline: string | null; background: number; replay: Replay; attempt: number; max_attempts: number | null; created_at: string; settled_at: string | null; settled_as: SettledAs | null; settled_reason: string | null }
export interface InsertTaskInput { id?: string; parentId?: string; kind: TaskKind; slug: string; inputsHash?: string; state?: Exclude<TaskState, SettledAs>; owner?: string; nextAction?: string; deadline?: string; background?: boolean; replay?: Replay; maxAttempts?: number }
export interface WaitingOnRow { step_id: string; trigger: WaitingTrigger; condition: string; recheck_after: string | null; recorded_at: string }
export interface EvidenceRow { id: string; step_id: string; source: EvidenceSource; event: string; detail: string | null; recorded_at: string }
export interface SideEffectRow { id: string; step_id: string; kind: SideEffectKind; idempotency_key: string; requested_at: string; applied_at: string | null; attempt: number; result: string | null; error: string | null }
export interface OperatorEventRow { task_id: string; seq: number; kind: string; payload: string | null; recorded_at: string; consumed_at: string | null }
export class TaskSettledError extends Error { readonly code = 'task_already_settled'; readonly taskId: string; constructor(taskId: string) { super(`task_already_settled: ${taskId}`); this.taskId = taskId; } }
export class ParentHasOpenChildrenError extends Error { readonly code = 'parent_has_open_children'; readonly parentId: string; constructor(parentId: string) { super(`parent_has_open_children: ${parentId}`); this.parentId = parentId; } }
export class UniqueConstraintError extends Error { readonly code = 'unique_constraint'; readonly constraint: string; constructor(constraint: string) { super(`unique_constraint: ${constraint}`); this.constraint = constraint; } }
export class CheckConstraintError extends Error { readonly code = 'check_constraint'; constructor(message: string) { super(message); } }
export class LedgerBindingUnavailableError extends Error { readonly code = 'ledger_binding_unavailable'; }
const now = () => new Date().toISOString();
const one = <T>(db: Db, sql: string, ...args: (string | number | null)[]): T | null => (db.prepare(sql).get(...args) as T | undefined) ?? null;
const many = <T>(db: Db, sql: string, ...args: (string | number | null)[]): T[] => db.prepare(sql).all(...args) as T[];
function translate(error: unknown, id = ''): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('parent_has_open_children')) throw new ParentHasOpenChildrenError(id);
  if (message.includes('task_already_settled')) throw new TaskSettledError(id);
  if (message.includes('UNIQUE constraint failed')) throw new UniqueConstraintError(message.includes('side_effect') ? 'side_effect_unique_key' : 'task_unique_inputs');
  if (message.includes('CHECK constraint failed')) throw new CheckConstraintError(message);
  throw error;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS task (
 id TEXT PRIMARY KEY, parent_id TEXT REFERENCES task(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('issue','pair','arm','phase','step','side-effect')),
 slug TEXT NOT NULL, inputs_hash TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','waiting','background','done','aborted','interrupted')),
 owner TEXT, next_action TEXT, deadline TEXT,
 background INTEGER NOT NULL DEFAULT 0 CHECK(background IN (0,1)),
 replay TEXT NOT NULL DEFAULT 'unsafe' CHECK(replay IN ('safe','unsafe','atomic')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0), max_attempts INTEGER CHECK(max_attempts IS NULL OR max_attempts >= 0),
 created_at TEXT NOT NULL, settled_at TEXT,
 settled_as TEXT CHECK(settled_as IN ('done','aborted','interrupted') OR settled_as IS NULL), settled_reason TEXT,
 CHECK((settled_as IS NULL AND settled_at IS NULL AND state NOT IN ('done','aborted','interrupted')) OR
       (settled_as IS NOT NULL AND settled_at IS NOT NULL AND state = settled_as)),
 UNIQUE(parent_id, slug, inputs_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_root_slug ON task(slug) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_parent_state ON task(parent_id,state);
CREATE INDEX IF NOT EXISTS idx_task_kind_slug ON task(kind,slug);
CREATE TRIGGER IF NOT EXISTS trg_task_parent_consistent BEFORE UPDATE OF settled_as ON task
 WHEN NEW.settled_as IS NOT NULL AND EXISTS(SELECT 1 FROM task c WHERE c.parent_id=NEW.id AND c.background=0 AND c.settled_as IS NULL)
 BEGIN SELECT RAISE(ABORT,'parent_has_open_children'); END;
CREATE TRIGGER IF NOT EXISTS trg_task_parent_insert BEFORE INSERT ON task
 WHEN NEW.settled_as IS NOT NULL AND EXISTS(SELECT 1 FROM task c WHERE c.parent_id=NEW.id AND c.background=0 AND c.settled_as IS NULL)
 BEGIN SELECT RAISE(ABORT,'parent_has_open_children'); END;
CREATE TRIGGER IF NOT EXISTS trg_task_settled_frozen BEFORE UPDATE ON task WHEN OLD.settled_as IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'task_already_settled'); END;
CREATE TRIGGER IF NOT EXISTS trg_task_child_after_settle BEFORE INSERT ON task
 WHEN NEW.parent_id IS NOT NULL AND NEW.background=0 AND EXISTS(SELECT 1 FROM task p WHERE p.id=NEW.parent_id AND p.settled_as IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'task_already_settled'); END;
CREATE TABLE IF NOT EXISTS waiting_on (
 step_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
 trigger TEXT NOT NULL CHECK(trigger IN ('head','operator-event','review-artifact','review-artifact-substantive','ready-artifact','remote','waiting-on','deadline')),
 condition TEXT NOT NULL, recheck_after TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(step_id,trigger));
CREATE TABLE IF NOT EXISTS evidence (
 id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('agent-hook','monitor','controller','operator')),
 event TEXT NOT NULL, detail TEXT, recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_evidence_step_recorded ON evidence(step_id,recorded_at);
CREATE TABLE IF NOT EXISTS side_effect (
 id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES task(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('git-push','pr-label','pr-merge','linear-transition')),
 idempotency_key TEXT NOT NULL, requested_at TEXT NOT NULL, applied_at TEXT,
 attempt INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, UNIQUE(kind,idempotency_key));
CREATE INDEX IF NOT EXISTS idx_side_effect_step ON side_effect(step_id);
CREATE TABLE IF NOT EXISTS operator_event (
 task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
 kind TEXT NOT NULL, payload TEXT, recorded_at TEXT NOT NULL, consumed_at TEXT,
 PRIMARY KEY(task_id,seq));
CREATE INDEX IF NOT EXISTS idx_operator_event_unconsumed ON operator_event(task_id) WHERE consumed_at IS NULL;
`;
const cache = new Map<string, Ledger>();
export class Ledger {
  private closed = false;
  readonly dbPath: string; private readonly db: Db; private readonly readOnly: boolean;
  private constructor(dbPath: string, db: Db, readOnly: boolean) { this.dbPath = dbPath; this.db = db; this.readOnly = readOnly; }
  static open(options: LedgerOpenOptions = {}): Ledger {
    const dbPath = resolve(options.dbPath ?? join(options.repoDir ?? process.env.WAVEMILL_MILLED_REPO_DIR ?? process.cwd(), '.wavemill', 'ledger.sqlite'));
    const cached = cache.get(dbPath);
    if (cached) return cached;
    if (!options.readOnly) mkdirSync(dirname(dbPath), { recursive: true });
    let db: Db;
    try { db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false }); }
    catch (error) { if (String(error).includes('node:sqlite')) throw new LedgerBindingUnavailableError('Node SQLite unavailable; upgrade to Node >=22.19'); throw error; }
    try {
      db.exec('PRAGMA busy_timeout=5000');
      if (!options.readOnly) {
        db.exec('PRAGMA journal_mode=WAL');
        if (one<{ journal_mode: string }>(db, 'PRAGMA journal_mode')?.journal_mode !== 'wal') throw new Error('ledger requires SQLite WAL mode');
        db.exec('PRAGMA synchronous=NORMAL');
      }
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA foreign_keys=ON');
      if (!options.readOnly) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
          const version = one<{ version: number }>(db, 'SELECT MAX(version) AS version FROM schema_version')?.version ?? 0;
          if (version > 1) throw new Error(`unsupported ledger schema version: ${version}`);
          if (version < 1) { db.exec(SCHEMA); db.prepare('INSERT INTO schema_version VALUES(1,?)').run(now()); }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const ledger = new Ledger(dbPath, db, options.readOnly ?? false);
      cache.set(dbPath, ledger);
      return ledger;
    } catch (error) { db.close(); throw error; }
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; cache.delete(this.dbPath); } }
  transaction<T>(fn: (tx: LedgerTx) => T): T {
    if (this.closed) throw new Error('ledger is closed');
    if (this.readOnly) throw new Error('ledger is read-only');
    const start = performance.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(new LedgerTx(this.db));
      if (result instanceof Promise) throw new Error('ledger transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { const ms = performance.now() - start; if (ms > 50) console.warn(`ledger transaction exceeded 50 ms: ${Math.round(ms)} ms`); }
  }
  getTask(id: string): TaskRow | null { return one(this.db, 'SELECT * FROM task WHERE id=?', id); }
  listTasks(filter: { parentId?: string; kind?: TaskKind; state?: TaskState } = {}): TaskRow[] {
    const clauses: string[] = []; const args: string[] = [];
    if (filter.parentId !== undefined) { clauses.push('parent_id=?'); args.push(filter.parentId); }
    if (filter.kind !== undefined) { clauses.push('kind=?'); args.push(filter.kind); }
    if (filter.state !== undefined) { clauses.push('state=?'); args.push(filter.state); }
    return many(this.db, `SELECT * FROM task ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at,id`, ...args);
  }
  listChildren(parentId: string): TaskRow[] { return this.listTasks({ parentId }); }
  listWaitingOn(stepId: string): WaitingOnRow[] { return many(this.db, 'SELECT * FROM waiting_on WHERE step_id=? ORDER BY trigger', stepId); }
  listEvidence(stepId: string): EvidenceRow[] { return many(this.db, 'SELECT * FROM evidence WHERE step_id=? ORDER BY recorded_at,id', stepId); }
  listSideEffects(stepId: string): SideEffectRow[] { return many(this.db, 'SELECT * FROM side_effect WHERE step_id=? ORDER BY requested_at,id', stepId); }
  listOperatorEvents(taskId: string): OperatorEventRow[] { return many(this.db, 'SELECT * FROM operator_event WHERE task_id=? ORDER BY seq', taskId); }
}
export class LedgerTx {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }
  insertTask(input: InsertTaskInput): TaskRow {
    const id = input.id ?? randomUUID();
    try {
      this.db.prepare(`INSERT INTO task(id,parent_id,kind,slug,inputs_hash,state,owner,next_action,deadline,background,replay,max_attempts,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.parentId ?? null,input.kind,input.slug,input.inputsHash ?? null,input.state ?? 'pending',input.owner ?? null,input.nextAction ?? null,input.deadline ?? null,input.background ? 1 : 0,input.replay ?? 'unsafe',input.maxAttempts ?? null,now());
    } catch (error) { translate(error, id); }
    return one<TaskRow>(this.db, 'SELECT * FROM task WHERE id=?', id)!;
  }
  transitionState(id: string, next: Exclude<TaskState, SettledAs>): void {
    if (!['pending','running','waiting','background'].includes(next)) throw new CheckConstraintError(`invalid nonterminal state: ${next}`);
    try {
      const result = this.db.prepare('UPDATE task SET state=? WHERE id=? AND settled_as IS NULL').run(next,id);
      if (!result.changes) this.requireOpen(id);
    } catch (error) { translate(error, id); }
  }
  settleTask(id: string, as: SettledAs, reason?: string): void {
    if (!['done','aborted','interrupted'].includes(as)) throw new CheckConstraintError(`invalid settlement: ${as}`);
    try {
      const result = this.db.prepare('UPDATE task SET state=?,settled_as=?,settled_at=?,settled_reason=? WHERE id=? AND settled_as IS NULL').run(as,as,now(),reason ?? null,id);
      if (!result.changes) this.requireOpen(id);
    } catch (error) { translate(error, id); }
  }
  incrementAttempt(id: string): number {
    try {
      const result = this.db.prepare('UPDATE task SET attempt=attempt+1 WHERE id=? AND settled_as IS NULL AND (max_attempts IS NULL OR attempt<max_attempts)').run(id);
      if (!result.changes) { this.requireOpen(id); throw new Error(`max attempts reached: ${id}`); }
      return one<{ attempt: number }>(this.db,'SELECT attempt FROM task WHERE id=?',id)!.attempt;
    } catch (error) { translate(error,id); }
  }
  private requireOpen(id: string): void { const row = one<TaskRow>(this.db,'SELECT * FROM task WHERE id=?',id); if (!row) throw new Error(`task not found: ${id}`); if (row.settled_as) throw new TaskSettledError(id); }
  setWaitingOn(stepId: string, trigger: WaitingTrigger, condition: unknown, recheckAfter?: string): void {
    this.requireOpen(stepId);
    try { this.db.prepare(`INSERT INTO waiting_on VALUES(?,?,?,?,?) ON CONFLICT(step_id,trigger) DO UPDATE SET condition=excluded.condition,recheck_after=excluded.recheck_after,recorded_at=excluded.recorded_at`).run(stepId,trigger,JSON.stringify(condition),recheckAfter ?? null,now()); }
    catch (error) { translate(error,stepId); }
  }
  clearWaitingOn(stepId: string, trigger?: WaitingTrigger): void { this.requireOpen(stepId); if (trigger) this.db.prepare('DELETE FROM waiting_on WHERE step_id=? AND trigger=?').run(stepId,trigger); else this.db.prepare('DELETE FROM waiting_on WHERE step_id=?').run(stepId); }
  recordEvidence(stepId: string, source: EvidenceSource, event: string, detail?: string): EvidenceRow {
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').run(id,stepId,source,event,detail ?? null,now()); }
    catch (error) { translate(error,stepId); }
    return one(this.db,'SELECT * FROM evidence WHERE id=?',id)!;
  }
  recordSideEffect(input: { stepId: string; kind: SideEffectKind; idempotencyKey: string }): { row: SideEffectRow; isNew: boolean } {
    const existing = one<SideEffectRow>(this.db,'SELECT * FROM side_effect WHERE kind=? AND idempotency_key=?',input.kind,input.idempotencyKey);
    if (existing) return { row: existing, isNew: false };
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO side_effect(id,step_id,kind,idempotency_key,requested_at) VALUES(?,?,?,?,?)').run(id,input.stepId,input.kind,input.idempotencyKey,now()); }
    catch (error) { translate(error,input.stepId); }
    return { row: one(this.db,'SELECT * FROM side_effect WHERE id=?',id)!, isNew: true };
  }
  applySideEffect(id: string, result: unknown): SideEffectRow {
    this.db.prepare('UPDATE side_effect SET applied_at=COALESCE(applied_at,?), result=COALESCE(result,?),error=NULL WHERE id=? AND applied_at IS NULL').run(now(),JSON.stringify(result),id);
    return one(this.db,'SELECT * FROM side_effect WHERE id=?',id) ?? (() => { throw new Error(`side effect not found: ${id}`); })();
  }
  failSideEffect(id: string, error: string): SideEffectRow {
    this.db.prepare('UPDATE side_effect SET attempt=attempt+1,error=? WHERE id=? AND applied_at IS NULL').run(error,id);
    return one(this.db,'SELECT * FROM side_effect WHERE id=?',id) ?? (() => { throw new Error(`side effect not found: ${id}`); })();
  }
  recordOperatorEvent(input: { taskId: string; kind: string; payload?: unknown }): OperatorEventRow {
    const seq = one<{ seq: number }>(this.db,'SELECT COALESCE(MAX(seq),0)+1 AS seq FROM operator_event WHERE task_id=?',input.taskId)!.seq;
    this.db.prepare('INSERT INTO operator_event VALUES(?,?,?,?,?,NULL)').run(input.taskId,seq,input.kind,input.payload === undefined ? null : JSON.stringify(input.payload),now());
    return one(this.db,'SELECT * FROM operator_event WHERE task_id=? AND seq=?',input.taskId,seq)!;
  }
}
