/**
 * Touch-set prediction for grounded wave planning (HOK-3131).
 *
 * A task's *touch set* is the set of repository files it will most likely
 * modify. The grounded planner compares touch sets to find pairs of tasks that
 * cannot safely run in parallel, so the prediction is grounded in the repo
 * rather than in an LLM's reading of task titles.
 *
 * Three passes run in order, each tagging its entries with a {@link TouchSource}:
 *
 * 1. `explicit` — repo-relative paths written in the task text that exist on disk
 *    (`shared/lib/wavemill-monitor.sh`, `tools/plan-queue.ts:282`).
 * 2. `resolved` — bare filenames (`tend-challenge-gate.ts:878`), partial paths,
 *    and backtick-quoted code identifiers (`packWaves`) resolved to tracked
 *    files via `git ls-files` / `git grep`.
 * 3. `predicted` — only for *vague* tasks (no path or identifier candidates at
 *    all), one batched LLM call predicts files from a directory tree and
 *    keyword hits. Every predicted path must exist on disk.
 *
 * All repository access goes through the {@link RepoProbe} interface so the
 * extraction logic stays pure and testable; {@link createGitRepoProbe} is the
 * production implementation.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, posix } from 'node:path';
import { execArgvCommand } from './shell-utils.ts';
import { fillPromptTemplate } from './prompt-utils.ts';

export type TouchSource = 'explicit' | 'resolved' | 'predicted';

export interface TouchEntry {
  /** Repo-relative POSIX path. */
  path: string;
  source: TouchSource;
  /**
   * Code identifiers from the task text that resolved into this file. Used by
   * the conflict scorer to tell apart two tasks editing different regions of
   * the same hot file.
   */
  symbols?: string[];
}

export interface TouchSet {
  taskId: string;
  entries: TouchEntry[];
}

export interface TouchSetTask {
  id: string;
  title?: unknown;
  description?: unknown;
}

/** Repository access used by the predictor. Inject a fake in tests. */
export interface RepoProbe {
  /** True when the repo-relative path is an existing regular file. */
  fileExists(path: string): boolean;
  /** Tracked repo-relative paths whose basename equals `name`. */
  findByBasename(name: string): string[];
  /** Tracked repo-relative paths ending with `/<suffix>`. */
  findBySuffix(suffix: string): string[];
  /** Tracked files containing `identifier` as a whole word. */
  grepFiles(identifier: string): string[];
  /**
   * Tracked files that appear to *define* `identifier` (function, class,
   * const, type, shell function). Optional: when absent or empty, every file
   * that mentions the identifier counts.
   */
  definitionFiles?(identifier: string): string[];
}

/** Result of the deterministic passes for one task. */
export interface DeterministicTouchSet extends TouchSet {
  /**
   * True when the task text contained no path or identifier candidates at all.
   * Only vague tasks are eligible for LLM prediction: a task that names a
   * file that no longer exists keeps an empty touch set instead.
   */
  vague: boolean;
}

/** Cap on identifiers resolved per task to bound `git grep` fan-out. */
export const MAX_IDENTIFIERS_PER_TASK = 5;
/** An identifier matching more files than this is too generic to be evidence. */
export const MAX_FILES_PER_IDENTIFIER = 6;
/** A bare filename matching more tracked files than this is ambiguous. */
export const MAX_BASENAME_MATCHES = 3;
/** Cap on LLM-predicted files per task. */
export const MAX_PREDICTED_FILES_PER_TASK = 8;
/** Cap on task description characters scanned and sent to the LLM. */
export const TOUCH_SET_DESCRIPTION_MAX_CHARS = 4_000;

