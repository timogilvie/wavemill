import type { LoopBudget } from './loop.ts';
import type { ToolCallProgressPolicy } from '../task-progress.ts';

/**
 * Config-facing stagnation knobs (`nativeAgent.planning.toolStagnation`).
 * The field names are the wavemill-config schema's; `toLoopBudget` maps them
 * onto the shared HOK-3381 tool-call progress rule in
 * `shared/lib/task-progress.ts` (`ToolCallProgressTracker`). The old private
 * `ToolStagnationTracker` (exact signature + output hash) is deleted.
 */
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
  // HOK-3362: every budget stop reason is a planning terminal reason.
  | 'token_limit'
  | 'cost_limit'
  | 'tool_stagnation'
  | 'invalid_final_plan'
  | 'empty_final_plan'
  | 'aborted'
  | 'error';

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

/** Map the config-facing stagnation knobs onto the shared HOK-3381 rule. */
export function toToolCallProgressPolicy(policy: Required<ToolStagnationPolicy>): ToolCallProgressPolicy {
  return {
    maxRepeatedSelectionCalls: policy.maxRepeatedSignatureCalls,
    maxNoProgressCalls: policy.maxNoNovelProgressCalls,
  };
}

export function toLoopBudget(limits: NativePlanningLimits): LoopBudget {
  return {
    maxTurns: limits.maxTurns,
    maxToolCalls: limits.maxToolCalls,
    maxWallClockMs: limits.maxWallClockMs,
    stagnation: toToolCallProgressPolicy(limits.toolStagnation),
  };
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
