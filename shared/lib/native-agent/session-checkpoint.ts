/**
 * Hermetic session-state checkpoint.
 *
 * Packages the subset of a wavemill agent session that must be preserved to
 * re-execute (or counterfactually explore) a specific tool-selection decision
 * point: the working-tree contents the session touched, the sanitized runtime
 * environment, the event stream up to the decision, deterministic entropy
 * seeds, and content-addressed references to prior tool results.
 *
 * The layout on disk under `.wavemill/replay-checkpoints/<id>/`:
 *
 *   checkpoint.json       -- manifest (schema-versioned)
 *   event-stream.jsonl    -- copy of session events up to the decision point
 *   runtime-env.json      -- sanitized env snapshot (redaction applied)
 *   working-tree/         -- files touched by the session, keyed by rel path
 *   tool-results/         -- content-addressed prior tool outputs
 *   git-state.txt         -- HEAD SHA, dirty flag, submodule pin digest
 *
 * @module native-agent/session-checkpoint
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../redaction-profiles.ts';

/** Machine-readable reasons the checkpoint refused to be created. */
export type CheckpointRefusalReason =
  | 'HERMETICITY_VIOLATION'
  | 'INVALID_INPUT'
  | 'ALREADY_EXISTS';

export interface CheckpointInputEvent {
  /** Stable event id (`turn:i` or the source line's own id). */
  id: string;
  /** Free-form event kind — `tool_call`, `tool_result`, `message`, … */
  kind: string;
  /** Payload; may be redacted before write. */
  payload: unknown;
  /** Optional tool name for `tool_call`/`tool_result` events. */
  tool?: string;
  /** Optional tool category tag from menu-resolver, for hermeticity checks. */
  category?: string;
}

export interface CheckpointInputToolResult {
  /** Matches a `tool_call` event's id in the event stream. */
  callId: string;
  tool: string;
  category?: string;
  content: string;
}

export interface CheckpointInputWorkingFile {
  /** Repo-relative path (POSIX slashes preferred; normalized on write). */
  path: string;
  content: string;
}

export interface CheckpointInputRuntimeEnv {
  /** Whitelist of environment variable name→value pairs to preserve. */
  whitelistEnv?: Record<string, string>;
  /** True iff the session was allowed outbound network access. */
  network_access?: boolean;
  /** Model identifier held fixed for replay/counterfactual. */
  modelId: string;
}

export interface CheckpointInputGitState {
  headSha: string;
  dirty: boolean;
  submodulePinDigest?: string;
}

export interface CheckpointInputEntropy {
  /** Seed used for `Math.random`. */
  mathRandomSeed: number;
  /** Seed used for `Date.now` (unix ms of the first observation). */
  dateNowSeedMs: number;
  /** Sequence of `crypto.randomUUID` outputs captured during recording. */
  uuidSequence?: string[];
}

export interface CreateCheckpointInput {
  sessionId: string;
  decisionId: string;
  phase: string;
  events: CheckpointInputEvent[];
  toolResults: CheckpointInputToolResult[];
  workingFiles: CheckpointInputWorkingFile[];
  runtimeEnv: CheckpointInputRuntimeEnv;
  gitState: CheckpointInputGitState;
  entropy: CheckpointInputEntropy;
  /**
   * Tool menu that was presented at the decision point. `chosenTool` names
   * which one the live session selected; alternatives are the space the
   * counterfactual runner explores.
   */
  toolMenu: { toolNames: string[]; chosenTool: string };
  /** Optional non-hermetic marker labels (e.g. from the task packet). */
  taskLabels?: string[];
  /** Optional explicit clock for tests. */
  now?: () => Date;
}

export const CHECKPOINT_SCHEMA_VERSION = '1' as const;

