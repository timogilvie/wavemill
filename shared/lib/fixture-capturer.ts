/**
 * Real-state fixture capturer (HOK-3225 / A5)
 *
 * Snapshots `.wavemill/workflow-state.json`, the matching hook files under
 * `/tmp/wavemill-${session}-${taskId}.hook`, and the per-task stage-result
 * artifacts, then sanitises the result and returns one self-contained fixture
 * JSON value suitable for check-in to `tests/fixtures/real-state/`.
 *
 * The capture never invents a shape: it reads what the writers produced and
 * strips only the parts that are secret or environment-specific. Issue IDs
 * are routed through `task-identity.ts` so no inline `_c` regex appears.
 *
 * See `docs/testing-fixtures.md` for the recapture cadence.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  parseTaskId,
  challengerTaskId,
  ISSUE_ID_RE,
} from './task-identity.ts';
import { readWorkflowState, type WorkflowState, type TaskRecord } from './workflow-state.ts';
import { readStageResult, type StageName, type StageResult } from './stage-result.ts';

/** Which phase the capture represents; used to label the output file. */
export type FixturePhase =
  | 'planning'
  | 'coding'
  | 'review'
  | 'ready'
  | 'merge-queued'
  | 'merged'
  | 'challenge-pair'
  | 'aborted';

export const FIXTURE_PHASES: readonly FixturePhase[] = [
  'planning',
  'coding',
  'review',
  'ready',
  'merge-queued',
  'merged',
  'challenge-pair',
  'aborted',
] as const;

/** Fixture metadata block carried under `$fixture`. */
export interface FixtureMeta {
  /** ISO-8601 time the capture ran. */
  capturedAt: string;
  phase: FixturePhase;
  notes?: string;
  /** Optional git sha of workflow-task.schema.json at capture time. */
  sourceSchemaRevision?: string;
  /**
   * Debug-only id remap (original → fixture). Only present when the operator
   * passes `--debug-id-map`; omitted by default to keep secrets off disk.
   */
  idMap?: Record<string, string>;
}

/** The on-disk shape of a real-state fixture file. */
export interface FixtureFile {
  $fixture: FixtureMeta;
  workflowState: WorkflowState;
  hooks: Record<string, unknown>;
  stageResults: Record<string, Partial<Record<StageName, StageResult | null>>>;
}

export interface CaptureOptions {
  repoDir: string;
  /** Task IDs to include (primary and/or `_c`). */
  taskIds: string[];
  phase: FixturePhase;
  /** Overrides `/tmp` so tests can inject a hook dir. */
  hookDir?: string;
  /** Session the hook filenames use; defaults to the state file's `session`. */
  session?: string;
  notes?: string;
  /**
   * Rename prefix for sanitised task IDs. Default `FIXTURE`. The prefix must
   * form a valid Linear issue ID when combined with `-N` (`[A-Z][A-Z0-9]*`),
   * since `task-identity.parseTaskId()` validates the result.
   */
  idPrefix?: string;
  /** When true, embed the id remap under `$fixture.idMap`. */
  debugIdMap?: boolean;
  /** Override `Date.now` so captures are reproducible from tests. */
  now?: () => Date;
  /** Override the home dir for path redaction (tests). */
  homeDir?: string;
  /** Optional override for `sourceSchemaRevision`. */
  sourceSchemaRevision?: string;
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /sk-ant-api03-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  /Authorization:\s*token\s+[A-Za-z0-9]{20,}/g,
];

const CHALLENGER_SUFFIX_LEN = 2;

const TASK_ID_ANY_RE = new RegExp(
  `(?<![A-Za-z0-9])${ISSUE_ID_RE.source.slice(1, -1)}(?:_c)?(?![A-Za-z0-9])`,
  'g',
);

/**
 * Build a stable Linear-id → fixture-id map by walking the raw envelope. The
 * primary task IDs appear first (by first observation), each with a 1-based
 * index. Challenger IDs reuse their primary's index so a pair stays matched.
 */
export function buildIdMap(
  raw: {
    workflowState?: WorkflowState | null;
    hooks?: Record<string, unknown>;
    stageResults?: Record<string, unknown>;
  },
  idPrefix: string,
): Map<string, string> {
  const order: string[] = [];
  const linearSeen = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TASK_ID_ANY_RE)) {
        const parsed = parseTaskId(match[0]);
        if (!parsed) continue;
        if (!linearSeen.has(parsed.linearId)) {
          linearSeen.add(parsed.linearId);
          order.push(parsed.linearId);
        }
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k);
      visit(v);
    }
  };
  visit(raw.workflowState ?? null);
  visit(raw.hooks ?? {});
  visit(raw.stageResults ?? {});

  const map = new Map<string, string>();
  order.forEach((linearId, index) => {
    const fixturePrimary = `${idPrefix}-${index + 1}`;
    map.set(linearId, fixturePrimary);
    try {
      map.set(challengerTaskId(linearId), challengerTaskId(fixturePrimary));
    } catch {
      // linearId already passed parseTaskId above, so challengerTaskId cannot
      // reasonably throw; defensive catch keeps the capture tool unkillable.
    }
  });
  return map;
}