const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'sh', 'bash', 'zsh', 'json', 'jsonl', 'md', 'yml', 'yaml',
  'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'css', 'scss', 'html', 'sql', 'toml', 'txt',
];
const EXTENSION_GROUP = FILE_EXTENSIONS.join('|');
// Path-ish token: optional leading ./, segments of [\w.-], ending in a known
// extension, optionally followed by a :line or :line-line reference.
const PATH_TOKEN = new RegExp(
  `(?<![\\w/.:-])(\\.{0,2}/)?((?:[\\w@.-]+/)*[\\w@.-]+\\.(?:${EXTENSION_GROUP}))(?::\\d+(?:-\\d+)?)?(?![\\w/])`,
  'g',
);
const BACKTICK_SPAN = /`([^`\n]{2,200})`/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENTIFIER_STOPWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean', 'object', 'array',
  'legacy', 'grounded', 'independent', 'conflict', 'must_precede', 'should_precede',
  'explicit', 'resolved', 'predicted', 'idle', 'working', 'blocked', 'error', 'main',
]);

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function taskText(task: TouchSetTask): string {
  const description = toText(task.description).slice(0, TOUCH_SET_DESCRIPTION_MAX_CHARS);
  return `${toText(task.title)}\n${description}`;
}

function normalizeRepoPath(raw: string): string | null {
  if (raw.includes('://') || isAbsolute(raw)) return null;
  const normalized = posix.normalize(raw.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (normalized.startsWith('../') || normalized === '..' || normalized === '.') return null;
  return normalized;
}

/**
 * Extract path-like tokens from free text.
 *
 * Returns `paths` (tokens with a directory component) and `basenames`
 * (bare filenames such as `tend-challenge-gate.ts`). Line suffixes are
 * stripped. Pure.
 */
export function extractPathCandidates(text: string): { paths: string[]; basenames: string[] } {
  const paths = new Set<string>();
  const basenames = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const [, lead, token] = match;
    if (!token || /^\d+(\.\d+)+$/.test(token)) continue;
    // Absolute (`/etc/x.txt`) and parent-relative (`../x.ts`) paths are outside the repo.
    if (lead === '/' || lead === '../') continue;
    const normalized = normalizeRepoPath(token);
    if (!normalized) continue;
    if (normalized.includes('/')) {
      const firstSegment = normalized.split('/')[0];
      if (/^[\w-]+\.(com|org|io|net|dev|ai)$/i.test(firstSegment)) continue;
      paths.add(normalized);
    } else {
      basenames.add(normalized);
    }
  }
  return { paths: [...paths], basenames: [...basenames] };
}

function looksLikeCodeIdentifier(token: string): boolean {
  if (!IDENTIFIER.test(token) || token.length < 4) return false;
  if (IDENTIFIER_STOPWORDS.has(token.toLowerCase())) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(token)) return token.includes('_'); // CONST_NAME, not ALLCAPS words
  if (/^[A-Z]+-\d+$/.test(token)) return false; // issue IDs
  return token.includes('_') || /[a-z][A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token);
}

/**
 * Extract code identifiers from backtick spans (`packWaves`, `wavemill_hook_read()`,
 * `selectFirstWave(plan)`). Only camelCase / snake_case / CONST_CASE tokens qualify,
 * so prose words in backticks are ignored. Pure; order of first appearance.
 */
export function extractIdentifierCandidates(text: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(BACKTICK_SPAN)) {
    const span = match[1].trim();
    if (span.includes('/') || new RegExp(`\\.(?:${EXTENSION_GROUP})(?::\\d+)?$`).test(span)) continue;
    // `foo()`, `foo(bar)`, `Foo.bar` → leading identifier(s)
    const head = span.replace(/\(.*$/, '');
    const parts = head.split('.').filter(Boolean);
    const candidate = parts[parts.length - 1] ?? '';
    if (!looksLikeCodeIdentifier(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    identifiers.push(candidate);
  }
  return identifiers;
}

function isSecondaryMatch(path: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /\.md$/.test(path);
}

/** Prefer implementation files over tests and docs when both match. */
function preferPrimary(paths: string[]): string[] {
  const primary = paths.filter((path) => !isSecondaryMatch(path));
  return primary.length > 0 ? primary : paths;
}

function sortEntries(entries: Iterable<TouchEntry>): TouchEntry[] {
  return [...entries]
    .map((entry) => (entry.symbols && entry.symbols.length > 0
      ? { ...entry, symbols: [...new Set(entry.symbols)].sort() }
      : { path: entry.path, source: entry.source }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

const SOURCE_RANK: Record<TouchSource, number> = { explicit: 0, resolved: 1, predicted: 2 };

function addEntry(entries: Map<string, TouchEntry>, path: string, source: TouchSource, symbol?: string): void {
  const existing = entries.get(path);
  if (!existing) {
    entries.set(path, { path, source, ...(symbol ? { symbols: [symbol] } : {}) });
    return;
  }
  if (SOURCE_RANK[source] < SOURCE_RANK[existing.source]) existing.source = source;
  if (symbol) existing.symbols = [...(existing.symbols ?? []), symbol];
}

/**
 * Run the deterministic passes (explicit paths, resolved names) for one task.
 * Pure given the probe.
 */
export function predictTouchSetDeterministic(task: TouchSetTask, probe: RepoProbe): DeterministicTouchSet {
  const text = taskText(task);
  const { paths, basenames } = extractPathCandidates(text);
  const identifiers = extractIdentifierCandidates(text).slice(0, MAX_IDENTIFIERS_PER_TASK);
  const entries = new Map<string, TouchEntry>();

  for (const path of paths) {
    if (probe.fileExists(path)) {
      addEntry(entries, path, 'explicit');
      continue;
    }
    // `lib/foo.ts` written without its leading directories.
    const matches = probe.findBySuffix(path);
    if (matches.length === 1) addEntry(entries, matches[0], 'resolved');
  }

  for (const basename of basenames) {
    if (probe.fileExists(basename)) {
      addEntry(entries, basename, 'explicit');
      continue;
    }
    const matches = preferPrimary(probe.findByBasename(basename));
    if (matches.length > 0 && matches.length <= MAX_BASENAME_MATCHES) {
      for (const match of matches) addEntry(entries, match, 'resolved');
    }
  }

  for (const identifier of identifiers) {
    // A function is edited where it is defined; call sites are only evidence
    // when no definition is found.
    const definitions = probe.definitionFiles?.(identifier) ?? [];
    const matches = preferPrimary(definitions.length > 0 ? definitions : probe.grepFiles(identifier));
    if (matches.length === 0 || matches.length > MAX_FILES_PER_IDENTIFIER) continue;
    for (const match of matches) addEntry(entries, match, 'resolved', identifier);
  }

  return {
    taskId: task.id,
    entries: sortEntries(entries.values()),
    vague: paths.length === 0 && basenames.length === 0 && identifiers.length === 0,
  };
}

/** Per-task grounding hints for the LLM prediction prompt. */
export interface TouchSetPredictionInput {
  task: TouchSetTask;
  /** Keyword search hits (e.g. from `findRelevantFiles`). */
  keywordHits?: string;
}

/**
 * Build the batched touch-set prediction prompt from the template.
 * Pure. Template placeholders: `{{DIRECTORY_TREE}}`, `{{TASKS}}`.
 */
export function buildTouchSetPredictionPrompt(
  template: string,
  inputs: TouchSetPredictionInput[],
  directoryTree: string,
): string {
  const tasks = inputs
    .map(({ task, keywordHits }) => [
      `- id: ${task.id}`,
      `  title: ${JSON.stringify(toText(task.title))}`,
      `  description: ${JSON.stringify(toText(task.description).slice(0, 1_500))}`,
      ...(keywordHits ? [`  keywordHits: |`, ...keywordHits.split('\n').slice(0, 30).map((line) => `    ${line}`)] : []),
    ].join('\n'))
    .join('\n');
  return fillPromptTemplate(template, { DIRECTORY_TREE: directoryTree, TASKS: tasks });
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed.endsWith('```') ? trimmed.slice(0, -3).trim() : trimmed;
}

