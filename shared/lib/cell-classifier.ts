/**
 * Pure structural cell classifier (HOK-3361, phase 2).
 *
 * Deterministic signal extraction over changed paths / diff structure:
 * migration-schema, callers-integration-config, lifecycle-runtime,
 * documentation-use, and local syntax/semantic changes. Signals narrow or
 * select a candidate (layer, lens); ambiguous or conflicting signals — or no
 * substrate at all — yield the explicit `unknown` outcome rather than a
 * guessed cell. Precision over recall.
 */

import {
  type CellLayer,
  type CellLens,
  type CellReasonCode,
  type CellStructuralOutcome,
  type ChangedPath,
} from './cell-label-contract.ts';

/** One fired structural signal with its candidate coordinate and weight. */
export interface CellSignal {
  id: string;
  layer: CellLayer;
  lens: CellLens;
  weight: number;
}

const SEGMENT_PREFIX = '(?:^|[/_.-])';

/** Path-pattern signal table (checked in order; first match per pattern). */
const PATH_SIGNALS: ReadonlyArray<{
  id: string;
  layer: CellLayer;
  lens: CellLens;
  weight: number;
  pattern: RegExp;
}> = [
  {
    id: 'migration_schema',
    layer: 'runtime',
    lens: 'reversibility',
    weight: 3,
    pattern: new RegExp(`${SEGMENT_PREFIX}(migrations?|schema|prisma|drizzle|knex|alembic)(?:[/.-]|$)`, 'i'),
  },
  {
    id: 'sql_or_ddl',
    layer: 'runtime',
    lens: 'reversibility',
    weight: 3,
    pattern: /\.(sql|ddl)$/i,
  },
  {
    id: 'config_or_wiring',
    layer: 'wiring',
    lens: 'correctness',
    weight: 2.5,
    pattern: new RegExp(`${SEGMENT_PREFIX}(config|wiring|routes?|wire|bootstrap|composition|registry|registrations?)(?:[/.-]|$)`, 'i'),
  },
  {
    id: 'entrypoint_or_caller',
    layer: 'wiring',
    lens: 'correctness',
    weight: 2,
    pattern: /(?:^|[/._-])(index|main|app|server|entry|entrypoint|cli|bin|launch|startup)(\.[a-z]+)?$/i,
  },
  {
    id: 'lifecycle_or_error_path',
    layer: 'runtime',
    lens: 'correctness',
    weight: 2.5,
    pattern: new RegExp(`${SEGMENT_PREFIX}(lifecycle|retry|retries|watchdog|recovery|reaper|timer|scheduler|queue|monitor|watch|hook)(?:[/.-]|$)`, 'i'),
  },
  {
    id: 'async_or_runtime_semantics',
    layer: 'runtime',
    lens: 'correctness',
    weight: 2,
    pattern: new RegExp(`${SEGMENT_PREFIX}(async|runtime|worker|pool|loop|interval|timeout)(?:[/.-]|$)`, 'i'),
  },
  {
    id: 'documentation_or_usage',
    layer: 'use',
    lens: 'correctness',
    weight: 2.5,
    pattern: /(?:^|[/._-])(docs?|documentation|examples?|usage|guides?|tutorials?|readme|changelog)(?:[/.-]|$)/i,
  },
  {
    id: 'test_only_change',
    layer: 'use',
    lens: 'correctness',
    weight: 1.5,
    pattern: /(?:^|[/._-])(tests?|__tests__|spec)(?:[/.-]|$)/i,
  },
  {
    id: 'dependency_manifest',
    layer: 'wiring',
    lens: 'reversibility',
    weight: 2,
    pattern: /(^|\/)package(-lock)?\.json$|(^|\/)requirements\.txt$|(^|\/)go\.mod$|(^|\/)Cargo\.toml$/i,
  },
];

/** Keyword lens signals over path text (lens overrides, anchored to substrate). */
const LENS_KEYWORDS: ReadonlyArray<{ id: string; lens: CellLens; pattern: RegExp }> = [
  {
    id: 'security_sensitive',
    lens: 'security',
    pattern: /\b(auth|token|secret|credential|permission|sanitiz|escape|injection|xss|csrf|cve|allowlist|denylist|security)\b/i,
  },
  {
    id: 'history_sensitive',
    lens: 'history',
    pattern: /\b(revert|szz|blame|changelog|backport|hotfix|regression|merge-base|history)\b/i,
  },
  {
    id: 'reversibility_sensitive',
    lens: 'reversibility',
    pattern: /\b(rollback|rollforward|down-?migration|destructive|drop\s+(table|column)|irreversible|backward\s+compat)\b/i,
  },
];

