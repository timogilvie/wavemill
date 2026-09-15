/**
 * Session adapters — agent-specific session parsing for workflow cost
 * and intervention detection.
 *
 * Each adapter knows how to discover session files for a given
 * worktree/branch and extract aggregated token usage in a common format.
 * Adding a new agent means implementing SessionAdapter and registering
 * it in getSessionAdapter().
 *
 * @module session-adapters
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readJsonlFile } from './jsonl-utils.ts';
import { piUsageToSessionModelUsage } from './native-agent/pi-usage-cost.ts';
import type { TranscriptEvent } from './native-agent/transcript.ts';
import { resolveProjectsDirs } from './workflow-cost.ts';

const CODEX_SESSION_META_READ_BYTES = 64 * 1024;

interface CodexSessionMetaCacheEntry {
  size: number;
  mtimeMs: number;
  isSessionMeta: boolean;
  cwd?: string;
  branch?: string;
}

// ────────────────────────────────────────────────────────────────
// Common types
// ────────────────────────────────────────────────────────────────

/** Supported agent identifiers. */
export type AgentType = 'claude' | 'codex' | 'claude-deepseek' | 'native';

/** Per-model aggregated token usage (without cost — cost is computed later). */
export interface SessionModelUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface NativeSessionUsageRecord {
  sessionId: string;
  filePath: string;
  provider: string;
  modelId: string;
  turnCount: number;
  responseIds: string[];
  turns: Array<{
    responseId?: string;
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    providerReportedCostUsd?: number;
    usageAvailable: boolean;
    invalidUsage: boolean;
  }>;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerReportedCostUsd?: number;
  usageAvailable: boolean;
  invalidUsage: boolean;
}

/**
 * Per-turn token usage for external harness sessions (HOK-2958).
 *
 * Unlike {@link SessionModelUsage}, an unavailable dimension is `null`,
 * never coerced to `0` — downstream economics records must be able to
 * distinguish "not reported" from a genuine zero.
 */
export interface ExternalTurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** thinking_tokens (Claude Code) / reasoning_output_tokens (Codex). */
  reasoningTokens: number | null;
}

/** One observed turn in an external harness session (HOK-2958). */
export interface ExternalSessionTurn {
  /** Claude Code `uuid` / Codex `turn_id`; null when the source lacks it. */
  turnId: string | null;
  /** Claude Code `parentUuid` / Codex `root_turn_id`. */
  parentId: string | null;
  /** Claude Code `isSidechain`; null when the source has no lineage flag. */
  isSubagent: boolean | null;
  model: string | null;
  timestamp: string | null;
  usage: ExternalTurnUsage;
  usageAvailable: boolean;
  /** Provider-reported cost; absent in current harness versions → null. */
  actualCostUsd: number | null;
}

/**
 * Normalized per-session detail for external (Claude Code / Codex) sessions.
 *
 * Parallel to {@link NativeSessionUsageRecord}: populated alongside the
 * unchanged `models` aggregate so existing callers are unaffected. Only
 * allowlisted fields are ever copied from raw session entries — `cwd`,
 * file paths, `repository_url`, rate limits, and any `user.*` /
 * `organization.*` / account identity attributes are dropped by
 * construction (HOK-2958 privacy requirement).
 */
export interface ExternalSessionUsageRecord {
  /** Pseudonymous source session UUID. */
  sessionId: string;
  harness: 'claude-code' | 'codex';
  /** Observed harness version (`version` entry field / `cli_version`). */
  harnessVersion: string | null;
  /** Trigger evidence: `promptSource` (Claude Code) / `originator` (Codex). */
  triggerSource: string | null;
  /** Source-field provenance for `triggerSource`. */
  triggerProvenance: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Real turns observed in the source. */
  turnCount: number;
  turns: ExternalSessionTurn[];
  /** Session-level usage totals (null dimensions were never reported). */
  usage: ExternalTurnUsage;
  /** Provider-reported session cost; null when the source reports none. */
  actualCostUsd: number | null;
  /** Missing-field / source-version notes; never a parse failure. */
  diagnostics: string[];
}

/** Result of scanning sessions for a given agent. */
export interface SessionUsageResult {
  /** Per-model token usage breakdown. */
  models: Record<string, SessionModelUsage>;
  /** Number of session files that contributed data. */
  sessionCount: number;
  /** Number of assistant turns counted (or 1 per session for agents with cumulative totals). */
  turnCount: number;
  /** Agent-specific source identifier for native attribution. */
  source?: AgentType;
  /** Native per-session usage details. Present only for native transcript scans. */
  nativeSessions?: NativeSessionUsageRecord[];
  /** External per-session detail. Present only for Claude/Codex scans (HOK-2958). */
  externalSessions?: ExternalSessionUsageRecord[];
}

