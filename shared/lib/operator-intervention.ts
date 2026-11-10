/**
 * Operator intervention artifacts.
 *
 * Provides a supported JSON contract for operator-recorded recovery work that
 * does not necessarily leave a PR comment, commit, or Claude transcript.
 *
 * @module operator-intervention
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

export const OPERATOR_INTERVENTION_FILENAME = '.operator-intervention.json';
export const OPERATOR_INTERVENTION_SCHEMA_VERSION = '1.0';

export type OperatorInterventionSeverity = 'minor' | 'major';
export type OperatorInterventionStage = 'routing' | 'planning' | 'coding' | 'review' | 'ready';

export interface OperatorInterventionRecord {
  schemaVersion: string;
  type: 'operator_recovery';
  severity: OperatorInterventionSeverity;
  occurredAt: string;
  issue?: string;
  stage?: OperatorInterventionStage;
  attempt?: number;
  trigger?: string;
  summary?: string;
  actionsTaken?: string[];
  codeWrittenByOperator?: boolean;
  scoringNote?: string;
  operator?: string;
  relatedCommit?: string;
  challengePairId?: string;
  [key: string]: unknown;
}

export interface BuildOperatorInterventionInput {
  severity: OperatorInterventionSeverity;
  trigger: string;
  summary: string;
  occurredAt?: string;
  issue?: string;
  stage?: OperatorInterventionStage;
  attempt?: number;
  actionsTaken?: string[];
  codeWrittenByOperator?: boolean;
  scoringNote?: string;
  operator?: string;
  relatedCommit?: string;
  challengePairId?: string;
}

export interface OperatorInterventionTarget {
  featureDir: string;
  searched: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function warn(message: string): void {
  console.warn(`[operator-intervention] ${message}`);
}

function readJson(path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (err) {
    warn(`Failed to read ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

function normalizeRecord(value: unknown, source: string, fallbackOccurredAt?: string): OperatorInterventionRecord | undefined {
  if (!isRecord(value)) {
    warn(`Skipping non-object record in ${source}`);
    return undefined;
  }

  const type = typeof value.type === 'string' ? value.type : 'operator_recovery';
  if (type !== 'operator_recovery') {
    warn(`Skipping unsupported intervention type '${type}' in ${source}`);
    return undefined;
  }

  if (value.severity !== 'minor' && value.severity !== 'major') {
    warn(`Skipping operator intervention without valid severity in ${source}`);
    return undefined;
  }

  const occurredAt =
    typeof value.occurredAt === 'string' && value.occurredAt.trim()
      ? value.occurredAt
      : fallbackOccurredAt ?? new Date().toISOString();

  const record: OperatorInterventionRecord = {
    ...value,
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : OPERATOR_INTERVENTION_SCHEMA_VERSION,
    type: 'operator_recovery',
    severity: value.severity,
    occurredAt,
  };

  if (typeof value.attempt === 'number' && Number.isFinite(value.attempt)) {
    record.attempt = value.attempt;
  } else {
    delete record.attempt;
  }

  if (Array.isArray(value.actionsTaken)) {
    record.actionsTaken = value.actionsTaken.filter((entry): entry is string => typeof entry === 'string');
  }

  return record;
}

/** Parse a raw operator intervention object or array, skipping invalid entries. */
export function parseOperatorInterventions(raw: unknown, source = 'operator intervention'): OperatorInterventionRecord[] {
  const fallbackOccurredAt = (() => {
    try {
      if (existsSync(source)) return statSync(source).mtime.toISOString();
    } catch {
      return undefined;
    }
    return undefined;
  })();
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((entry) => normalizeRecord(entry, source, fallbackOccurredAt))
    .filter((entry): entry is OperatorInterventionRecord => Boolean(entry));
}

/** Read operator interventions from a feature directory or direct JSON path. */
export function readOperatorInterventions(pathOrDir: string): OperatorInterventionRecord[] {
  const path = pathOrDir.endsWith('.json')
    ? pathOrDir
    : join(pathOrDir, OPERATOR_INTERVENTION_FILENAME);
  const raw = readJson(path);
  return raw === undefined ? [] : parseOperatorInterventions(raw, path);
}

