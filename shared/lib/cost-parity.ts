/**
 * Wavemill Cost Parity Harness
 *
 * Core logic for materializing test cases, running the cost engine, capturing
 * outputs, and comparing them against the committed baseline. Since HOK-3077
 * the SDK bridge is the only engine, so this is a strict regression harness:
 * any difference from `baseline.json` (beyond USD rounding) is a drift in the
 * SDK bridge's cost semantics and fails until the baseline is regenerated on
 * purpose (`npx tsx tools/cost-parity.ts --write`).
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowCostOutcome } from './workflow-cost.ts';
import type { PricingTable } from './pricing/model-pricing.ts';
import { encodeProjectDir } from './wavemill-session-paths.ts';
import { collectSdkTaskCostSummaries } from './sdk-task-cost/collect.ts';
import { meterWorkflowCost } from './sdk-task-cost/meter.ts';
import type {
  CostParityCase,
  CostParityManifest,
  ExactPricingResponse,
  ValidationResult,
} from '../fixtures/cost-parity/schema.ts';
import { validateManifest } from '../fixtures/cost-parity/schema.ts';

// ────────────────────────────────────────────────────────────────
// Snapshot Types
// ────────────────────────────────────────────────────────────────

export interface CaseSnapshot {
  caseId: string;
  sync: {
    outcome: WorkflowCostOutcome;
    warnings: string[];
  };
  exact?: {
    outcome: WorkflowCostOutcome;
    warnings: string[];
  };
  consumerProjections?: {
    reportOutput?: string;
    missingCostEligibility?: boolean;
    routeCalibrationCostUsd?: number;
  };
}

export interface CorpusSnapshot {
  cases: Record<string, CaseSnapshot>;
  reportOutput?: string;
}

// ────────────────────────────────────────────────────────────────
// Comparison Types
// ────────────────────────────────────────────────────────────────

export type ComparisonClassification = 'strict_violation';

export interface ComparisonDifference {
  caseId: string;
  path: string;
  baseline: unknown;
  candidate: unknown;
  classification: ComparisonClassification;
}

export interface ComparisonResult {
  differences: ComparisonDifference[];
  exitCode: 0 | 1 | 2; // 0 clean, 1 differences, 2 schema/corpus error
  message: string;
}

// ────────────────────────────────────────────────────────────────
// Manifest and Baseline Loading
// ────────────────────────────────────────────────────────────────

export function loadCostParityManifest(manifestPath: string): {
  manifest: CostParityManifest;
  validation: ValidationResult;
} {
  const content = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(content) as CostParityManifest;
  const validation = validateManifest(manifest);
  return { manifest, validation };
}

export function loadCostParityBaseline(baselinePath: string): Record<string, CaseSnapshot> {
  if (!existsSync(baselinePath)) {
    return {};
  }
  const content = readFileSync(baselinePath, 'utf-8');
  return JSON.parse(content) as Record<string, CaseSnapshot>;
}

// ────────────────────────────────────────────────────────────────
// Materialization
// ────────────────────────────────────────────────────────────────

interface MaterializationContext {
  sandbox: string;
  home: string;
  worktree: string;
  repoDir: string;
  savedEnv: Record<string, string | undefined>;
}

type LogicalLine = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function translateFixtureLine(
  location: string,
  line: LogicalLine,
  ctx: { branch: string; worktree: string }
): LogicalLine[] {
  if (location === 'claude-projects' || location === 'claude-deepseek-provider') {
    if (line.type === 'assistant' || line.type === 'user') {
      return [line];
    }
    const message = isRecord(line.message) ? line.message : {};
    const usage = isRecord(line.usage) ? line.usage : {};
    const gitBranch = typeof line.branch === 'string' ? line.branch : ctx.branch;
    const messageOut: Record<string, unknown> = { ...message };
    if (usage) {
      messageOut.usage = {
        input_tokens: usage.inputTokens ?? usage.input_tokens ?? 0,
        cache_creation_input_tokens:
          usage.cacheCreationTokens ?? usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? 0,
        output_tokens: usage.outputTokens ?? usage.output_tokens ?? 0,
      };
    }
    if (!messageOut.model && line.model) {
      messageOut.model = line.model;
    }
    const translated: Record<string, unknown> = {
      type: 'assistant',
      uuid: line.uuid ?? message.id ?? `t-${Math.random().toString(36).slice(2, 10)}`,
      gitBranch,
      timestamp: line.timestamp ?? '2026-01-01T00:00:00.000Z',
      message: messageOut,
    };
    if (line.sessionId !== undefined) translated.sessionId = line.sessionId;
    if (line.parentUuid !== undefined) translated.parentUuid = line.parentUuid;
    if (line.isSidechain !== undefined) translated.isSidechain = line.isSidechain;
    if (line.costUSD !== undefined) translated.costUSD = line.costUSD;
    return [translated];
  }

  if (location === 'codex-sessions') {
    if (line.type) {
      return [line];
    }
    const out: LogicalLine[] = [];
    if (isRecord(line.session_meta)) {
      const meta = line.session_meta;
      out.push({
        type: 'session_meta',
        timestamp: line.timestamp ?? '2026-01-01T00:00:00.000Z',
        payload: {
          id: meta.session_id ?? meta.id ?? 'codex-session',
          cwd: meta.cwd ?? ctx.worktree,
          originator: meta.originator ?? null,
        },
      });
    }
    if (isRecord(line.turn)) {
      const turn = line.turn;
      out.push({
        type: 'turn_context',
        payload: { model: turn.model ?? 'unknown' },
      });
      out.push({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: turn.input_tokens ?? 0,
              cached_input_tokens: turn.cached_input_tokens ?? 0,
              output_tokens: turn.output_tokens ?? 0,
              reasoning_output_tokens: turn.reasoning_output_tokens ?? 0,
              total_tokens: turn.total_tokens ?? 0,
            },
          },
        },
      });
    }
    return out;
  }

  if (location === 'native-sessions') {
    if (line.type === 'session_meta' || line.type === 'session_started') {
      return [{
        type: 'session_started',
        timestamp: line.timestamp ?? '2026-01-01T00:00:00.000Z',
        sessionId: line.session_id ?? line.sessionId ?? 'native-session',
        provider: line.provider ?? 'unknown',
        model: line.model ?? 'unknown',
      }];
    }
    if (line.type === 'turn_complete' || line.type === 'assistant_message') {
      const translated: Record<string, unknown> = {
        type: 'assistant_message',
        timestamp: line.timestamp ?? '2026-01-01T00:00:00.000Z',
        sessionId: line.session_id ?? line.sessionId,
      };
      if (line.response_id !== undefined) translated.responseId = line.response_id;
      if (line.model !== undefined) translated.model = line.model;
      // Pi transcript usage keys (`piUsageToSessionModelUsage`). A missing
      // count is omitted so the adapter sees an absent field.
      const inputTokens = line.input_tokens ?? null;
      const outputTokens = line.output_tokens ?? null;
      const usageOut: Record<string, unknown> = {
        cacheWrite: line.cache_creation_tokens ?? 0,
        cacheRead: line.cache_read_tokens ?? 0,
        totalTokens:
          (typeof inputTokens === 'number' ? inputTokens : 0) +
          (typeof outputTokens === 'number' ? outputTokens : 0),
      };
      if (typeof inputTokens === 'number') usageOut.input = inputTokens;
      if (typeof outputTokens === 'number') usageOut.output = outputTokens;
      translated.usage = usageOut;
      if (typeof line.cost_usd === 'number') {
        (translated.usage as Record<string, unknown>).cost = { total: line.cost_usd };
      }
      return [translated];
    }
    return [line];
  }

  return [line];
}

export function materializeCase(caseItem: CostParityCase): MaterializationContext {
  const savedEnv: Record<string, string | undefined> = {};
  const sandbox = mkdtempSync(join(tmpdir(), 'cost-parity-'));
  const home = join(sandbox, 'home');
  const worktree = join(sandbox, 'worktree');
  const repoDir = join(sandbox, 'repo');

  try {
    // Create directory structure
    mkdirSync(home, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    // Write session files to appropriate locations. Claude Code encodes the
    // worktree absolute path into the projects directory name, so we must
    // resolve the encoded name from the ephemeral sandbox worktree — not use
    // a hardcoded placeholder that the session adapters will never find.
    const encoded = encodeProjectDir(worktree);
    for (const session of caseItem.sessions) {
      let targetDir: string;

      if (session.location === 'claude-projects') {
        targetDir = join(home, '.claude', 'projects', encoded);
      } else if (session.location === 'claude-deepseek-provider') {
        targetDir = join(
          worktree,
          '.wavemill',
          'runs',
          session.runId || 'run-1',
          'providers',
          'deepseek',
          'home',
          '.claude',
          'projects',
          encoded
        );
      } else if (session.location === 'codex-sessions') {
        targetDir = join(home, '.codex', 'sessions', '2026', '01', '01');
      } else if (session.location === 'native-sessions') {
        targetDir = join(worktree, '.wavemill', 'runs', session.runId || 'run-1', 'native-sessions');
      } else {
        throw new Error(`Unknown session location: ${session.location}`);
      }

      mkdirSync(targetDir, { recursive: true });

      // Substitute ${WORKTREE} and translate fixture lines into the physical
      // session-file layout each parser actually reads. Fixtures live in a
      // human-readable "logical" form (camelCase, per-case branch alias, etc);
      // this step is the sole boundary between that form and the real
      // ClaudeSessionAdapter / CodexSessionAdapter / NativeSessionAdapter
      // formats. Without it the engine would silently see zero
      // discoverable turns and every baseline entry would collapse to
      // `no_sessions`.
      const branch = caseItem.branch || 'task/parity';
      const translated = session.lines.flatMap((line) => {
        const substituted = JSON.parse(
          JSON.stringify(line).replace(/\$\{WORKTREE\}/g, worktree)
        );
        return translateFixtureLine(session.location, substituted, { branch, worktree });
      });
      const sessionContent = translated.map((line) => JSON.stringify(line)).join('\n');

      const sessionPath = join(targetDir, session.fileName);
      writeFileSync(sessionPath, sessionContent + '\n');
    }

    // Save and override environment
    savedEnv['HOME'] = process.env.HOME;
    savedEnv['OPENROUTER_API_KEY'] = process.env.OPENROUTER_API_KEY;
    savedEnv['DEBUG_COST'] = process.env.DEBUG_COST;

    process.env.HOME = home;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEBUG_COST;

    return { sandbox, home, worktree, repoDir, savedEnv };
  } catch (error) {
    // Cleanup on error
    if (existsSync(sandbox)) {
      rmSync(sandbox, { recursive: true, force: true });
    }
    throw error;
  }
}

export function cleanupMaterialization(ctx: MaterializationContext): void {
  try {
    // Restore environment
    if (ctx.savedEnv['HOME'] !== undefined) {
      process.env.HOME = ctx.savedEnv['HOME'];
    } else {
      delete process.env.HOME;
    }
    if (ctx.savedEnv['OPENROUTER_API_KEY'] !== undefined) {
      process.env.OPENROUTER_API_KEY = ctx.savedEnv['OPENROUTER_API_KEY'];
    }
    if (ctx.savedEnv['DEBUG_COST'] !== undefined) {
      process.env.DEBUG_COST = ctx.savedEnv['DEBUG_COST'];
    }

    // Cleanup sandbox
    if (existsSync(ctx.sandbox)) {
      rmSync(ctx.sandbox, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ────────────────────────────────────────────────────────────────
// Engine
// ────────────────────────────────────────────────────────────────

export type CostEngine = (ctx: {
  worktreePath: string;
  branchName: string;
  repoDir: string;
  pricingTable: PricingTable;
  agentType: string;
  issueId: string;
  /** Injected OpenRouter `/generation` responses; present only for the exact run. */
  exact?: ExactPricingResponse;
}) => Promise<{ outcome: WorkflowCostOutcome; warnings: string[] }>;