/** Options for scanning sessions. */
export interface SessionScanOptions {
  worktreePath: string;
  branchName: string;
  /**
   * Main repository directory. Native transcripts are written under the *repo*
   * (`makeTranscriptPath` uses `repoDir`), not the task worktree, so scanning
   * only `worktreePath` finds nothing for any mill task and the run's cost is
   * silently reported as unavailable.
   */
  repoDir?: string;
  /**
   * Issue being evaluated. Native transcripts for every task share one
   * directory (`<repo>/.wavemill/runs/<session>/native-sessions/`), so without
   * this every task's usage is summed into whichever task is being costed.
   */
  issueId?: string;
  /** Test/backfill override for Claude project directories. */
  claudeProjectsDirs?: string[];
  /** Test/backfill override for the Codex sessions root. */
  codexSessionsRoot?: string;
}

/** A session adapter knows how to scan an agent's session files. */
export interface SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null;
}

// ────────────────────────────────────────────────────────────────
// External session helpers (HOK-2958)
// ────────────────────────────────────────────────────────────────

function finiteNonNegativeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function emptyExternalUsage(): ExternalTurnUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

/** Add an observed value into a null-preserving total (null + n → n). */
function addObserved(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function sumExternalUsage(total: ExternalTurnUsage, turn: ExternalTurnUsage): void {
  total.inputTokens = addObserved(total.inputTokens, turn.inputTokens);
  total.outputTokens = addObserved(total.outputTokens, turn.outputTokens);
  total.cacheReadTokens = addObserved(total.cacheReadTokens, turn.cacheReadTokens);
  total.cacheWriteTokens = addObserved(total.cacheWriteTokens, turn.cacheWriteTokens);
  total.reasoningTokens = addObserved(total.reasoningTokens, turn.reasoningTokens);
}

/** Derive a pseudonymous session ID from a session file name (UUID basename). */
function sessionIdFromFileName(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return base.replace(/\.jsonl$/, '');
}

// ────────────────────────────────────────────────────────────────
// Claude adapter
// ────────────────────────────────────────────────────────────────

/**
 * Reads Claude Code session files from ~/.claude/projects/<encoded-path>/ and
 * any Wavemill-managed DeepSeek provider homes under .wavemill/runs/*.
 * Filters by type === 'assistant' and gitBranch, aggregates per-turn
 * message.usage token counts per model.
 */
export class ClaudeSessionAdapter implements SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
    const projectsDirs = opts.claudeProjectsDirs ?? resolveProjectsDirs(opts.worktreePath);

    if (debug) {
      console.log(`[DEBUG_COST] ClaudeSessionAdapter.scan:`);
      console.log(`[DEBUG_COST]   worktreePath: ${opts.worktreePath}`);
      console.log(`[DEBUG_COST]   branchName: ${opts.branchName}`);
      console.log(`[DEBUG_COST]   projectsDirs: ${projectsDirs.join(', ')}`);
    }

    const existingProjectsDirs = projectsDirs.filter((projectsDir) => existsSync(projectsDir));

    if (existingProjectsDirs.length === 0) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ Projects directories do not exist`);
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   ✓ Found ${existingProjectsDirs.length} projects director${existingProjectsDirs.length === 1 ? 'y' : 'ies'}`);
    }

    let sessionFiles: string[];
    try {
      sessionFiles = existingProjectsDirs.flatMap((projectsDir) =>
        readdirSync(projectsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => join(projectsDir, f))
      );
    } catch (err) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ Failed to read directory: ${err}`);
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   Found ${sessionFiles.length} .jsonl file(s)`);
    }

    if (sessionFiles.length === 0) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ No session files found`);
      }
      return null;
    }

    const models: Record<string, SessionModelUsage> = {};
    let turnCount = 0;
    let sessionCount = 0;
    let totalAssistantTurns = 0;
    let branchMismatchCount = 0;
    const externalSessions: ExternalSessionUsageRecord[] = [];

    for (const filePath of sessionFiles) {
      let sessionHadTurns = false;
      let sessionId: string | null = null;
      let harnessVersion: string | null = null;
      let triggerSource: string | null = null;
      const sessionTurns: ExternalSessionTurn[] = [];
      const sessionUsage = emptyExternalUsage();
      let sessionActualCost: number | null = null;
      const missingFieldCounts = new Map<string, number>();

      try {
        for (const entry of readJsonlFile<Record<string, unknown>>(filePath)) {
          sessionId ??= stringOrNull(entry.sessionId);
          harnessVersion ??= stringOrNull(entry.version);

          // Session-level trigger: the first typed/sdk user prompt on this
          // branch (sidechain user entries are subagent-internal, not triggers).
          if (
            entry.type === 'user'
            && triggerSource === null
            && entry.isSidechain !== true
            && entry.gitBranch === opts.branchName
          ) {
            triggerSource = stringOrNull(entry.promptSource);
          }

          if (entry.type !== 'assistant') continue;
          totalAssistantTurns++;

          if (entry.gitBranch !== opts.branchName) {
            branchMismatchCount++;
            continue;
          }

          const message = entry.message as Record<string, unknown> | undefined;
          if (!message) continue;

          const usage = message.usage as Record<string, unknown> | undefined;
          if (!usage) continue;

          const modelId = (message.model as string) || 'unknown';
          const inputTokens = (usage.input_tokens as number) || 0;
          const cacheCreationTokens = (usage.cache_creation_input_tokens as number) || 0;
          const cacheReadTokens = (usage.cache_read_input_tokens as number) || 0;
          const outputTokens = (usage.output_tokens as number) || 0;

          if (!models[modelId]) {
            models[modelId] = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
          }

          models[modelId].inputTokens += inputTokens;
          models[modelId].cacheCreationTokens += cacheCreationTokens;
          models[modelId].cacheReadTokens += cacheReadTokens;
          models[modelId].outputTokens += outputTokens;

          turnCount++;
          sessionHadTurns = true;

          // Normalized per-turn detail (allowlisted fields only; unavailable
          // dimensions stay null instead of collapsing into 0).
          const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
          const turnUsage: ExternalTurnUsage = {
            inputTokens: finiteNonNegativeOrNull(usage.input_tokens),
            outputTokens: finiteNonNegativeOrNull(usage.output_tokens),
            cacheReadTokens: finiteNonNegativeOrNull(usage.cache_read_input_tokens),
            cacheWriteTokens: finiteNonNegativeOrNull(usage.cache_creation_input_tokens),
            reasoningTokens: finiteNonNegativeOrNull(outputDetails?.thinking_tokens),
          };
          const turn: ExternalSessionTurn = {
            turnId: stringOrNull(entry.uuid),
            parentId: stringOrNull(entry.parentUuid),
            isSubagent: typeof entry.isSidechain === 'boolean' ? entry.isSidechain : null,
            model: stringOrNull(message.model),
            timestamp: stringOrNull(entry.timestamp),
            usage: turnUsage,
            usageAvailable: turnUsage.inputTokens !== null || turnUsage.outputTokens !== null,
            actualCostUsd: finiteNonNegativeOrNull(entry.costUSD),
          };
          for (const [field, value] of [
            ['uuid', turn.turnId],
            ['isSidechain', turn.isSubagent],
            ['thinking_tokens', turnUsage.reasoningTokens],
          ] as const) {
            if (value === null) {
              missingFieldCounts.set(field, (missingFieldCounts.get(field) ?? 0) + 1);
            }
          }
          sumExternalUsage(sessionUsage, turnUsage);
          sessionActualCost = addObserved(sessionActualCost, turn.actualCostUsd);
          sessionTurns.push(turn);
        }
      } catch {
        continue;
      }

      if (sessionHadTurns) {
        sessionCount++;
        const diagnostics = [...missingFieldCounts.entries()].map(
          ([field, count]) => `${count}/${sessionTurns.length} turn(s) missing ${field}`,
        );
        externalSessions.push({
          sessionId: sessionId ?? sessionIdFromFileName(filePath),
          harness: 'claude-code',
          harnessVersion,
          triggerSource,
          triggerProvenance: triggerSource !== null ? 'claude_code.promptSource' : null,
          startedAt: sessionTurns[0]?.timestamp ?? null,
          endedAt: sessionTurns[sessionTurns.length - 1]?.timestamp ?? null,
          turnCount: sessionTurns.length,
          turns: sessionTurns,
          usage: sessionUsage,
          actualCostUsd: sessionActualCost,
          diagnostics,
        });
      }
    }

    if (debug) {
      console.log(`[DEBUG_COST]   Total assistant turns found: ${totalAssistantTurns}`);
      console.log(`[DEBUG_COST]   Branch mismatches: ${branchMismatchCount}`);
      console.log(`[DEBUG_COST]   Matching turns: ${turnCount}`);
    }

    if (turnCount === 0) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ No turns matched branch '${opts.branchName}'`);
        if (totalAssistantTurns > 0) {
          console.log(`[DEBUG_COST]   Hint: Found ${totalAssistantTurns} assistant turns but none matched the branch`);
        }
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   ✓ Successfully scanned ${sessionCount} session(s) with ${turnCount} turn(s)`);
    }

    return { models, sessionCount, turnCount, source: 'claude', externalSessions };
  }
}

// ────────────────────────────────────────────────────────────────
// Codex adapter
// ────────────────────────────────────────────────────────────────

/**
 * Reads Codex session files from ~/.codex/sessions/YYYY/MM/DD/.
 *
 * Codex sessions are organized by date, not by project. Discovery
 * reads only the first line (session_meta) of each file to match
 * by cwd or branch before fully parsing.
 *
 * Token usage is cumulative — the last token_count event has the
 * session total. Model ID comes from turn_context entries.
 */
export class CodexSessionAdapter implements SessionAdapter {
  private static readonly sessionMetaCache = new Map<string, Map<string, CodexSessionMetaCacheEntry>>();

  scan(opts: SessionScanOptions): SessionUsageResult | null {
    const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
    const sessionsRoot = opts.codexSessionsRoot ?? join(homedir(), '.codex', 'sessions');

    if (debug) {
      console.log(`[DEBUG_COST] CodexSessionAdapter.scan:`);
      console.log(`[DEBUG_COST]   worktreePath: ${opts.worktreePath}`);
      console.log(`[DEBUG_COST]   branchName: ${opts.branchName}`);
      console.log(`[DEBUG_COST]   sessionsRoot: ${sessionsRoot}`);
    }

    if (!existsSync(sessionsRoot)) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ Sessions root does not exist`);
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   ✓ Sessions root exists`);
    }

    const matchingFiles = this.discoverMatchingFiles(sessionsRoot, opts, debug);

    if (debug) {
      console.log(`[DEBUG_COST]   Found ${matchingFiles.length} matching session file(s)`);
    }

    if (matchingFiles.length === 0) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ No session files matched worktree or branch`);
      }
      return null;
    }

    const models: Record<string, SessionModelUsage> = {};
    let sessionCount = 0;
    let turnCount = 0;
    const externalSessions: ExternalSessionUsageRecord[] = [];

    for (const filePath of matchingFiles) {
      const result = this.parseSessionFile(filePath);
      if (!result) continue;

      const { modelId, usage } = result;
      if (!models[modelId]) {
        models[modelId] = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
      }

      models[modelId].inputTokens += usage.inputTokens;
      models[modelId].cacheCreationTokens += usage.cacheCreationTokens;
      models[modelId].cacheReadTokens += usage.cacheReadTokens;
      models[modelId].outputTokens += usage.outputTokens;

      sessionCount++;
      turnCount++;
      externalSessions.push(result.external);
    }

    if (sessionCount === 0) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ No sessions could be parsed`);
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   ✓ Successfully scanned ${sessionCount} session(s)`);
    }

    return { models, sessionCount, turnCount, source: 'codex', externalSessions };
  }

  /**
   * Recursively find .jsonl files whose session_meta matches
   * the target worktree cwd or branch.
   */
  private discoverMatchingFiles(sessionsRoot: string, opts: SessionScanOptions, debug = false): string[] {
    const matching: string[] = [];
    const resolvedWorktree = resolve(opts.worktreePath);
    let rootCache = CodexSessionAdapter.sessionMetaCache.get(sessionsRoot);
    if (!rootCache) {
      rootCache = new Map();
      CodexSessionAdapter.sessionMetaCache.set(sessionsRoot, rootCache);
    }
    const seenFiles = new Set<string>();

    if (debug) {
      console.log(`[DEBUG_COST]   Scanning for session files matching worktree or branch...`);
    }

    this.walkJsonlFiles(sessionsRoot, (filePath) => {
      seenFiles.add(filePath);
      try {
        const stat = statSync(filePath);
        let meta = rootCache.get(filePath);
        if (!meta || meta.size !== stat.size || meta.mtimeMs !== stat.mtimeMs) {
          meta = readCodexSessionMeta(filePath, stat.size, stat.mtimeMs);
          rootCache.set(filePath, meta);
        }

        if (!meta.isSessionMeta) return;

        const cwdMatches = meta.cwd && resolve(meta.cwd) === resolvedWorktree;
        const branchMatches = meta.branch === opts.branchName;

        if (cwdMatches || branchMatches) {
          matching.push(filePath);
        }
      } catch {
        // Skip unreadable files
      }
    });

    for (const filePath of rootCache.keys()) {
      if (!seenFiles.has(filePath)) {
        rootCache.delete(filePath);
      }
    }

    return matching;
  }

  /** Recursively find all .jsonl files under a directory. */
  private walkJsonlFiles(dir: string, callback: (path: string) => void): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkJsonlFiles(fullPath, callback);
        } else if (entry.name.endsWith('.jsonl')) {
          callback(fullPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  /**
   * Parse a single Codex session file.
   *
   * Extracts the model from turn_context and the cumulative token
   * usage from the last token_count event.
   *
   * Field mapping:
   * - input_tokens → inputTokens
   * - cached_input_tokens → cacheReadTokens
   * - cacheCreationTokens = 0 (Codex doesn't separate cache writes)
   * - output_tokens + reasoning_output_tokens → outputTokens
   */
  private parseSessionFile(
    filePath: string,
  ): { modelId: string; usage: SessionModelUsage; external: ExternalSessionUsageRecord } | null {
    try {
      let modelId = 'unknown';
      let lastTokenUsage: Record<string, number> | null = null;

      let sessionId: string | null = null;
      let harnessVersion: string | null = null;
      let triggerSource: string | null = null;
      let triggerProvenance: string | null = null;
      let startedAt: string | null = null;
      let endedAt: string | null = null;
      const turns: ExternalSessionTurn[] = [];
      let currentTurn: ExternalSessionTurn | null = null;
      const diagnostics: string[] = [];

      for (const entry of readJsonlFile<Record<string, unknown>>(filePath)) {
        endedAt = stringOrNull(entry.timestamp) ?? endedAt;

        // Allowlist copy from session_meta: identity/version/trigger only.
        // cwd, git.*, repository_url, rate limits, and any user/organization
        // attributes are intentionally never captured (HOK-2958 privacy).
        if (entry.type === 'session_meta') {
          const payload = entry.payload as Record<string, unknown> | undefined;
          sessionId ??= stringOrNull(payload?.id) ?? stringOrNull(payload?.session_id);
          harnessVersion ??= stringOrNull(payload?.cli_version);
          startedAt ??= stringOrNull(payload?.timestamp) ?? stringOrNull(entry.timestamp);
          const originator = stringOrNull(payload?.originator);
          const source = stringOrNull(payload?.source);
          if (originator) {
            triggerSource = originator;
            triggerProvenance = 'codex.session_meta.originator';
          } else if (source) {
            triggerSource = source;
            triggerProvenance = 'codex.session_meta.source';
          }
        }

        // Extract model from turn_context entries
        if (entry.type === 'turn_context') {
          const payload = entry.payload as Record<string, unknown> | undefined;
          if (payload?.model) {
            modelId = payload.model as string;
          }
          currentTurn = {
            turnId: stringOrNull(payload?.turn_id),
            parentId: stringOrNull(payload?.root_turn_id),
            isSubagent: null,
            model: stringOrNull(payload?.model),
            timestamp: stringOrNull(entry.timestamp),
            usage: emptyExternalUsage(),
            usageAvailable: false,
            actualCostUsd: null,
          };
          turns.push(currentTurn);
        }

        // Track the last token_count entry (cumulative total)
        if (entry.type === 'event_msg') {
          const payload = entry.payload as Record<string, unknown> | undefined;
          if (payload?.type === 'token_count') {
            const info = payload.info as Record<string, unknown> | undefined;
            const usage = info?.total_token_usage as Record<string, number> | undefined;
            if (usage) {
              lastTokenUsage = usage;
            }

            // Per-event delta feeds per-turn usage (older files lack it).
            const delta = info?.last_token_usage as Record<string, unknown> | undefined;
            if (delta) {
              if (!currentTurn) {
                // Usage observed before any turn_context: keep it, without
                // a turn identity, rather than dropping the tokens.
                currentTurn = {
                  turnId: null,
                  parentId: null,
                  isSubagent: null,
                  model: stringOrNull(modelId === 'unknown' ? null : modelId),
                  timestamp: stringOrNull(entry.timestamp),
                  usage: emptyExternalUsage(),
                  usageAvailable: false,
                  actualCostUsd: null,
                };
                turns.push(currentTurn);
              }
              const deltaUsage: ExternalTurnUsage = {
                inputTokens: finiteNonNegativeOrNull(delta.input_tokens),
                outputTokens: finiteNonNegativeOrNull(delta.output_tokens),
                cacheReadTokens: finiteNonNegativeOrNull(delta.cached_input_tokens),
                cacheWriteTokens: finiteNonNegativeOrNull(delta.cache_write_input_tokens),
                reasoningTokens: finiteNonNegativeOrNull(delta.reasoning_output_tokens),
              };
              sumExternalUsage(currentTurn.usage, deltaUsage);
              currentTurn.usageAvailable =
                currentTurn.usage.inputTokens !== null || currentTurn.usage.outputTokens !== null;
            }
          }
        }
      }

      if (!lastTokenUsage) return null;

      const sessionUsage: ExternalTurnUsage = {
        inputTokens: finiteNonNegativeOrNull(lastTokenUsage.input_tokens),
        outputTokens: finiteNonNegativeOrNull(lastTokenUsage.output_tokens),
        cacheReadTokens: finiteNonNegativeOrNull(lastTokenUsage.cached_input_tokens),
        cacheWriteTokens: finiteNonNegativeOrNull(lastTokenUsage.cache_write_input_tokens),
        reasoningTokens: finiteNonNegativeOrNull(lastTokenUsage.reasoning_output_tokens),
      };

      if (sessionId === null) {
        diagnostics.push('session_meta missing session id; using file-derived pseudonymous id');
      }
      if (turns.length === 0) {
        diagnostics.push('per-turn usage unavailable; only cumulative totals present');
      } else if (turns.every((turn) => !turn.usageAvailable)) {
        diagnostics.push('turn contexts present but last_token_usage unavailable');
      } else {
        // Cross-check per-turn deltas against the cumulative total; when they
        // disagree the session totals stay authoritative (HOK-2958 risk note).
        const summedOutput = turns.reduce((sum, turn) => sum + (turn.usage.outputTokens ?? 0), 0);
        if (sessionUsage.outputTokens !== null && summedOutput > sessionUsage.outputTokens) {
          diagnostics.push('per-turn usage deltas exceed cumulative session total; session totals are authoritative');
        }
      }

      return {
        modelId,
        usage: {
          inputTokens: lastTokenUsage.input_tokens || 0,
          cacheCreationTokens: 0,
          cacheReadTokens: lastTokenUsage.cached_input_tokens || 0,
          outputTokens:
            (lastTokenUsage.output_tokens || 0) +
            (lastTokenUsage.reasoning_output_tokens || 0),
        },
        external: {
          sessionId: sessionId ?? sessionIdFromFileName(filePath),
          harness: 'codex',
          harnessVersion,
          triggerSource,
          triggerProvenance,
          startedAt,
          endedAt,
          turnCount: turns.length,
          turns,
          usage: sessionUsage,
          actualCostUsd: null,
          diagnostics,
        },
      };
    } catch {
      return null;
    }
  }
}

function readCodexSessionMeta(filePath: string, size: number, mtimeMs: number): CodexSessionMetaCacheEntry {
  const emptyEntry = { size, mtimeMs, isSessionMeta: false };
  try {
    const firstLine = readFirstLineBounded(filePath, CODEX_SESSION_META_READ_BYTES);
    if (firstLine === null || !firstLine.trim()) {
      return emptyEntry;
    }

    const meta = JSON.parse(firstLine);
    if (meta.type !== 'session_meta') {
      return emptyEntry;
    }

    return {
      size,
      mtimeMs,
      isSessionMeta: true,
      cwd: typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : undefined,
      branch: typeof meta.payload?.git?.branch === 'string' ? meta.payload.git.branch : undefined,
    };
  } catch {
    return emptyEntry;
  }
}

function readFirstLineBounded(filePath: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    if (bytesRead === 0) {
      return null;
    }

    const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newlineIndex >= 0) {
      return buffer.toString('utf8', 0, newlineIndex);
    }

    if (bytesRead < maxBytes) {
      return buffer.toString('utf8', 0, bytesRead);
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures; discovery treats the file as best-effort.
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Native adapter
// ────────────────────────────────────────────────────────────────

/**
 * Reads native runtime transcript files from worktree-local run directories.
 *
 * Native transcripts are worktree-scoped, so branchName is not currently used
 * for discovery. Assistant message usage is aggregated per model, preferring
 * the event's model and falling back to the session_started model when needed.
 */
/**
 * Whether a native transcript belongs to the task being costed.
 *
 * Transcripts for every task share one directory, so without this each task's
 * cost absorbs every other task's tokens. Naming is not uniform across stages:
 * coding and planning use `<stage>-<ISSUE>.jsonl`, review uses
 * `<session>-review-<branch>.jsonl`, and expansion uses
 * `expansion-<sessionId>.jsonl` with no task identity at all.
 *
 * So this excludes transcripts that demonstrably belong to a *different* task
 * rather than including only those that match a single naming convention —
 * filtering on the issue alone would silently drop the whole review phase from
 * a native run's cost. Unattributable files are kept, matching the previous
 * repo-wide behaviour.
 */
export function matchesIssue(fileName: string, issueId?: string, branchName?: string): boolean {
  if (!issueId && !branchName) return true;
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '-');
  const base = fileName.replace(/\.jsonl$/, '');

  if (issueId && base.endsWith(`-${sanitize(issueId)}`)) return true;
  if (branchName && base.endsWith(`-${sanitize(branchName)}`)) return true;

  // Names another issue (`coding-HOK-537_c`) — belongs to a different task.
  if (issueId && /-[A-Za-z]+-\d+(_c)?$/.test(base)) return false;
  // Names another branch (`gtm-backend-review-task-some-other-slug`).
  if (branchName && /-(task|feature|bug|bugfix)-/.test(base)) return false;

  return true;
}

export class NativeSessionAdapter implements SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    // Check the repo root as well as the worktree: mill tasks run in a
    // worktree but their transcripts are written under the main repo.
    const runsDirs = [
      join(resolve(opts.worktreePath), '.wavemill', 'runs'),
      ...(opts.repoDir ? [join(resolve(opts.repoDir), '.wavemill', 'runs')] : []),
    ].filter((dir, index, all) => all.indexOf(dir) === index && existsSync(dir));

    if (runsDirs.length === 0) {
      return null;
    }

    let sessionFiles: string[] = [];
    try {
      for (const runsDir of runsDirs) {
        for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
          if (!runEntry.isDirectory()) {
            continue;
          }
          const nativeSessionsDir = join(runsDir, runEntry.name, 'native-sessions');
          if (!existsSync(nativeSessionsDir)) {
            continue;
          }
          sessionFiles.push(
            ...readdirSync(nativeSessionsDir)
              .filter((fileName) => fileName.endsWith('.jsonl'))
              .filter((fileName) => matchesIssue(fileName, opts.issueId, opts.branchName))
              .map((fileName) => join(nativeSessionsDir, fileName)),
          );
        }
      }
    } catch {
      return null;
    }

    if (sessionFiles.length === 0) {
      return null;
    }

    sessionFiles = [...new Set(sessionFiles)];

    const models: Record<string, SessionModelUsage> = {};
    let sessionCount = 0;
    let turnCount = 0;
    const nativeSessions: NativeSessionUsageRecord[] = [];
    const seenSessionIds = new Set<string>();

    for (const filePath of sessionFiles) {
      let sessionId = '';
      let sessionModel = 'unknown';
      let sessionProvider = 'unknown';
      let sessionHadTurns = false;
      let sessionTurnCount = 0;
      const sessionModels = new Map<string, NativeSessionUsageRecord>();
      const sessionModelUsage: Record<string, SessionModelUsage> = {};

      try {
        for (const entry of readJsonlFile<TranscriptEvent>(filePath)) {
          sessionId ||= entry.sessionId || filePath;
          if (entry.type === 'session_started') {
            sessionModel = entry.model || sessionModel;
            sessionProvider = entry.provider || sessionProvider;
            continue;
          }

          if (entry.type !== 'assistant_message') {
            continue;
          }

          const modelId = entry.model || sessionModel || 'unknown';
          const key = `${sessionProvider}\0${modelId}`;
          let nativeRecord = sessionModels.get(key);
          if (!nativeRecord) {
            nativeRecord = {
              sessionId: sessionId || entry.sessionId || filePath,
              filePath,
              provider: sessionProvider,
              modelId,
              turnCount: 0,
              responseIds: [],
              turns: [],
              usageAvailable: false,
              invalidUsage: false,
            };
            sessionModels.set(key, nativeRecord);
          }

          nativeRecord.turnCount++;
          const turnRecord: NativeSessionUsageRecord['turns'][number] = {
            ...(entry.responseId ? { responseId: entry.responseId } : {}),
            usageAvailable: false,
            invalidUsage: false,
          };
          if (entry.responseId) {
            nativeRecord.responseIds.push(entry.responseId);
          }
          if (entry.usage?.cost?.total !== undefined) {
            nativeRecord.providerReportedCostUsd =
              (nativeRecord.providerReportedCostUsd ?? 0) + entry.usage.cost.total;
            turnRecord.providerReportedCostUsd = entry.usage.cost.total;
          }

          const usage = piUsageToSessionModelUsage(entry.usage);
          if (!usage) {
            nativeRecord.invalidUsage = nativeRecord.invalidUsage || false;
            nativeRecord.turns.push(turnRecord);
            sessionTurnCount++;
            sessionHadTurns = true;
            continue;
          }

          const tokenValues = [
            usage.inputTokens,
            usage.cacheCreationTokens,
            usage.cacheReadTokens,
            usage.outputTokens,
            entry.usage?.totalTokens ?? 0,
          ];
          const usageValid = tokenValues.every((value) => Number.isFinite(value) && value >= 0);
          if (!usageValid) {
            nativeRecord.invalidUsage = true;
            turnRecord.invalidUsage = true;
            nativeRecord.turns.push(turnRecord);
            sessionTurnCount++;
            sessionHadTurns = true;
            continue;
          }

          nativeRecord.usageAvailable = true;
          turnRecord.usageAvailable = true;
          turnRecord.inputTokens = usage.inputTokens;
          turnRecord.cacheCreationTokens = usage.cacheCreationTokens;
          turnRecord.cacheReadTokens = usage.cacheReadTokens;
          turnRecord.outputTokens = usage.outputTokens;
          turnRecord.totalTokens =
            entry.usage?.totalTokens ?? usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
          nativeRecord.inputTokens = (nativeRecord.inputTokens ?? 0) + usage.inputTokens;
          nativeRecord.cacheCreationTokens = (nativeRecord.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
          nativeRecord.cacheReadTokens = (nativeRecord.cacheReadTokens ?? 0) + usage.cacheReadTokens;
          nativeRecord.outputTokens = (nativeRecord.outputTokens ?? 0) + usage.outputTokens;
          nativeRecord.totalTokens =
            (nativeRecord.totalTokens ?? 0) +
            (entry.usage?.totalTokens ?? usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens);
          nativeRecord.turns.push(turnRecord);

          if (!sessionModelUsage[modelId]) {
            sessionModelUsage[modelId] = {
              inputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
            };
          }

          sessionModelUsage[modelId].inputTokens += usage.inputTokens;
          sessionModelUsage[modelId].cacheCreationTokens += usage.cacheCreationTokens;
          sessionModelUsage[modelId].cacheReadTokens += usage.cacheReadTokens;
          sessionModelUsage[modelId].outputTokens += usage.outputTokens;

          sessionTurnCount++;
          sessionHadTurns = true;
        }
      } catch {
        continue;
      }

      if (sessionHadTurns) {
        const dedupeKey = sessionId || filePath;
        if (seenSessionIds.has(dedupeKey)) {
          continue;
        }
        seenSessionIds.add(dedupeKey);
        sessionCount++;
        turnCount += sessionTurnCount;
        for (const [modelId, usage] of Object.entries(sessionModelUsage)) {
          if (!models[modelId]) {
            models[modelId] = {
              inputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
            };
          }

          models[modelId].inputTokens += usage.inputTokens;
          models[modelId].cacheCreationTokens += usage.cacheCreationTokens;
          models[modelId].cacheReadTokens += usage.cacheReadTokens;
          models[modelId].outputTokens += usage.outputTokens;
        }
        nativeSessions.push(...sessionModels.values());
      }
    }

    if (turnCount === 0) {
      return null;
    }

    return { models, sessionCount, turnCount, source: 'native', nativeSessions };
  }
}