export interface CheckpointManifest {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  sessionId: string;
  decisionId: string;
  phase: string;
  createdAt: string;
  modelId: string;
  chosenTool: string;
  toolMenu: string[];
  gitState: CheckpointInputGitState;
  entropy: CheckpointInputEntropy;
  runtimeEnv: {
    whitelistEnv: Record<string, string>;
    network_access: boolean;
    modelId: string;
  };
  hermeticityAttestation: {
    checks: string[];
    labels: string[];
  };
  redactionAttestation: {
    categories: string[];
    matchCount: number;
  };
  workingFileHashes: Record<string, string>;
  toolResultHashes: Record<string, string>;
  eventCount: number;
  /** SHA-256 of the manifest sans this field, computed at write time. */
  checkpointHash: string;
}

export interface CheckpointHandle {
  root: string;
  manifest: CheckpointManifest;
}

export class CheckpointRefusedError extends Error {
  readonly reason: CheckpointRefusalReason;
  readonly detail?: string;
  constructor(reason: CheckpointRefusalReason, detail?: string) {
    super(`Checkpoint refused (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'CheckpointRefusedError';
    this.reason = reason;
    this.detail = detail;
  }
}

const NETWORKED_TOOL_CATEGORIES: ReadonlySet<string> = new Set([
  'network',
  'browser',
  'http',
]);

const NETWORKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser',
  'browser_open',
  'browser_screenshot',
  'network_fetch',
  'fetch',
]);

const NON_HERMETIC_LABEL_MARKERS: ReadonlySet<string> = new Set([
  'network',
  'non-hermetic',
  'requires-network',
]);

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeFileSafe(path: string, data: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, data);
}

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\/+/, '').replace(/\\/g, '/');
}

function assertHermetic(input: CreateCheckpointInput): string[] {
  const violations: string[] = [];

  if (input.runtimeEnv.network_access) {
    violations.push('runtimeEnv.network_access=true');
  }

  for (const label of input.taskLabels ?? []) {
    const normalized = label.toLowerCase();
    if (NON_HERMETIC_LABEL_MARKERS.has(normalized)) {
      violations.push(`taskLabel:${normalized}`);
    }
  }

  for (const event of input.events) {
    if (event.category && NETWORKED_TOOL_CATEGORIES.has(event.category)) {
      violations.push(`event.category:${event.category}`);
    }
    if (event.tool && NETWORKED_TOOL_NAMES.has(event.tool)) {
      violations.push(`event.tool:${event.tool}`);
    }
  }

  for (const tr of input.toolResults) {
    if (tr.category && NETWORKED_TOOL_CATEGORIES.has(tr.category)) {
      violations.push(`toolResult.category:${tr.category}`);
    }
    if (NETWORKED_TOOL_NAMES.has(tr.tool)) {
      violations.push(`toolResult.tool:${tr.tool}`);
    }
  }

  if (violations.length > 0) {
    throw new CheckpointRefusedError(
      'HERMETICITY_VIOLATION',
      violations.join(', '),
    );
  }

  return [
    'runtimeEnv.network_access=false',
    'no networked tool events observed',
    'no non-hermetic task labels observed',
  ];
}

/**
 * Redact secret patterns from an arbitrary structured payload and return the
 * (possibly modified) value plus aggregate stats. This is the single write
 * path for every checkpoint byte, so the redaction attestation in the
 * manifest is authoritative.
 */
function redactPayload(value: unknown): { value: unknown; matchCount: number; categories: string[] } {
  const stats = { matchCount: 0, categories: new Set<string>() };
  const walked = walk(value, stats);
  return {
    value: walked,
    matchCount: stats.matchCount,
    categories: [...stats.categories],
  };

  function walk(node: unknown, s: { matchCount: number; categories: Set<string> }): unknown {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      s.matchCount += result.matchCount;
      for (const c of result.categories) s.categories.add(c);
      return result.text;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, s));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, s);
      }
      return out;
    }
    return node;
  }
}

/**
 * Resolve the on-disk root for a given checkpoint. Callers may pass
 * `repoDir` to place the checkpoint outside `process.cwd()` (useful in tests).
 */
export function resolveCheckpointRoot(
  sessionId: string,
  decisionId: string,
  repoDir?: string,
): string {
  const safe = `${sessionId}--${decisionId}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(repoDir ?? process.cwd(), '.wavemill', 'replay-checkpoints', safe);
}

/**
 * Create a self-contained checkpoint directory for a hermetic decision point.
 *
 * Refuses (`CheckpointRefusedError('HERMETICITY_VIOLATION', ...)`) if any of
 * the checked-in hermeticity invariants fails. The caller may not opt into a
 * non-hermetic checkpoint here — that would defeat the point of the packet's
 * constraint.
 */
export function createCheckpoint(
  input: CreateCheckpointInput,
  options?: { repoDir?: string; overwrite?: boolean },
): CheckpointHandle {
  if (!input.sessionId || !input.decisionId) {
    throw new CheckpointRefusedError('INVALID_INPUT', 'sessionId and decisionId are required');
  }
  if (!input.toolMenu?.toolNames?.length) {
    throw new CheckpointRefusedError('INVALID_INPUT', 'toolMenu.toolNames must be non-empty');
  }
  if (!input.toolMenu.toolNames.includes(input.toolMenu.chosenTool)) {
    throw new CheckpointRefusedError(
      'INVALID_INPUT',
      `chosenTool ${input.toolMenu.chosenTool} is not in the menu`,
    );
  }
  if (!input.runtimeEnv?.modelId) {
    throw new CheckpointRefusedError('INVALID_INPUT', 'runtimeEnv.modelId is required');
  }

  const root = resolveCheckpointRoot(input.sessionId, input.decisionId, options?.repoDir);
  if (existsSync(root) && !options?.overwrite) {
    throw new CheckpointRefusedError('ALREADY_EXISTS', root);
  }

  const hermeticityChecks = assertHermetic(input);

  ensureDir(root);
  ensureDir(join(root, 'working-tree'));
  ensureDir(join(root, 'tool-results'));

  const redactedEvents = input.events.map((event) => {
    const redacted = redactPayload(event.payload);
    return {
      ...event,
      payload: redacted.value,
      _redaction: {
        matchCount: redacted.matchCount,
        categories: redacted.categories,
      },
    };
  });

  const eventStreamLines = redactedEvents.map((event) => JSON.stringify(event)).join('\n') + (redactedEvents.length ? '\n' : '');
  const eventStreamPath = join(root, 'event-stream.jsonl');
  writeFileSafe(eventStreamPath, eventStreamLines);

  const workingFileHashes: Record<string, string> = {};
  for (const file of input.workingFiles) {
    const normalized = normalizeRelPath(file.path);
    const redacted = redactSecrets(file.content);
    workingFileHashes[normalized] = sha256Hex(redacted.text);
    writeFileSafe(join(root, 'working-tree', normalized), redacted.text);
  }

  const toolResultHashes: Record<string, string> = {};
  for (const tr of input.toolResults) {
    const redacted = redactSecrets(tr.content);
    const contentHash = sha256Hex(redacted.text);
    toolResultHashes[tr.callId] = contentHash;
    const envelope = {
      callId: tr.callId,
      tool: tr.tool,
      category: tr.category,
      contentHash,
      content: redacted.text,
    };
    writeFileSafe(join(root, 'tool-results', `${tr.callId}.json`), JSON.stringify(envelope, null, 2));
  }

  const whitelistEnvRaw = input.runtimeEnv.whitelistEnv ?? {};
  const whitelistEnv: Record<string, string> = {};
  const envRedactionStats = { matchCount: 0, categories: new Set<string>() };
  for (const [k, v] of Object.entries(whitelistEnvRaw)) {
    const r = redactSecrets(v);
    envRedactionStats.matchCount += r.matchCount;
    for (const c of r.categories) envRedactionStats.categories.add(c);
    whitelistEnv[k] = r.text;
  }
  writeFileSafe(
    join(root, 'runtime-env.json'),
    JSON.stringify(
      {
        whitelistEnv,
        network_access: !!input.runtimeEnv.network_access,
        modelId: input.runtimeEnv.modelId,
      },
      null,
      2,
    ),
  );

  writeFileSafe(
    join(root, 'git-state.txt'),
    [
      `HEAD ${input.gitState.headSha}`,
      `dirty ${input.gitState.dirty ? '1' : '0'}`,
      input.gitState.submodulePinDigest ? `submodule ${input.gitState.submodulePinDigest}` : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );

  const now = (input.now ?? (() => new Date()))();
  const eventRedactionAggregate = redactedEvents.reduce(
    (acc, event) => {
      acc.matchCount += event._redaction.matchCount;
      for (const c of event._redaction.categories) acc.categories.add(c);
      return acc;
    },
    { matchCount: envRedactionStats.matchCount, categories: envRedactionStats.categories },
  );

  const manifestSansHash: Omit<CheckpointManifest, 'checkpointHash'> = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    decisionId: input.decisionId,
    phase: input.phase,
    createdAt: now.toISOString(),
    modelId: input.runtimeEnv.modelId,
    chosenTool: input.toolMenu.chosenTool,
    toolMenu: [...input.toolMenu.toolNames],
    gitState: { ...input.gitState },
    entropy: { ...input.entropy, uuidSequence: [...(input.entropy.uuidSequence ?? [])] },
    runtimeEnv: {
      whitelistEnv,
      network_access: false,
      modelId: input.runtimeEnv.modelId,
    },
    hermeticityAttestation: {
      checks: hermeticityChecks,
      labels: [...(input.taskLabels ?? [])],
    },
    redactionAttestation: {
      categories: [...eventRedactionAggregate.categories],
      matchCount: eventRedactionAggregate.matchCount,
    },
    workingFileHashes,
    toolResultHashes,
    eventCount: input.events.length,
  };

  const checkpointHash = sha256Hex(stableStringify(manifestSansHash));
  const manifest: CheckpointManifest = { ...manifestSansHash, checkpointHash };

  writeFileSafe(join(root, 'checkpoint.json'), JSON.stringify(manifest, null, 2));

  return { root, manifest };
}

/**
 * Load and structurally verify a previously written checkpoint.
 *
 * Throws {@link CheckpointRefusedError} with reason `INVALID_INPUT` when the
 * manifest is missing, unreadable, or fails its own recorded
 * `checkpointHash`.
 */
export function loadCheckpoint(root: string): CheckpointHandle {
  const manifestPath = join(root, 'checkpoint.json');
  if (!existsSync(manifestPath)) {
    throw new CheckpointRefusedError('INVALID_INPUT', `checkpoint.json missing at ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, 'utf-8');
  let manifest: CheckpointManifest;
  try {
    manifest = JSON.parse(raw) as CheckpointManifest;
  } catch (err) {
    throw new CheckpointRefusedError('INVALID_INPUT', `checkpoint.json is not valid JSON: ${(err as Error).message}`);
  }

  const { checkpointHash, ...rest } = manifest;
  const observed = sha256Hex(stableStringify(rest));
  if (observed !== checkpointHash) {
    throw new CheckpointRefusedError(
      'INVALID_INPUT',
      `checkpointHash mismatch: expected ${checkpointHash}, observed ${observed}`,
    );
  }

  return { root, manifest };
}

/** Verify a checkpoint's manifest hash without loading tool-result bodies. */
export function verifyCheckpointIntegrity(root: string): boolean {
  try {
    loadCheckpoint(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the on-disk content of a working-tree file recorded in the
 * checkpoint. Used by the deterministic replay path to compute file hashes.
 */
export function readCheckpointWorkingFile(root: string, relPath: string): string | null {
  const abs = join(root, 'working-tree', normalizeRelPath(relPath));
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf-8');
}

/**
 * Return the redacted tool-result envelope for a given call id.
 */
export function readCheckpointToolResult(
  root: string,
  callId: string,
): { callId: string; tool: string; category?: string; contentHash: string; content: string } | null {
  const abs = join(root, 'tool-results', `${callId}.json`);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, 'utf-8'));
}

/**
 * Return the redacted event stream in order.
 */
export function readCheckpointEventStream(root: string): Array<Record<string, unknown>> {
  const abs = join(root, 'event-stream.jsonl');
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, 'utf-8').split('\n').filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