/**
 * Parse `{"predictions":[{"id","files":[...]}]}` from the LLM.
 *
 * Unknown task IDs are ignored, non-existent paths dropped, and each task is
 * capped at {@link MAX_PREDICTED_FILES_PER_TASK}. Throws on malformed JSON so
 * the caller can log and fall back to empty touch sets.
 */
export function parseTouchSetPrediction(
  raw: string,
  taskIds: Iterable<string>,
  probe: Pick<RepoProbe, 'fileExists'>,
): Map<string, TouchEntry[]> {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { predictions?: unknown }).predictions)) {
    throw new Error('touch-set prediction must be an object with a predictions array');
  }
  const wanted = new Set(taskIds);
  const result = new Map<string, TouchEntry[]>();
  for (const item of (parsed as { predictions: unknown[] }).predictions) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, files } = item as { id?: unknown; files?: unknown };
    if (typeof id !== 'string' || !wanted.has(id) || !Array.isArray(files)) continue;
    const entries = new Map<string, TouchEntry>();
    for (const file of files) {
      if (typeof file !== 'string') continue;
      const path = normalizeRepoPath(file.trim());
      if (!path || !probe.fileExists(path)) continue;
      addEntry(entries, path, 'predicted');
      if (entries.size >= MAX_PREDICTED_FILES_PER_TASK) break;
    }
    result.set(id, sortEntries(entries.values()));
  }
  return result;
}

export interface PredictTouchSetsOptions {
  probe: RepoProbe;
  /**
   * Batched LLM prediction for vague tasks. Receives the vague tasks and
   * returns the raw model text. Omit to disable the LLM pass entirely.
   */
  llmPredict?: (inputs: TouchSetPredictionInput[]) => Promise<string>;
  /** Optional per-task grounding hints for the LLM pass. */
  keywordHits?: (task: TouchSetTask) => Promise<string> | string;
  /** Warning sink (defaults to console.warn). */
  warn?: (message: string) => void;
}

/**
 * Predict touch sets for many tasks: deterministic passes per task, then one
 * batched LLM call for the vague ones. Never throws — an LLM failure leaves
 * the vague tasks with empty touch sets.
 */