// ────────────────────────────────────────────────────────────────
// Native provider metadata
// ────────────────────────────────────────────────────────────────

/**
 * Extract provider metadata from the latest native session_started event.
 *
 * Returns the provider and optional endpoint (api) from the first
 * session_started event found in any native session file for this worktree.
 *
 * @returns Provider metadata or null if no native sessions exist
 */
export function getNativeProviderMetadata(
  worktreePath: string,
  repoDir?: string,
): { provider: string; endpoint?: string } | null {
  // Same worktree-vs-repo mismatch NativeSessionAdapter.scan has: transcripts
  // are written under the repo, so a worktree-only lookup returns null for
  // every mill task and the eval record loses its provider metadata.
  const runsDirs = [
    join(resolve(worktreePath), '.wavemill', 'runs'),
    ...(repoDir ? [join(resolve(repoDir), '.wavemill', 'runs')] : []),
  ].filter((dir, index, all) => all.indexOf(dir) === index && existsSync(dir));

  if (runsDirs.length === 0) {
    return null;
  }

  try {
    for (const runsDir of runsDirs) {
    for (const runEntry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) {
        continue;
      }
      const nativeSessionsDir = join(runsDir, runEntry.name, 'native-sessions');
      if (!existsSync(nativeSessionsDir)) {
        continue;
      }

      const sessionFiles = readdirSync(nativeSessionsDir)
        .filter((fileName) => fileName.endsWith('.jsonl'))
        .map((fileName) => join(nativeSessionsDir, fileName));

      for (const filePath of sessionFiles) {
        try {
          for (const entry of readJsonlFile<TranscriptEvent>(filePath)) {
            if (entry.type === 'session_started') {
              return {
                provider: entry.provider,
                ...(entry.api ? { endpoint: entry.api } : {}),
              };
            }
          }
        } catch {
          // Skip malformed session files
          continue;
        }
      }
    }
    }
  } catch {
    return null;
  }

  return null;
}

