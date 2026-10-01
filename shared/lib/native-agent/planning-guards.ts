import { createHash } from 'node:crypto';
import type { LoopBudget } from './loop.ts';

export interface ToolStagnationPolicy {
  maxRepeatedSignatureCalls?: number;
  maxNoNovelProgressCalls?: number;
}

export interface NativePlanningLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  toolStagnation: Required<ToolStagnationPolicy>;
}

export const DEFAULT_NATIVE_PLANNING_LIMITS: NativePlanningLimits = {
  maxTurns: 40,
  maxToolCalls: 120,
  maxWallClockMs: 20 * 60 * 1000,
  toolStagnation: {
    maxRepeatedSignatureCalls: 8,
    maxNoNovelProgressCalls: 4,
  },
};

export type PlanningFailureReason =
  | 'turn_limit'
  | 'tool_call_limit'
  | 'wall_clock_limit'
  | 'tool_stagnation'
  | 'invalid_final_plan'
  | 'empty_final_plan'
  | 'aborted'
  | 'error';

export interface PlanningLoopBudget extends LoopBudget {
  stagnation?: ToolStagnationPolicy;
}

export interface ToolStagnationDecision {
  stagnant: boolean;
  signature: string;
  repeatedCalls: number;
  noNovelProgressCalls: number;
}

export interface FinalPlanValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * HOK-3129: structural reasons that reflect how the model formatted its
 * output, not what the plan says. A single bounded repair turn that quotes
 * the validator reason has a reasonable chance of rescuing an otherwise
 * substantive plan (the HOK-3125 Gemini plan was 8.6 KB and only lacked an
 * H1). `too_short`, `empty`, and `control_text_leakage` stay off the set:
 * they signal substantive failure, not a format slip.
 */
export const REPAIRABLE_PLAN_VALIDATION_REASONS: ReadonlySet<string> = new Set([
  'missing_title',
  'missing_release_readiness',
  'missing_release_readiness_database_change_risk',
  'missing_release_readiness_env_changes',
  'missing_release_readiness_config_changes',
  'missing_release_readiness_manual_steps',
  'missing_actionable_structure',
]);

export function isRepairablePlanValidationReason(reason: string | undefined | null): boolean {
  return typeof reason === 'string' && REPAIRABLE_PLAN_VALIDATION_REASONS.has(reason);
}

interface ToolCallObservation {
  toolCall: {
    name: string;
  };
  args: unknown;
  result?: unknown;
  isError?: boolean;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveNativePlanningLimits(config: {
  maxTurns?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
  toolStagnation?: ToolStagnationPolicy;
} | undefined): NativePlanningLimits {
  const defaults = DEFAULT_NATIVE_PLANNING_LIMITS;
  return {
    maxTurns: positiveInteger(config?.maxTurns) ?? defaults.maxTurns,
    maxToolCalls: positiveInteger(config?.maxToolCalls) ?? defaults.maxToolCalls,
    maxWallClockMs: positiveInteger(config?.maxWallClockMs) ?? defaults.maxWallClockMs,
    toolStagnation: {
      maxRepeatedSignatureCalls:
        positiveInteger(config?.toolStagnation?.maxRepeatedSignatureCalls)
        ?? defaults.toolStagnation.maxRepeatedSignatureCalls,
      maxNoNovelProgressCalls:
        positiveInteger(config?.toolStagnation?.maxNoNovelProgressCalls)
        ?? defaults.toolStagnation.maxNoNovelProgressCalls,
    },
  };
}

export function toLoopBudget(limits: NativePlanningLimits): PlanningLoopBudget {
  return {
    maxTurns: limits.maxTurns,
    maxToolCalls: limits.maxToolCalls,
    maxWallClockMs: limits.maxWallClockMs,
    stagnation: limits.toolStagnation,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return '{' + sorted
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',') + '}';
}

export function normalizedToolSignature(name: string, args: unknown): string {
  return `${name}:${stableStringify(args ?? {})}`;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function toolOutputFingerprint(ctx: ToolCallObservation, override: { content?: unknown; details?: unknown } | undefined): string {
  const result = ctx.result as { content?: unknown; details?: unknown } | null | undefined;
  return hashValue({
    isError: ctx.isError,
    content: override?.content ?? result?.content ?? [],
    details: override?.details ?? result?.details ?? null,
  });
}

export class ToolStagnationTracker {
  private readonly policy: Required<ToolStagnationPolicy>;
  private readonly counts = new Map<string, { repeatedCalls: number; lastOutputHash?: string; noNovelProgressCalls: number }>();

  constructor(policy: Required<ToolStagnationPolicy>) {
    this.policy = policy;
  }

  record(ctx: ToolCallObservation, override: { content?: unknown; details?: unknown } | undefined): ToolStagnationDecision {
    const signature = normalizedToolSignature(ctx.toolCall.name, ctx.args);
    const previous = this.counts.get(signature);
    const outputHash = toolOutputFingerprint(ctx, override);
    const next = previous ?? { repeatedCalls: 0, noNovelProgressCalls: 0 };
    next.repeatedCalls += 1;
    next.noNovelProgressCalls = next.lastOutputHash === outputHash
      ? next.noNovelProgressCalls + 1
      : 0;
    next.lastOutputHash = outputHash;
    this.counts.set(signature, next);

    const stagnant =
      next.repeatedCalls >= this.policy.maxRepeatedSignatureCalls &&
      next.noNovelProgressCalls >= this.policy.maxNoNovelProgressCalls;

    return {
      stagnant,
      signature,
      repeatedCalls: next.repeatedCalls,
      noNovelProgressCalls: next.noNovelProgressCalls,
    };
  }
}

const RELEASE_READINESS_FIELDS = [
  'database_change_risk',
  'env_changes',
  'config_changes',
  'manual_steps',
];

const CONTROL_TEXT_PATTERNS: RegExp[] = [
  /<\|(?:tool|assistant|user|system|channel|constrain|analysis|final)[^>]*\|>/i,
  /\b(?:tool_call|tool_calls|function_call)\b/i,
  /\b(?:recipient_name|arguments_json|tool_call_id)\b/i,
  /^\s*\{\s*"[^"]+"\s*:\s*(?:\{|\[|")/s,
  /\bto=functions\./i,
  /\bnamespace\s+\w+\s*\{/i,
];

export function validateFinalPlanningArtifact(text: string): FinalPlanValidationResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { valid: false, reason: 'empty' };
  }
  if (trimmed.length < 120) {
    return { valid: false, reason: 'too_short' };
  }
  if (CONTROL_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { valid: false, reason: 'control_text_leakage' };
  }
  if (!/^#\s+\S.{2,}$/m.test(trimmed)) {
    return { valid: false, reason: 'missing_title' };
  }
  if (!/^##\s+Release Readiness\b/m.test(trimmed)) {
    return { valid: false, reason: 'missing_release_readiness' };
  }
  for (const field of RELEASE_READINESS_FIELDS) {
    if (!new RegExp(`^-\\s+\\*\\*${field}\\*\\*\\s*:`, 'm').test(trimmed)) {
      return { valid: false, reason: `missing_release_readiness_${field}` };
    }
  }
  const hasActionableStructure =
    /^##\s+(?:Phase|Implementation|Plan|Approach|Tasks?|Steps?|Validation|Testing|Scope)\b/im.test(trimmed) &&
    /^-\s+\S/m.test(trimmed);
  if (!hasActionableStructure) {
    return { valid: false, reason: 'missing_actionable_structure' };
  }
  return { valid: true };
}