/**
 * The production metering path (`meterWorkflowCost`, HOK-3077) over the
 * materialized sessions: adapter scan → SDK `TaskCostSummaryV1` → projection.
 * The exact run injects the case's stubbed OpenRouter responses, so the
 * exact-pricing fold into SDK events is covered without network access.
 */
export const sdkEngine: CostEngine = async (ctx) => {
  const warnings: string[] = [];
  const logger = {
    log: () => {},
    warn: (...args: unknown[]) => warnings.push(args.map((arg) => String(arg)).join(' ')),
  };
  const responses = ctx.exact?.responses;
  const { outcome } = await meterWorkflowCost({
    worktreePath: ctx.worktreePath,
    branchName: ctx.branchName,
    repoDir: ctx.repoDir,
    issueId: ctx.issueId,
    agentType: ctx.agentType,
    pricingTable: ctx.pricingTable,
    label: 'cost-parity',
    collect: collectSdkTaskCostSummaries,
    ...(responses
      ? {
        exactPricing: {
          enabled: true,
          fetchGenerationCost: async (id: string) => responses[id] ?? null,
          logger,
        },
      }
      : {}),
    logger,
  });
  return { outcome, warnings };
};

// ────────────────────────────────────────────────────────────────
// Snapshot Capture
// ────────────────────────────────────────────────────────────────