/** Build a normalized operator intervention record with schema defaults. */
export function buildOperatorInterventionRecord(input: BuildOperatorInterventionInput): OperatorInterventionRecord {
  return {
    schemaVersion: OPERATOR_INTERVENTION_SCHEMA_VERSION,
    type: 'operator_recovery',
    severity: input.severity,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    trigger: input.trigger,
    summary: input.summary,
    ...(input.issue ? { issue: input.issue } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.actionsTaken?.length ? { actionsTaken: input.actionsTaken } : {}),
    ...(input.codeWrittenByOperator !== undefined ? { codeWrittenByOperator: input.codeWrittenByOperator } : {}),
    ...(input.scoringNote ? { scoringNote: input.scoringNote } : {}),
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.relatedCommit ? { relatedCommit: input.relatedCommit } : {}),
    ...(input.challengePairId ? { challengePairId: input.challengePairId } : {}),
  };
}

/** Write an intervention artifact atomically, appending by default. */
export function writeOperatorIntervention(
  featureDir: string,
  record: OperatorInterventionRecord,
  options: { append?: boolean } = {},
): string {
  mkdirSync(featureDir, { recursive: true });
  const path = join(featureDir, OPERATOR_INTERVENTION_FILENAME);
  let content: OperatorInterventionRecord | OperatorInterventionRecord[] = record;

  if (options.append !== false && existsSync(path)) {
    const existing = readOperatorInterventions(path);
    content = existing.length > 0 ? [...existing, record] : record;
  }

  const tmpPath = join(featureDir, `.tmp-operator-intervention-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmpPath, `${JSON.stringify(content, null, 2)}\n`);
  renameSync(tmpPath, path);
  return path;
}

function maybeFeatureDir(path: string): boolean {
  if (!existsSync(path)) return false;
  if (existsSync(join(path, 'selected-task.json'))) return true;
  const parent = basename(dirname(path));
  return parent === 'features' || parent === 'bugs';
}

function scanIssueMatch(dir: string, issue: string): string | undefined {
  try {
    if (!existsSync(dir)) return undefined;
    for (const slug of readdirSync(dir)) {
      const featureDir = join(dir, slug);
      const selected = readJson(join(featureDir, 'selected-task.json'));
      if (isRecord(selected) && selected.taskId === issue) return featureDir;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Resolve a CLI target to a feature/bug directory and report searched paths. */
export function resolveOperatorInterventionTarget(target: string, repoDir = process.cwd()): OperatorInterventionTarget {
  const root = resolve(repoDir);
  const searched: string[] = [];
  const direct = isAbsolute(target) ? target : resolve(root, target);

  searched.push(direct);
  if (maybeFeatureDir(direct) && existsSync(direct)) return { featureDir: direct, searched };

  const configuredRoot = loadWavemillConfig(root).mill?.worktreeRoot;
  const worktreeRoots = [configuredRoot, 'worktrees'].filter((value): value is string => Boolean(value));
  const candidates: string[] = [];

  for (const kind of ['features', 'bugs']) {
    candidates.push(join(root, kind, target));
  }
  for (const worktreeRoot of worktreeRoots) {
    for (const kind of ['features', 'bugs']) {
      candidates.push(join(resolve(root, worktreeRoot), target, kind, target));
    }
  }

  for (const candidate of candidates) {
    searched.push(candidate);
    if (existsSync(candidate)) return { featureDir: candidate, searched };
  }

  const issueRoots = [join(root, 'features'), join(root, 'bugs')];
  for (const worktreeRoot of worktreeRoots) {
    const resolvedRoot = resolve(root, worktreeRoot);
    searched.push(resolvedRoot);
    try {
      if (!existsSync(resolvedRoot)) continue;
      for (const child of readdirSync(resolvedRoot)) {
        issueRoots.push(join(resolvedRoot, child, 'features'), join(resolvedRoot, child, 'bugs'));
      }
    } catch {
      continue;
    }
  }
  for (const issueRoot of issueRoots) {
    searched.push(issueRoot);
    const match = scanIssueMatch(issueRoot, target);
    if (match) return { featureDir: match, searched };
  }

  throw new Error(`Could not resolve intervention target '${target}'. Searched:\n${searched.map((p) => `  - ${p}`).join('\n')}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** Format a compact event detail for eval records and judge prompts. */
export function formatOperatorInterventionDetail(record: OperatorInterventionRecord): string {
  const parts = [
    `severity=${record.severity}`,
    record.stage ? `stage=${record.stage}` : '',
    record.attempt !== undefined ? `attempt=${record.attempt}` : '',
    record.trigger ? `trigger=${record.trigger}` : '',
    record.summary ? `summary=${record.summary}` : '',
    record.codeWrittenByOperator ? 'codeWrittenByOperator=true' : '',
    record.scoringNote ? `scoringNote=${record.scoringNote}` : '',
  ].filter(Boolean);
  return truncate(parts.join('; '), 500);
}

// ── HOK-3182: operator touch taxonomy ────────────────────────────────────────

/**
 * Design §8f intervention classes. Each ledger phase flips its reads only
 * after its class's touches fall ≥70% against a pre-phase baseline, so every
 * counted touch carries exactly one class.
 *
 * - `O` ownership: pairing, orphans, "who owns this task" moves
 * - `L` liveness: unsticking a quiet agent (pane messages, approvals)
 * - `S` side effects: labels, pushes, Linear writes, merges
 * - `R` retry or recovery: re-running or repairing a stage
 */
export type InterventionClass = 'O' | 'L' | 'S' | 'R';

export const INTERVENTION_CLASSES: readonly InterventionClass[] = ['O', 'L', 'S', 'R'];

/** Attribution result for one operator touch. */
export type OperatorTouchAttribution = 'human' | 'automation' | 'approval';

/** Every evidence source an operator touch can be counted from. */
export type OperatorTouchKind =
  /** `operator_event_record` command (`.operator-events.jsonl`). */
  | 'operator-event'
  /** `.operator-intervention.json` recovery artifact. */
  | 'operator-intervention'
  /** Intervention recorded on the task's eval row (`evals.jsonl`). */
  | 'eval-intervention'
  /** Hook archive entry written by a human (`writer=user`). */
  | 'pane-message'
  /** Human prompt typed into the agent session after the launch prompt. */
  | 'session-redirect'
  /** `wm:*` (or other) PR label edit not performed by the mill or tend. */
  | 'label-edit'
  /** PR merged without tend's merge-lane receipt. */
  | 'external-merge'
  /** Commit on the task branch outside every recorded agent window. */
  | 'manual-push'
  /** `workflow-state.json` mutation from an interactive shell. */
  | 'state-edit';

/** Operator commands (`operator_event_record`) → class. Unknown → `R`. */
export const OPERATOR_COMMAND_CLASS: Readonly<Record<string, InterventionClass>> = {
  advance: 'R',
  're-review': 'R',
  reroute: 'R',
  'reroute-task': 'R',
  retry: 'R',
  cleanup: 'R',
  abort: 'O',
  adopt: 'O',
  release: 'O',
  reassign: 'O',
  'challenge-void': 'O',
  'challenge-forfeit': 'O',
  'void-challenge': 'O',
  approve: 'L',
  resolve: 'L',
  nudge: 'L',
  message: 'L',
  'send-message': 'L',
  wake: 'L',
};

/**
 * Operator-intervention `trigger` keywords → class, matched as substrings in
 * order. Recovery artifacts default to `R`; these carve out the ownership and
 * liveness shapes operators already record.
 */
export const OPERATOR_TRIGGER_CLASS: ReadonlyArray<readonly [string, InterventionClass]> = [
  ['orphan', 'O'],
  ['pair', 'O'],
  ['owner', 'O'],
  ['challenge', 'O'],
  ['stall', 'L'],
  ['stuck', 'L'],
  ['liveness', 'L'],
  ['idle', 'L'],
  ['label', 'S'],
  ['merge', 'S'],
  ['push', 'S'],
  ['linear', 'S'],
];

/** PR labels → class. Unknown labels are side effects (`S`). */
export const LABEL_CLASS: Readonly<Record<string, InterventionClass>> = {
  'wm:ready': 'S',
  'wm:blocked': 'S',
  'wm:merging': 'S',
  'wm:merged': 'S',
  'wm:superseded': 'O',
  'wm:owner': 'O',
  'wm:pair-primary': 'O',
  'wm:pair-challenger': 'O',
};

/**
 * Eval intervention detector names (the `[detector]` prefix on an eval
 * intervention's note, or its legacy `type`) → class. Unknown → `S`.
 */
export const EVAL_DETECTOR_CLASS: Readonly<Record<string, InterventionClass>> = {
  session_redirect: 'L',
  operator_recovery: 'R',
  prior_failed_attempt: 'R',
  test_fix: 'R',
  review_comment: 'S',
  post_pr_commit: 'S',
  manual_edit: 'S',
  self_review_blocker: 'S',
  self_review_warning: 'S',
  unknown_attribution: 'S',
};

/** Detectors that describe the mill's own work, not a person. */
export const AUTOMATION_EVAL_DETECTORS = new Set([
  'prior_failed_attempt',
  'self_review_blocker',
  'self_review_warning',
  'unknown_attribution',
  'test_fix',
  'post_pr_commit',
  'manual_edit',
]);

/** Provenance of a transcript message used to classify session redirects. */
export interface SessionMessageProvenance {
  /** `true` for meta/system messages (output limit, continuation, etc.). */
  isMeta?: boolean;
  /** `true` for compact-summary continuations. */
  isCompactSummary?: boolean;
  /** Origin kind, e.g. `task-notification`, `human`. */
  originKind?: string;
  /** Prompt source, e.g. `system`, `sdk`, `typed`. */
  promptSource?: string;
}

export interface ClassifiableTouch {
  kind: OperatorTouchKind;
  detail?: string;
  /** For `session-redirect`: the raw message text before truncation. */
  text?: string;
  /** For `session-redirect`: transcript provenance signals. */
  provenance?: SessionMessageProvenance;
  /** For `session-redirect`: kind of the session this message belongs to. */
  sessionKind?: string;
  /** For `session-redirect`: `true` if this is the first string message of an owned session. */
  firstInOwnedSession?: boolean;
  /** For `manual-push` / `eval-intervention`: commit attribution evidence. */
  commitAttribution?: CommitAttribution;
  /** For `external-merge`: `true` if tend wrote a merge receipt. */
  hasTendReceipt?: boolean;
  /** For `external-merge`: `true` if the merge actor is a mill/bot login. */
  millActor?: boolean;
  /** For `operator-intervention`: `true` when a dirty-tree handoff resolved via an owned relaunch. */
  selfRecovered?: boolean;
}

/** Commit attribution answers used by the classifier and reporting. */
export type CommitAttribution =
  | 'agent'
  | 'operator_handoff'
  | 'operator_out_of_window'
  | 'unattributed'
  | 'unknown';

/** First whitespace/colon-delimited token of a detail string, lower-cased. */
function leadingToken(detail: string | undefined): string {
  return (detail ?? '').trim().split(/[\s:]/, 1)[0].toLowerCase();
}

/** Extract `session_redirect` from `[session_redirect] …` (or a bare type). */
export function evalDetectorName(detail: string | undefined): string {
  const match = /^\[([a-z_]+)\]/.exec((detail ?? '').trim());
  return match ? match[1] : leadingToken(detail);
}

/**
 * Patterns that identify messages injected by the wavemill workflow orchestration
 * or Claude Code system internals, NOT actual human redirections.
 *
 * These messages appear as `type: 'user'` with string content in session JSONL
 * because they are sent programmatically to the agent, but they are not human
 * interventions.
 */
export const WORKFLOW_AUTOMATION_PATTERNS: RegExp[] = [
  // Phase transition context injections from agent-adapters.sh
  /^You are working on:/,
  // Review phase prompt injections
  /^#\s+Code Review/,
  // Claude Code system XML wrappers
  /^<local-command-caveat>/,
  /^<local-command-stdout>/,
  /^<command-name>/,
  // Slash command responses
  /^Unknown skill:/,
  // Exit/quit commands issued by the workflow
  /^<command-name>\/?exit<\/command-name>/,
  // User-prompt-submit-hook outputs
  /^<user-prompt-submit-hook>/,
  // Claude Code background-task completion notices (HOK-3182)
  /^<task-notification>/,
  // Task-packet review prompt injected during expansion (HOK-3182)
  /^#\s+Task Packet Reviewer/,
  // Issue-writer expansion prompt (tools/prompts/issue-writer.md) (HOK-3182)
  /^#\s+Issue Writer\b/,
  // Ready-check remediation prompt (agent-adapters.sh) (HOK-3182)
  /^You are remediating a ready-check failure/,
  // Claude Code's own auto-continue after a truncated response (HOK-3182)
  /^Your last response was cut off by an API error/,
  // Output token limit / context-window truncation notices
  /^Output token limit/,
  // Compact-summary continuation header
  /^This session is being continued/,
  // Loop wakeups
  /^\/loop/,
];

/** Whether a string message matches known mill/harness automation text. */
function isWorkflowAutomationMessage(content: string): boolean {
  const trimmed = content.trim();
  return WORKFLOW_AUTOMATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Approval phrases. `approved`, `approve`, `lgtm` and `<n> approved` with any
 * trailing text count anywhere; bare `yes`/`ok` count only in a planning session.
 */
function isApprovalMessage(touch: ClassifiableTouch): boolean {
  const text = (touch.text ?? touch.detail ?? '').trim();
  if (/^(approved|approve|lgtm)(\s*[,.:\-]?\s+.*)?$/i.test(text)) return true;
  if (/^\d+\s+approved(\s*[,.:\-]?\s+.*)?$/i.test(text)) return true;
  if (touch.sessionKind === 'planning' || touch.sessionKind?.startsWith('helper:plan')) {
    return /^(yes|ok)(\s*[,.:\-]?\s+.*)?$/i.test(text);
  }
  return false;
}

/**
 * Classify a `session-redirect` touch. Order (first match wins):
 * 1. Provenance says automated.
 * 2. Owned helper session.
 * 3. First message of an owned session.
 * 4. Text matches mill/harness table.
 * 5. Approval shape.
 * 6. Otherwise human.
 */
function classifySessionRedirect(touch: ClassifiableTouch): { attribution: OperatorTouchAttribution; class: InterventionClass } {
  const prov = touch.provenance ?? {};
  if (prov.isMeta || prov.isCompactSummary) {
    return { attribution: 'automation', class: 'L' };
  }
  if (prov.originKind === 'task-notification' || prov.promptSource === 'system' || prov.promptSource === 'sdk') {
    return { attribution: 'automation', class: 'L' };
  }
  if (touch.sessionKind?.startsWith('helper:')) {
    return { attribution: 'automation', class: 'L' };
  }
  if (touch.firstInOwnedSession) {
    return { attribution: 'automation', class: 'L' };
  }
  if (isWorkflowAutomationMessage(touch.text ?? touch.detail ?? '')) {
    return { attribution: 'automation', class: 'L' };
  }
  if (isApprovalMessage(touch)) {
    return { attribution: 'approval', class: 'L' };
  }
  return { attribution: 'human', class: 'L' };
}

/**
 * Classify one operator touch into its attribution (human/automation/approval)
 * and its design §8f class. Pure and table driven.
 *
 * Sources pass facts in `ClassifiableTouch`; the classifier never does IO.
 */
export function classifyOperatorTouch(touch: ClassifiableTouch): { attribution: OperatorTouchAttribution; class: InterventionClass } {
  switch (touch.kind) {
    case 'operator-event': {
      const token = leadingToken(touch.detail);
      if (token === 'approve') return { attribution: 'approval', class: 'L' };
      return { attribution: 'human', class: OPERATOR_COMMAND_CLASS[token] ?? 'R' };
    }
    case 'operator-intervention': {
      const trigger = (touch.detail ?? '').toLowerCase();
      if (trigger.includes('dirty-tree handoff') && touch.selfRecovered) {
        return { attribution: 'automation', class: 'R' };
      }
      for (const [needle, cls] of OPERATOR_TRIGGER_CLASS) {
        if (trigger.includes(needle)) return { attribution: 'human', class: cls };
      }
      return { attribution: 'human', class: 'R' };
    }
    case 'eval-intervention': {
      const detector = evalDetectorName(touch.detail);
      if (AUTOMATION_EVAL_DETECTORS.has(detector)) {
        return { attribution: 'automation', class: EVAL_DETECTOR_CLASS[detector] ?? 'S' };
      }
      if (detector === 'session_redirect') {
        return classifySessionRedirect({ ...touch, kind: 'session-redirect' });
      }
      return { attribution: 'human', class: EVAL_DETECTOR_CLASS[detector] ?? 'S' };
    }
    case 'pane-message':
      return { attribution: 'human', class: 'L' };
    case 'state-edit':
      return { attribution: 'human', class: 'R' };
    case 'session-redirect':
      return classifySessionRedirect(touch);
    case 'label-edit': {
      const label = (touch.detail ?? '').replace(/^(?:un)?labeled:/, '');
      return { attribution: 'human', class: LABEL_CLASS[label] ?? 'S' };
    }
    case 'manual-push': {
      const attr = touch.commitAttribution ?? 'unknown';
      if (attr === 'agent') return { attribution: 'automation', class: 'S' };
      if (attr === 'operator_handoff') return { attribution: 'human', class: 'R' };
      if (attr === 'operator_out_of_window') return { attribution: 'human', class: 'S' };
      // unattributed / unknown: not a human touch, reported separately
      return { attribution: 'automation', class: 'S' };
    }
    case 'external-merge': {
      if (touch.hasTendReceipt || touch.millActor) return { attribution: 'automation', class: 'S' };
      return { attribution: 'human', class: 'S' };
    }
    default:
      return { attribution: 'human', class: 'R' };
  }
}

/** Convenience: just the class for callers that already split attributions. */
export function operatorTouchClass(touch: ClassifiableTouch): InterventionClass {
  return classifyOperatorTouch(touch).class;
}

/** Zeroed per-class counter. */
export function emptyClassCounts(): Record<InterventionClass, number> {
  return { O: 0, L: 0, S: 0, R: 0 };
}

// ── HOK-3182: durable operator touch log ─────────────────────────────────────

/**
 * Repo-level append-only log of touches recorded at the moment they happen
 * (today: interactive `state_mutate` calls). Lives beside
 * `workflow-state.json` in `.wavemill/`, so it survives worktree reaping.
 * Written lock-free like every other JSONL log; the shell writer in
 * `wavemill-common.sh` (`operator_touch_record`) emits the same shape.
 */
export const OPERATOR_TOUCH_LOG_FILENAME = 'operator-touches.jsonl';

export interface OperatorTouchLogEntry {
  at: string;
  kind: OperatorTouchKind;
  issue?: string;
  class?: InterventionClass;
  actor?: string;
  detail?: string;
}

/** Path of the repo-level operator touch log. */
export function operatorTouchLogPath(repoDir: string): string {
  return join(resolve(repoDir), '.wavemill', OPERATOR_TOUCH_LOG_FILENAME);
}

/** Append one touch to the repo-level log, stamping its class. */
export function appendOperatorTouch(repoDir: string, entry: OperatorTouchLogEntry): string {
  const path = operatorTouchLogPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  const record: OperatorTouchLogEntry = {
    ...entry,
    class: entry.class ?? operatorTouchClass(entry),
  };
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

/** Read the repo-level touch log; malformed lines are skipped. */
export function readOperatorTouchLog(repoDir: string): OperatorTouchLogEntry[] {
  const path = operatorTouchLogPath(repoDir);
  if (!existsSync(path)) return [];
  const entries: OperatorTouchLogEntry[] = [];
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as OperatorTouchLogEntry;
        if (parsed && typeof parsed.at === 'string' && typeof parsed.kind === 'string') entries.push(parsed);
      } catch {
        continue;
      }
    }
  } catch (err) {
    warn(`Failed to read ${path}: ${errorMessage(err)}`);
  }
  return entries;
}