// ────────────────────────────────────────────────────────────────
// Auto-detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect which agent was actually used by checking for session files.
 *
 * This is a fallback mechanism for when the recorded agent type might be
 * incorrect (e.g., due to bugs in agent assignment logic).
 *
 * @returns 'claude' | 'codex' | 'native' | null
 */
export function detectAgentType(opts: SessionScanOptions): AgentType | null {
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  const claudeAdapter = new ClaudeSessionAdapter();
  const codexAdapter = new CodexSessionAdapter();
  const nativeAdapter = new NativeSessionAdapter();

  const claudeResult = claudeAdapter.scan(opts);
  const codexResult = codexAdapter.scan(opts);
  const nativeResult = nativeAdapter.scan(opts);

  // Count how many adapters found sessions
  const results = [
    { type: 'claude' as const, result: claudeResult },
    { type: 'codex' as const, result: codexResult },
    { type: 'native' as const, result: nativeResult },
  ].filter(({ result }) => result !== null);

  if (results.length === 0) {
    if (debug) console.log('[DEBUG_COST] No sessions found for any agent');
    return null;
  }

  if (results.length === 1) {
    const detected = results[0].type;
    if (debug) console.log(`[DEBUG_COST] Auto-detected agent: ${detected}`);
    return detected;
  }

  // Multiple agents have sessions - pick the one with the most turns
  const winner = results.reduce((prev, curr) => {
    const prevTurns = prev.result!.turnCount;
    const currTurns = curr.result!.turnCount;
    return currTurns > prevTurns ? curr : prev;
  });

  if (debug) {
    const winnerTurns = winner.result!.turnCount;
    const others = results
      .filter(({ type }) => type !== winner.type)
      .map(({ type, result }) => `${type}=${result!.turnCount}`)
      .join(', ');
    console.log(
      `[DEBUG_COST] Multiple agents have sessions - choosing ${winner.type} ` +
      `(${winnerTurns} turns vs ${others})`
    );
  }

  return winner.type;
}

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/**
 * Get the appropriate session adapter for the given agent type.
 * Defaults to Claude adapter for backwards compatibility.
 */
export function getSessionAdapter(agentType?: AgentType | string): SessionAdapter {
  switch (agentType) {
    case 'native':
      return new NativeSessionAdapter();
    case 'codex':
      return new CodexSessionAdapter();
    case 'claude-deepseek':
    case 'claude':
    default:
      return new ClaudeSessionAdapter();
  }
}