function rewriteOneTaskId(input: string, idMap: Map<string, string>): string {
  const parsed = parseTaskId(input);
  if (!parsed) return input;
  if (parsed.role === 'challenger') {
    const primary = idMap.get(parsed.linearId);
    if (!primary) return input;
    return challengerTaskId(primary);
  }
  return idMap.get(parsed.linearId) ?? input;
}

/** Replace every issue-id or task-id substring in a string using the id map. */
export function rewriteIssueIdsInString(
  input: string,
  idMap: Map<string, string>,
): string {
  return input.replace(TASK_ID_ANY_RE, (match) => rewriteOneTaskId(match, idMap));
}

/** Redact known secret shapes (defence in depth; the writers should never log them). */
export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/** Replace absolute home/user paths with `~` and this repo's path with `/workspace/wavemill`. */
export function redactPaths(input: string, homeDir: string, repoDir: string): string {
  let out = input;
  // Rewrite the repo path first so it isn't hidden behind the `~` rule, then
  // the home dir, then any `/home/<name>` style on another box.
  if (repoDir) {
    out = out.split(repoDir).join('/workspace/wavemill');
  }
  if (homeDir) {
    out = out.split(homeDir).join('~');
  }
  out = out.replace(/\/home\/[A-Za-z0-9_.-]+/g, '~');
  return out;
}

interface SanitiseStringContext {
  idMap: Map<string, string>;
  homeDir: string;
  repoDir: string;
  session: string;
}