export async function predictTouchSets(tasks: TouchSetTask[], opts: PredictTouchSetsOptions): Promise<TouchSet[]> {
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const deterministic = tasks.map((task) => predictTouchSetDeterministic(task, opts.probe));
  const vague = deterministic.filter((set) => set.vague && set.entries.length === 0);

  const predicted = new Map<string, TouchEntry[]>();
  if (vague.length > 0 && opts.llmPredict) {
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    try {
      const inputs: TouchSetPredictionInput[] = [];
      for (const set of vague) {
        const task = taskById.get(set.taskId)!;
        const keywordHits = opts.keywordHits ? await opts.keywordHits(task) : undefined;
        inputs.push({ task, ...(keywordHits ? { keywordHits } : {}) });
      }
      const raw = await opts.llmPredict(inputs);
      for (const [taskId, entries] of parseTouchSetPrediction(raw, vague.map((set) => set.taskId), opts.probe)) {
        predicted.set(taskId, entries);
      }
    } catch (error) {
      warn(`[touch-set] LLM prediction failed; ${vague.length} vague task(s) keep empty touch sets: ${(error as Error).message}`);
    }
  }

  return deterministic.map(({ taskId, entries }) => ({
    taskId,
    entries: entries.length > 0 ? entries : (predicted.get(taskId) ?? []),
  }));
}

/** Single-task convenience wrapper around {@link predictTouchSets}. */
export async function predictTouchSet(task: TouchSetTask, opts: PredictTouchSetsOptions): Promise<TouchSet> {
  const [set] = await predictTouchSets([task], opts);
  return set;
}

function runGit(repoDir: string, args: string[]): string[] {
  const result = execArgvCommand('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // `git grep` exits 1 when nothing matches; stdout is still meaningful (empty).
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Production {@link RepoProbe} backed by git.
 *
 * Without `ref` it reads the working tree (`git ls-files`, `git grep`). With
 * `ref` it reads that commit instead (`git ls-tree`, `git grep <ref>`), which
 * the backtest uses so a task never "finds" a file its own PR created.
 * File listings run once lazily; grep results are memoized.
 */
export function createGitRepoProbe(repoDir: string, opts: { ref?: string } = {}): RepoProbe {
  const { ref } = opts;
  let tracked: string[] | undefined;
  let trackedSet: Set<string> | undefined;
  const trackedFiles = () =>
    (tracked ??= ref ? runGit(repoDir, ['ls-tree', '-r', '--name-only', ref]) : runGit(repoDir, ['ls-files']));
  const grepCache = new Map<string, string[]>();
  const definitionCache = new Map<string, string[]>();
  // `git grep <ref>` prefixes every hit with `<ref>:`.
  const grep = (args: string[], paths: string[]): string[] => {
    const lines = runGit(repoDir, ['grep', ...args, ...(ref ? [ref] : []), '--', ...paths]);
    return ref ? lines.map((line) => (line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line)) : lines;
  };

  const grepFiles = (identifier: string): string[] => {
    if (!IDENTIFIER.test(identifier)) return [];
    const cached = grepCache.get(identifier);
    if (cached) return cached;
    const files = grep(['-l', '-w', '-F', '-I', '-e', identifier], ['.']);
    grepCache.set(identifier, files);
    return files;
  };

  const definitionFiles = (identifier: string): string[] => {
    if (!IDENTIFIER.test(identifier)) return [];
    const cached = definitionCache.get(identifier);
    if (cached) return cached;
    const name = identifier.replace(/\$/g, '\\$');
    const pattern = [
      `(function|class|interface|type|enum|const|let|var|def|fn)[[:space:]]+${name}([^A-Za-z0-9_$]|$)`,
      `^[[:space:]]*${name}[[:space:]]*\\(\\)`,
    ].join('|');
    // Restrict the (slower) regex search to files that mention the identifier.
    const mentions = grepFiles(identifier);
    const files = mentions.length === 0 ? [] : grep(['-l', '-I', '-E', '-e', pattern], mentions);
    definitionCache.set(identifier, files);
    return files;
  };

  return {
    fileExists(path) {
      const normalized = normalizeRepoPath(path);
      if (!normalized) return false;
      if (ref) return (trackedSet ??= new Set(trackedFiles())).has(normalized);
      const absolute = join(repoDir, normalize(normalized));
      try {
        return existsSync(absolute) && statSync(absolute).isFile();
      } catch {
        return false;
      }
    },
    findByBasename(name) {
      return trackedFiles().filter((path) => posix.basename(path) === name);
    },
    findBySuffix(suffix) {
      return trackedFiles().filter((path) => path.endsWith(`/${suffix}`));
    },
    grepFiles,
    definitionFiles,
  };
}