/** Form-level signals: syntax/shape changes with no semantic anchor. */
const FORM_SIGNAL_PATH = /\.(md|txt|json|ya?ml|toml)$/i;

/** Tie window: top-two layer scores within this epsilon are ambiguous. */
const AMBIGUITY_EPSILON = 0.25;

/**
 * Extract ordered structural signals from the changed-path substrate.
 * Deterministic: same input, same output.
 */
export function extractCellSignals(changed: ChangedPath[]): CellSignal[] {
  const signals: CellSignal[] = [];
  for (const change of changed) {
    if (!change?.path) continue;
    for (const rule of PATH_SIGNALS) {
      if (rule.pattern.test(change.path)) {
        signals.push({ id: rule.id, layer: rule.layer, lens: rule.lens, weight: rule.weight });
      }
    }
    if (FORM_SIGNAL_PATH.test(change.path) && !PATH_SIGNALS.some((rule) => rule.pattern.test(change.path))) {
      signals.push({ id: 'declarative_shape_change', layer: 'form', lens: 'correctness', weight: 1.5 });
    }
  }
  const joined = changed.map((change) => change.path).join('\n');
  for (const keyword of LENS_KEYWORDS) {
    if (keyword.pattern.test(joined)) {
      const anchor = signals[0];
      signals.push({
        id: keyword.id,
        layer: anchor ? anchor.layer : 'local_meaning',
        lens: keyword.lens,
        weight: 3,
      });
    }
  }
  if (signals.length === 0 && changed.length > 0) {
    // In-module syntax/semantic edit with no structural anchor: local meaning.
    signals.push({ id: 'local_code_edit', layer: 'local_meaning', lens: 'correctness', weight: 1.5 });
  }
  return signals;
}

/**
 * Classify the defect cell from changed paths alone. Ambiguous or conflicting
 * signals, or an empty substrate, produce the explicit unknown outcome.
 */
export function classifyCellStructural(changed: ChangedPath[]): CellStructuralOutcome {
  if (changed.length === 0) {
    return undecided([], ['no_substrate']);
  }
  const signals = extractCellSignals(changed);
  if (signals.length === 0) {
    return undecided([], ['no_substrate']);
  }

  const layerScores = new Map<CellLayer, number>();
  for (const signal of signals) {
    layerScores.set(signal.layer, (layerScores.get(signal.layer) ?? 0) + signal.weight);
  }
  const ranked = [...layerScores.entries()].sort((a, b) => b[1] - a[1]);
  const [topLayer, topScore] = ranked[0] as [CellLayer, number];
  const runnerUp = ranked[1];
  if (runnerUp && topScore - runnerUp[1] < AMBIGUITY_EPSILON) {
    return undecided(signals.map((signal) => signal.id), ['ambiguous_signals']);
  }

  const layerSignals = signals.filter((signal) => signal.layer === topLayer);
  const lensScores = new Map<CellLens, number>();
  for (const signal of layerSignals) {
    lensScores.set(signal.lens, (lensScores.get(signal.lens) ?? 0) + signal.weight);
  }
  const lensRanked = [...lensScores.entries()].sort((a, b) => b[1] - a[1]);
  const [topLens, topLensScore] = lensRanked[0] as [CellLens, number];
  const lensRunnerUp = lensRanked[1];
  if (lensRunnerUp && topLensScore - lensRunnerUp[1] < AMBIGUITY_EPSILON) {
    return undecided(signals.map((signal) => signal.id), ['ambiguous_signals']);
  }

  return {
    decided: true,
    layer: topLayer,
    lens: topLens,
    signals: signals.map((signal) => signal.id),
    reason_codes: [],
  };
}

function undecided(signals: string[], reasonCodes: CellReasonCode[]): CellStructuralOutcome {
  return {
    decided: false,
    layer: null,
    lens: null,
    signals,
    reason_codes: reasonCodes,
  };
}