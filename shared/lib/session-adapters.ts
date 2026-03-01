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

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveProjectsDir } from './workflow-cost.ts';

// ────────────────────────────────────────────────────────────────
// Common types
// ────────────────────────────────────────────────────────────────

/** Supported agent identifiers. */
export type AgentType = 'claude' | 'codex';

/** Per-model aggregated token usage (without cost — cost is computed later). */
export interface SessionModelUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** Result of scanning sessions for a given agent. */
export interface SessionUsageResult {
  /** Per-model token usage breakdown. */
  models: Record<string, SessionModelUsage>;
  /** Number of session files that contributed data. */
  sessionCount: number;
  /** Number of assistant turns counted (or 1 per session for agents with cumulative totals). */
  turnCount: number;
}

/** Options for scanning sessions. */
export interface SessionScanOptions {
  worktreePath: string;
  branchName: string;
}

/** A session adapter knows how to scan an agent's session files. */
export interface SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null;
}

// ────────────────────────────────────────────────────────────────
// Claude adapter
// ────────────────────────────────────────────────────────────────

/**
 * Reads Claude Code session files from ~/.claude/projects/<encoded-path>/.
 * Filters by type === 'assistant' and gitBranch, aggregates per-turn
 * message.usage token counts per model.
 */
export class ClaudeSessionAdapter implements SessionAdapter {
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
    const projectsDir = resolveProjectsDir(opts.worktreePath);

    if (debug) {
      console.log(`[DEBUG_COST] ClaudeSessionAdapter.scan:`);
      console.log(`[DEBUG_COST]   worktreePath: ${opts.worktreePath}`);
      console.log(`[DEBUG_COST]   branchName: ${opts.branchName}`);
      console.log(`[DEBUG_COST]   projectsDir: ${projectsDir}`);
    }

    if (!existsSync(projectsDir)) {
      if (debug) {
        console.log(`[DEBUG_COST]   ❌ Projects directory does not exist`);
      }
      return null;
    }

    if (debug) {
      console.log(`[DEBUG_COST]   ✓ Projects directory exists`);
    }

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(projectsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(projectsDir, f));
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

    for (const filePath of sessionFiles) {
      let sessionHadTurns = false;

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
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
        }
      } catch {
        continue;
      }

      if (sessionHadTurns) {
        sessionCount++;
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

    return { models, sessionCount, turnCount };
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
  scan(opts: SessionScanOptions): SessionUsageResult | null {
    const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';
    const sessionsRoot = join(homedir(), '.codex', 'sessions');

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

    return { models, sessionCount, turnCount };
  }

  /**
   * Recursively find .jsonl files whose session_meta matches
   * the target worktree cwd or branch.
   */
  private discoverMatchingFiles(sessionsRoot: string, opts: SessionScanOptions, debug = false): string[] {
    const matching: string[] = [];
    const resolvedWorktree = resolve(opts.worktreePath);

    if (debug) {
      console.log(`[DEBUG_COST]   Scanning for session files matching worktree or branch...`);
    }

    this.walkJsonlFiles(sessionsRoot, (filePath) => {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const firstNewline = content.indexOf('\n');
        const firstLine = firstNewline >= 0 ? content.slice(0, firstNewline) : content;
        if (!firstLine.trim()) return;

        const meta = JSON.parse(firstLine);
        if (meta.type !== 'session_meta') return;

        const cwd = meta.payload?.cwd;
        const branch = meta.payload?.git?.branch;

        const cwdMatches = cwd && resolve(cwd) === resolvedWorktree;
        const branchMatches = branch === opts.branchName;

        if (cwdMatches || branchMatches) {
          matching.push(filePath);
        }
      } catch {
        // Skip unreadable files
      }
    });

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
  private parseSessionFile(filePath: string): { modelId: string; usage: SessionModelUsage } | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let modelId = 'unknown';
      let lastTokenUsage: Record<string, number> | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;

        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        // Extract model from turn_context entries
        if (entry.type === 'turn_context') {
          const payload = entry.payload as Record<string, unknown> | undefined;
          if (payload?.model) {
            modelId = payload.model as string;
          }
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
          }
        }
      }

      if (!lastTokenUsage) return null;

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
      };
    } catch {
      return null;
    }
  }
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
 * @returns 'claude' | 'codex' | null
 */
export function detectAgentType(opts: SessionScanOptions): AgentType | null {
  const debug = process.env.DEBUG_COST === '1' || process.env.DEBUG_COST === 'true';

  const claudeAdapter = new ClaudeSessionAdapter();
  const codexAdapter = new CodexSessionAdapter();

  const claudeResult = claudeAdapter.scan(opts);
  const codexResult = codexAdapter.scan(opts);

  if (claudeResult && !codexResult) {
    if (debug) console.log('[DEBUG_COST] Auto-detected agent: claude');
    return 'claude';
  }
  if (codexResult && !claudeResult) {
    if (debug) console.log('[DEBUG_COST] Auto-detected agent: codex');
    return 'codex';
  }
  if (claudeResult && codexResult) {
    // Both exist - pick the one with more turns
    const detected = claudeResult.turnCount >= codexResult.turnCount ? 'claude' : 'codex';
    if (debug) {
      console.log(
        `[DEBUG_COST] Both agents have sessions - choosing ${detected} ` +
        `(${detected === 'claude' ? claudeResult.turnCount : codexResult.turnCount} turns ` +
        `vs ${detected === 'claude' ? codexResult.turnCount : claudeResult.turnCount})`
      );
    }
    return detected;
  }

  if (debug) console.log('[DEBUG_COST] No sessions found for either agent');
  return null;
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
    case 'codex':
      return new CodexSessionAdapter();
    case 'claude':
    default:
      return new ClaudeSessionAdapter();
  }
}