export async function captureCase(
  caseItem: CostParityCase,
  engine: CostEngine = sdkEngine
): Promise<CaseSnapshot> {
  const ctx = materializeCase(caseItem);

  try {
    const args = {
      worktreePath: ctx.worktree,
      branchName: caseItem.branch || 'task/parity',
      repoDir: ctx.repoDir,
      pricingTable: caseItem.pricingTable,
      agentType: caseItem.agentType,
      issueId: caseItem.issueId,
    };
    const syncResult = await engine(args);
    // The exact run only exists for cases that stub OpenRouter responses.
    const exactResult = caseItem.exact ? await engine({ ...args, exact: caseItem.exact }) : undefined;

    return {
      caseId: caseItem.id,
      sync: syncResult,
      ...(exactResult ? { exact: exactResult } : {}),
    };
  } finally {
    cleanupMaterialization(ctx);
  }
}

export async function captureCorpus(
  manifest: CostParityManifest,
  engine?: CostEngine
): Promise<CorpusSnapshot> {
  const cases: Record<string, CaseSnapshot> = {};

  for (const caseItem of manifest.cases) {
    cases[caseItem.id] = await captureCase(caseItem, engine);
  }

  return { cases };
}

// ────────────────────────────────────────────────────────────────
// Sanitization
// ────────────────────────────────────────────────────────────────