function sanitiseString(value: string, ctx: SanitiseStringContext): string {
  let out = redactSecrets(value);
  out = redactPaths(out, ctx.homeDir, ctx.repoDir);
  out = rewriteIssueIdsInString(out, ctx.idMap);
  if (ctx.session && ctx.session !== 'wavemill-fixture') {
    // Only replace a bare session token (word-bounded) so we don't mangle
    // longer identifiers that happen to contain the session name.
    const sessionRe = new RegExp(`\\b${ctx.session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    out = out.replace(sessionRe, 'wavemill-fixture');
  }
  return out;
}

function sanitiseValue(value: unknown, ctx: SanitiseStringContext): unknown {
  if (typeof value === 'string') return sanitiseString(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => sanitiseValue(entry, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitisedKey = typeof k === 'string'
        ? sanitiseString(k, ctx)
        : k;
      out[sanitisedKey] = sanitiseValue(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * Pure sanitiser. Returns a new fixture value; the input is not mutated.
 */
export function sanitiseFixture(
  raw: FixtureFile,
  options: { idMap: Map<string, string>; homeDir: string; repoDir: string; session: string },
): FixtureFile {
  const ctx: SanitiseStringContext = { ...options };
  const workflowState = sanitiseValue(raw.workflowState, ctx) as WorkflowState;
  const hooks = sanitiseKeyedObject(raw.hooks, ctx);
  const stageResults = sanitiseKeyedObject(raw.stageResults, ctx) as Record<
    string,
    Partial<Record<StageName, StageResult | null>>
  >;

  // The workflow-state's `tasks` keys are task IDs; rewrite them too.
  if (workflowState.tasks && typeof workflowState.tasks === 'object') {
    workflowState.tasks = remapTaskKeys(workflowState.tasks, options.idMap) as Record<string, TaskRecord>;
  }

  return {
    $fixture: {
      ...raw.$fixture,
      ...(raw.$fixture.notes ? { notes: sanitiseString(raw.$fixture.notes, ctx) } : {}),
    },
    workflowState,
    hooks,
    stageResults,
  };
}

function sanitiseKeyedObject(
  input: Record<string, unknown>,
  ctx: SanitiseStringContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const newKey = rewriteIssueIdsInString(k, ctx.idMap);
    out[newKey] = sanitiseValue(v, ctx);
  }
  return out;
}

function remapTaskKeys(
  tasks: Record<string, TaskRecord>,
  idMap: Map<string, string>,
): Record<string, TaskRecord> {
  const out: Record<string, TaskRecord> = {};
  for (const [k, v] of Object.entries(tasks)) {
    const parsed = parseTaskId(k);
    const newKey = parsed ? rewriteOneTaskId(k, idMap) : k;
    out[newKey] = v;
  }
  return out;
}

/** Read a hook JSON file; returns `null` when missing or unparseable. */
export function readHookFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf-8');
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read all four stage-result artifacts for one task's feature dir. Missing
 * stages are returned as `null` so the structure is uniform.
 */
export async function readTaskStageResults(
  featureDir: string,
): Promise<Record<StageName, StageResult | null>> {
  const stages: StageName[] = ['planning', 'coding', 'review', 'ready'];
  const results = await Promise.all(
    stages.map((stage) => readStageResult({ featureDir, stage })),
  );
  const out = {} as Record<StageName, StageResult | null>;
  stages.forEach((stage, index) => {
    out[stage] = results[index] ?? null;
  });
  return out;
}

/** Resolve a task's feature directory from its workflow-state record. */
export function resolveFeatureDir(repoDir: string, task: TaskRecord): string | null {
  const slug = typeof task.slug === 'string' ? task.slug : null;
  if (!slug) return null;
  const worktree = typeof task.worktree === 'string' ? task.worktree : repoDir;
  for (const dir of ['features', 'bugs']) {
    const candidate = join(worktree, dir, slug);
    if (existsSync(candidate)) return candidate;
  }
  return join(worktree, 'features', slug);
}

/**
 * Top-level capture entry point.
 */
export async function captureFixture(options: CaptureOptions): Promise<FixtureFile> {
  const idPrefix = options.idPrefix ?? 'FIXTURE';
  if (!/^[A-Z][A-Z0-9]*$/.test(idPrefix)) {
    throw new Error(
      `invalid idPrefix ${JSON.stringify(idPrefix)}; must match /^[A-Z][A-Z0-9]*$/ `
        + 'so parseTaskId accepts the rewritten ids',
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const homeDir = options.homeDir ?? homedir();
  const statePath = join(options.repoDir, '.wavemill', 'workflow-state.json');
  const state = readWorkflowState(statePath, {
    onInvalid: (path, issues) => {
      process.stderr.write(
        `fixture-capturer: schema violations in ${path}; sanitising anyway: ${issues
          .slice(0, 5)
          .map((i) => `${i.path} ${i.message}`)
          .join('; ')}\n`,
      );
    },
  });
  if (!state) throw new Error(`workflow state is not readable at ${statePath}`);

  const session = options.session ?? (typeof state.session === 'string' ? state.session : 'wavemill');
  const hookDir = options.hookDir ?? '/tmp';

  const requestedIds = new Set<string>();
  for (const id of options.taskIds) {
    const parsed = parseTaskId(id);
    if (!parsed) throw new Error(`invalid task id: ${JSON.stringify(id)}`);
    requestedIds.add(parsed.taskId);
  }

  const picked = pickTasks(state, requestedIds);
  const hooks: Record<string, unknown> = {};
  const stageResults: Record<string, Partial<Record<StageName, StageResult | null>>> = {};
  for (const taskId of Object.keys(picked)) {
    const hook = readHookFile(join(hookDir, `wavemill-${session}-${taskId}.hook`));
    if (hook !== null) hooks[taskId] = hook;
    const featureDir = resolveFeatureDir(options.repoDir, picked[taskId]);
    if (featureDir) {
      stageResults[taskId] = await readTaskStageResults(featureDir);
    }
  }

  const rawEnvelope: FixtureFile = {
    $fixture: {
      capturedAt: now.toISOString(),
      phase: options.phase,
      ...(options.notes ? { notes: options.notes } : {}),
      ...(options.sourceSchemaRevision
        ? { sourceSchemaRevision: options.sourceSchemaRevision }
        : {}),
    },
    workflowState: {
      ...(state.session !== undefined ? { session: state.session } : {}),
      ...(state.started !== undefined ? { started: state.started } : {}),
      ...(state.updated !== undefined ? { updated: state.updated } : {}),
      tasks: picked,
    },
    hooks,
    stageResults,
  };

  const idMap = buildIdMap(rawEnvelope, idPrefix);
  const sanitised = sanitiseFixture(rawEnvelope, {
    idMap,
    homeDir,
    repoDir: options.repoDir,
    session,
  });

  if (options.debugIdMap) {
    sanitised.$fixture.idMap = Object.fromEntries(idMap);
  }
  return sanitised;
}

function pickTasks(state: WorkflowState, taskIds: Set<string>): Record<string, TaskRecord> {
  const out: Record<string, TaskRecord> = {};
  const tasks = state.tasks ?? {};
  for (const [key, record] of Object.entries(tasks)) {
    if (taskIds.has(key)) {
      out[key] = record;
    }
  }
  return out;
}

/** Suffix for a challenger task id — exposed for tests, not for inline string ops. */
export const FIXTURE_CHALLENGER_SUFFIX_LENGTH = CHALLENGER_SUFFIX_LEN;