export function sanitizeSnapshot(snapshot: CorpusSnapshot, ctx?: {
  sandbox?: string;
  home?: string;
  worktree?: string;
}): CorpusSnapshot {
  const json = JSON.stringify(snapshot);

  // Replace absolute paths with tokens (must handle /var and /tmp paths)
  let sanitized = json;
  // Replace common temp directory patterns
  sanitized = sanitized.replace(/\/var\/folders\/[^/]+\/[^/]+\/T\/cost-parity-[^/]+/g, '<SANDBOX>');
  sanitized = sanitized.replace(/\/tmp\/cost-parity-[^/]+/g, '<SANDBOX>');

  if (ctx?.sandbox) {
    sanitized = sanitized.replace(new RegExp(ctx.sandbox.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<SANDBOX>');
  }
  if (ctx?.home) {
    sanitized = sanitized.replace(new RegExp(ctx.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<HOME>');
  }
  if (ctx?.worktree) {
    sanitized = sanitized.replace(new RegExp(ctx.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<WORKTREE>');
  }

  // Remove privacy canaries
  sanitized = sanitized.replace(/"secret-token-should-not-persist"[^"]*"/g, '"<CANARY>"');

  // Remove rawContent and replayContent keys (privacy)
  sanitized = sanitized.replace(/"(rawContent|replayContent)":\s*"[^"]*"/g, '');

  // Sort object keys for determinism
  const parsed = JSON.parse(sanitized);
  return sortKeys(parsed) as CorpusSnapshot;
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => sortKeys(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

// ────────────────────────────────────────────────────────────────
// Comparison
// ────────────────────────────────────────────────────────────────

const USD_TOLERANCE = 1e-9;

function isUsdField(path: string): boolean {
  return /[Cc]ost[Uu]sd$|totalCostUsd|workflowCost/.test(path);
}

export function deepDiff(baseline: unknown, candidate: unknown, path: string = ''): Array<{
  path: string;
  baseline: unknown;
  candidate: unknown;
}> {
  const differences: Array<{ path: string; baseline: unknown; candidate: unknown }> = [];

  // Handle nulls and undefined
  if (baseline == null && candidate == null) {
    return differences;
  }
  if (baseline == null || candidate == null) {
    differences.push({ path, baseline, candidate });
    return differences;
  }

  // Handle numbers with tolerance for USD fields
  if (typeof baseline === 'number' && typeof candidate === 'number') {
    if (isUsdField(path)) {
      if (Math.abs(baseline - candidate) > USD_TOLERANCE) {
        differences.push({ path, baseline, candidate });
      }
    } else if (baseline !== candidate) {
      differences.push({ path, baseline, candidate });
    }
    return differences;
  }

  // Handle primitives
  if (typeof baseline !== 'object' || typeof candidate !== 'object') {
    if (baseline !== candidate) {
      differences.push({ path, baseline, candidate });
    }
    return differences;
  }

  // Handle arrays
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const maxLen = Math.max(baseline.length, candidate.length);
    for (let i = 0; i < maxLen; i++) {
      const subPath = `${path}[${i}]`;
      differences.push(
        ...deepDiff(baseline[i], candidate[i], subPath)
      );
    }
    return differences;
  }

  // Handle objects
  const baselineObj = baseline as Record<string, unknown>;
  const candidateObj = candidate as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(baselineObj), ...Object.keys(candidateObj)]);

  for (const key of allKeys) {
    const subPath = path ? `${path}.${key}` : key;
    differences.push(
      ...deepDiff(baselineObj[key], candidateObj[key], subPath)
    );
  }

  return differences;
}

/**
 * Strict regression compare: every difference between the baseline and the
 * candidate (USD fields within {@link USD_TOLERANCE}) is a violation, and so
 * is a baseline case the candidate lacks.
 */
export function compareSnapshots(
  baseline: CorpusSnapshot,
  candidate: CorpusSnapshot,
): ComparisonResult {
  const differences: ComparisonDifference[] = [];

  for (const caseId of Object.keys(baseline.cases)) {
    const baselineCase = baseline.cases[caseId];
    const candidateCase = candidate.cases[caseId];

    if (!candidateCase) {
      differences.push({
        caseId,
        path: '<root>',
        baseline: baselineCase,
        candidate: undefined,
        classification: 'strict_violation',
      });
      continue;
    }

    for (const diff of deepDiff(baselineCase, candidateCase)) {
      differences.push({ caseId, ...diff, classification: 'strict_violation' });
    }
  }

  return {
    differences,
    exitCode: differences.length > 0 ? 1 : 0,
    message: differences.length > 0 ? `Found ${differences.length} differences` : 'All tests passed',
  };
}

export function formatComparison(result: ComparisonResult, verbose = false): string {
  let output = result.message + '\n';

  if (result.differences.length > 0) {
    output += `\nDifferences:\n`;
    for (const diff of result.differences) {
      output += `  ${diff.caseId} @ ${diff.path}: ${diff.classification}\n`;
      if (verbose) {
        output += `    baseline: ${JSON.stringify(diff.baseline).slice(0, 100)}\n`;
        output += `    candidate: ${JSON.stringify(diff.candidate).slice(0, 100)}\n`;
      }
    }
  }

  return output;
}
