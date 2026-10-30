/**
 * Classification and historical enrichment for cell-0.1.0 (HOK-3361).
 *
 * Implements:
 * 1. Pure structural signal extractor over changed paths and diff hunks
 * 2. Bounded LLM classification adapter (fallback / second opinion)
 * 3. Outcome reconciliation and agreement tracking
 * 4. Original PR historical review-stage and challenge evidence enrichment
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveTaskArtifact } from './task-artifact-lookup.ts';
import {
  type CellConfidence,
  type CellDecision,
  type CellReasonCode,
  type DisagreementState,
  type LayerOutcome,
  type LensOutcome,
  type LlmOutcome,
  type PrRef,
  type ReviewEvidence,
  type ReviewLayer,
  type ReviewLens,
  type StructuralOutcome,
  formatCell,
  REVIEW_LAYERS,
  REVIEW_LENSES,
} from './rework-cell-label.ts';

// ── Types for diff input ───────────────────────────────────────────────────

export interface ChangedFileDiff {
  path: string;
  oldPath?: string;
  diffText: string;
}

export interface DiffAnalysisInput {
  files: ChangedFileDiff[];
  rawDiff?: string;
  commitMessage?: string;
  prTitle?: string;
}

// ── Structural Signal Extractor ───────────────────────────────────────────

interface LayerScores {
  form: number;
  local_meaning: number;
  wiring: number;
  runtime: number;
  use: number;
  matchedRules: string[];
}

interface LensScores {
  correctness: number;
  security: number;
  history: number;
  reversibility: number;
  matchedRules: string[];
}

const FORM_PATH_REGEX = /(\.prettierrc|\.eslintrc|biome\.json|\.editorconfig|\.lintstagedrc|\.clang-format)/i;
const USE_PATH_REGEX = /(^docs\/|^commands\/|^tools\/prompts\/|\.md$)/i;
const WIRING_PATH_REGEX = /(migration|schema|config|router|routes|manifest|registry|package\.json|run-.*\.sh)/i;
const RUNTIME_PATH_REGEX = /(mutex|lock|semaphore|worker|thread|stream|socket|process|signal|timeout|ttl)/i;

/** Parses unified diff output into file diffs if rawDiff is provided. */
export function parseUnifiedDiff(rawDiff: string): ChangedFileDiff[] {
  if (!rawDiff || !rawDiff.trim()) return [];

  const files: ChangedFileDiff[] = [];
  const lines = rawDiff.split('\n');
  let currentFile: ChangedFileDiff | null = null;
  const currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        currentFile.diffText = currentLines.join('\n');
        files.push(currentFile);
        currentLines.length = 0;
      }
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match ? match[2] : 'unknown';
      const oldPath = match ? match[1] : undefined;
      currentFile = { path, oldPath, diffText: '' };
    } else if (currentFile) {
      currentLines.push(line);
    }
  }

  if (currentFile) {
    currentFile.diffText = currentLines.join('\n');
    files.push(currentFile);
  }

  return files;
}

export function classifyStructuralSignals(input: DiffAnalysisInput): StructuralOutcome {
  const files = input.files && input.files.length > 0
    ? input.files
    : parseUnifiedDiff(input.rawDiff ?? '');

  if (files.length === 0) {
    return {
      layer: 'unknown',
      lens: 'unknown',
      cell: 'unknown',
      confidence: 'none',
      matched_rules: ['insufficient_substrate:no_files_changed'],
    };
  }

  const layerScores: LayerScores = {
    form: 0,
    local_meaning: 0,
    wiring: 0,
    runtime: 0,
    use: 0,
    matchedRules: [],
  };

  const lensScores: LensScores = {
    correctness: 0,
    security: 0,
    history: 0,
    reversibility: 0,
    matchedRules: [],
  };

  let totalContentLines = 0;
  let whitespaceOrCommentLines = 0;

  for (const file of files) {
    const p = file.path.toLowerCase();
    const diff = file.diffText;

    // Check path patterns
    if (FORM_PATH_REGEX.test(p)) {
      layerScores.form += 4;
      layerScores.matchedRules.push(`path:form:${file.path}`);
    }

    if (USE_PATH_REGEX.test(p)) {
      layerScores.use += 3;
      layerScores.matchedRules.push(`path:use:${file.path}`);
    }

    if (WIRING_PATH_REGEX.test(p)) {
      layerScores.wiring += 3;
      layerScores.matchedRules.push(`path:wiring:${file.path}`);
    }

    if (RUNTIME_PATH_REGEX.test(p)) {
      layerScores.runtime += 3;
      layerScores.matchedRules.push(`path:runtime:${file.path}`);
    }

    // Security paths
    if (/(auth|secret|credential|token|crypto|sanitize|permission|rbac|firewall)/i.test(p)) {
      lensScores.security += 4;
      lensScores.matchedRules.push(`path:security:${file.path}`);
    }

    // Inspect hunk lines
    const hunkLines = diff.split('\n');
    for (const line of hunkLines) {
      if (!line.startsWith('+') && !line.startsWith('-')) continue;
      if (line.startsWith('+++') || line.startsWith('---')) continue;

      totalContentLines++;
      const text = line.slice(1).trim();

      if (!text || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('#')) {
        whitespaceOrCommentLines++;
      }

      // Layer signals
      // Wiring: exports, imports, signatures, route mapping, config properties
      if (/^(export\s+|import\s+|interface\s+|type\s+|module\.exports)/.test(text) ||
          /(router|register|routes|manifest|schema|validator|endpoint)/i.test(text)) {
        layerScores.wiring += 1;
      }

      // Runtime: async, promises, timers, locks, process signals
      if (/(async\s+|await\s+|Promise\.|setTimeout|setInterval|clearTimeout|clearInterval|process\.exit|process\.on|SIGINT|SIGTERM|mutex|lock|semaphore|stream\.|pipe\(|close\(|destroy\()/i.test(text)) {
        layerScores.runtime += 2;
      }

      // Use: CLI options, help messages, prompt directives
      if (/(options:\s*\{|flags|argv|--help|commander|yargs|description:|prompt|human-readable|stdout\.write)/i.test(text)) {
        layerScores.use += 1;
      }

      // Local meaning: logic operators, boundary checks, null coalescing
      if (/(\?\?|\?\.|===|!==|<=|>=|<|>|&&|\|\||return\s+|if\s*\(|while\s*\()/.test(text)) {
        layerScores.local_meaning += 1;
      }

      // Lens signals
      // Security
      if (/(password|secret|bearer|authorization|api_key|token|escape|sanitize|xss|sql|injection|vulnerability)/i.test(text)) {
        lensScores.security += 2;
      }

      // Reversibility
      if (/(rollback|revert|undo|teardown|cleanup|trap|finally|idempotent|down\(|reverse)/i.test(text)) {
        lensScores.reversibility += 2;
      }

      // Correctness
      if (/(assert|expect|throw\s+new\s+|error|fix|bug|broken|overflow|underflow|undefined|null|nan)/i.test(text)) {
        lensScores.correctness += 1;
      }
    }
  }

  // History lens checks PR title / commit message
  const contextText = `${input.prTitle ?? ''} ${input.commitMessage ?? ''}`.toLowerCase();
  if (/(regression|broke after|restore|re-introduce|accidental(ly)? deleted|unintended revert)/i.test(contextText)) {
    lensScores.history += 4;
    lensScores.matchedRules.push('context:history:regression_detected');
  }

  // If nearly all changed lines are whitespace/comments, boost form
  if (totalContentLines > 0 && (whitespaceOrCommentLines / totalContentLines) >= 0.85) {
    layerScores.form += 5;
    layerScores.matchedRules.push('diff:high_whitespace_or_comment_ratio');
  }

  // Determine Layer
  let chosenLayer: LayerOutcome = 'unknown';
  let layerConfidence: CellConfidence = 'none';

  const scoredLayers: { layer: ReviewLayer; score: number }[] = REVIEW_LAYERS.map(
    (layer) => ({ layer, score: layerScores[layer] })
  ).sort((a, b) => b.score - a.score);

  const topLayer = scoredLayers[0];
  const secondLayer = scoredLayers[1];

  if (totalContentLines === 0) {
    chosenLayer = 'unknown';
    layerConfidence = 'none';
  } else if (topLayer.score === 0) {
    // If there is code change with no specific wiring/runtime/use/form signals, it is scoped logic (local_meaning)
    chosenLayer = 'local_meaning';
    layerConfidence = 'medium';
    layerScores.matchedRules.push('default:scoped_code_change');
  } else if (secondLayer.score > 0 && (topLayer.score - secondLayer.score <= 1 || (topLayer.score / secondLayer.score < 1.35 && topLayer.score < 8))) {
    // Ambiguous between two top layers
    chosenLayer = 'unknown';
    layerConfidence = 'none';
    layerScores.matchedRules.push(`ambiguity:${topLayer.layer}_vs_${secondLayer.layer}`);
  } else {
    chosenLayer = topLayer.layer;
    layerConfidence = topLayer.score >= 5 ? 'high' : topLayer.score >= 2 ? 'medium' : 'low';
    layerScores.matchedRules.push(`dominant:${topLayer.layer}:${topLayer.score}`);
  }

  // Determine Lens
  let chosenLens: LensOutcome = 'unknown';
  const scoredLenses: { lens: ReviewLens; score: number }[] = REVIEW_LENSES.map(
    (lens) => ({ lens, score: lensScores[lens] })
  ).sort((a, b) => b.score - a.score);

  const topLens = scoredLenses[0];
  if (topLens.score >= 2) {
    chosenLens = topLens.lens;
    lensScores.matchedRules.push(`dominant:${topLens.lens}:${topLens.score}`);
  } else if (chosenLayer !== 'unknown') {
    // Correctness is the baseline lens for functional rework
    chosenLens = 'correctness';
    lensScores.matchedRules.push('default:correctness');
  } else {
    chosenLens = 'unknown';
  }

  const allRules = [...layerScores.matchedRules, ...lensScores.matchedRules];
  return {
    layer: chosenLayer,
    lens: chosenLens,
    cell: formatCell(chosenLayer, chosenLens),
    confidence: layerConfidence,
    matched_rules: allRules,
  };
}

// ── Bounded LLM Classifier ───────────────────────────────────────────────

export interface LlmCellClassifyInput {
  originalPr: PrRef;
  correctivePr: PrRef;
  diff: string;
}

export type LlmRunner = (prompt: string, systemPrompt?: string) => Promise<string>;

export const LLM_SYSTEM_PROMPT = `You are a defect classification engine.
Given the diff of a corrective/fix PR and metadata about the original PR it fixed, classify where the defect lived.

Classification Product Space:
1. LAYER:
   - form: style, formatting, whitespace, linter fixes, imports, comments.
   - local_meaning: localized single-function bug, condition, boundary check, null safety, math, local assertion.
   - wiring: interfaces, cross-module contracts, schema/migrations, configurations, registrations, route definitions.
   - runtime: concurrency, async/await, race conditions, locks, timeouts, memory/heap, process signals/lifecycle.
   - use: CLI flags, user error messages, documentation, user-facing prompt templates.
   - unknown: cannot be determined with confidence.

2. LENS:
   - correctness: functional defect, wrong return value, crash, broken assertion, exception.
   - security: authentication, authorization, secret exposure, injection, sanitization.
   - history: regression of previously working feature, merge conflict fallout, unintended revert.
   - reversibility: rollback, cleanup teardown, idempotency, soft-gate reversal.
   - unknown: cannot be determined with confidence.

You MUST respond strictly with a valid JSON object in this format:
{
  "layer": "form" | "local_meaning" | "wiring" | "runtime" | "use" | "unknown",
  "lens": "correctness" | "security" | "history" | "reversibility" | "unknown",
  "explanation": "one sentence explaining why"
}`;

export function buildLlmPrompt(input: LlmCellClassifyInput): string {
  const maxDiffLength = 16_000;
  const truncatedDiff = input.diff.length > maxDiffLength
    ? input.diff.slice(0, maxDiffLength) + '\n... [diff truncated for length]'
    : input.diff;

  return `Original PR: #${input.originalPr.number} "${input.originalPr.title ?? ''}"
Corrective PR: #${input.correctivePr.number} "${input.correctivePr.title ?? ''}"

Corrective Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Classify the defect layer and lens. Respond strictly with JSON.`;
}

export async function classifyWithLlm(
  input: LlmCellClassifyInput,
  runner?: LlmRunner,
  options?: { offline?: boolean },
): Promise<LlmOutcome | null> {
  if (options?.offline || !runner) {
    return null;
  }

  const prompt = buildLlmPrompt(input);
  let rawResponse = '';

  try {
    rawResponse = await runner(prompt, LLM_SYSTEM_PROMPT);
  } catch (err) {
    return {
      layer: 'unknown',
      lens: 'unknown',
      cell: 'unknown',
      error: `llm_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        layer: 'unknown',
        lens: 'unknown',
        cell: 'unknown',
        raw_response: rawResponse,
        error: 'llm_malformed_response: no JSON object found',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      layer?: string;
      lens?: string;
      explanation?: string;
    };

    const layer = (REVIEW_LAYERS as readonly string[]).includes(parsed.layer ?? '')
      ? (parsed.layer as ReviewLayer)
      : 'unknown';
    const lens = (REVIEW_LENSES as readonly string[]).includes(parsed.lens ?? '')
      ? (parsed.lens as ReviewLens)
      : 'unknown';

    return {
      layer,
      lens,
      cell: formatCell(layer, lens),
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : undefined,
      raw_response: rawResponse,
    };
  } catch (err) {
    return {
      layer: 'unknown',
      lens: 'unknown',
      cell: 'unknown',
      raw_response: rawResponse,
      error: `llm_malformed_response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export interface ReconcileOptions {
  offline?: boolean;
}

export interface ReconciledClassification {
  chosen: CellDecision;
  structural: StructuralOutcome;
  llm: LlmOutcome | null;
  agreement: boolean;
  disagreement_state: DisagreementState;
  reason_codes: CellReasonCode[];
}

export function reconcileClassification(
  structural: StructuralOutcome,
  llm: LlmOutcome | null,
  options?: ReconcileOptions,
): ReconciledClassification {
  const reason_codes: CellReasonCode[] = [];

  // Offline or no LLM
  if (options?.offline || llm === null) {
    if (options?.offline) {
      reason_codes.push('llm_skipped_offline');
    }
    const isKnown = structural.cell !== 'unknown';
    if (structural.confidence === 'high') {
      reason_codes.push('structural_signal_confident');
    } else if (isKnown) {
      reason_codes.push('structural_signal_heuristic');
    } else {
      reason_codes.push('structural_ambiguous_signals');
    }

    return {
      chosen: { layer: structural.layer, lens: structural.lens, cell: structural.cell },
      structural,
      llm: null,
      agreement: false,
      disagreement_state: 'structural_only',
      reason_codes,
    };
  }

  // LLM failed / unavailable
  if (llm.error) {
    if (llm.error.startsWith('llm_unavailable')) {
      reason_codes.push('llm_unavailable');
    } else {
      reason_codes.push('llm_malformed_response');
    }

    if (structural.confidence === 'high') {
      reason_codes.push('structural_signal_confident');
    }

    return {
      chosen: { layer: structural.layer, lens: structural.lens, cell: structural.cell },
      structural,
      llm,
      agreement: false,
      disagreement_state: 'llm_failed',
      reason_codes,
    };
  }

  const structuralKnown = structural.cell !== 'unknown';
  const llmKnown = llm.cell !== 'unknown';

  // Both unknown
  if (!structuralKnown && !llmKnown) {
    reason_codes.push('both_unknown');
    return {
      chosen: { layer: 'unknown', lens: 'unknown', cell: 'unknown' },
      structural,
      llm,
      agreement: true,
      disagreement_state: 'both_unknown',
      reason_codes,
    };
  }

  // Structural unknown, LLM known -> LLM fallback used
  if (!structuralKnown && llmKnown) {
    reason_codes.push('llm_fallback_used');
    return {
      chosen: { layer: llm.layer, lens: llm.lens, cell: llm.cell },
      structural,
      llm,
      agreement: false,
      disagreement_state: 'llm_only',
      reason_codes,
    };
  }

  // Structural known, LLM unknown
  if (structuralKnown && !llmKnown) {
    if (structural.confidence === 'high') {
      reason_codes.push('structural_signal_confident');
    } else {
      reason_codes.push('structural_signal_heuristic');
    }
    return {
      chosen: { layer: structural.layer, lens: structural.lens, cell: structural.cell },
      structural,
      llm,
      agreement: false,
      disagreement_state: 'structural_only',
      reason_codes,
    };
  }

  // Both known: check exact agreement
  if (structural.layer === llm.layer && structural.lens === llm.lens) {
    reason_codes.push('clean_agreement', 'llm_concurrence');
    return {
      chosen: { layer: structural.layer, lens: structural.lens, cell: structural.cell },
      structural,
      llm,
      agreement: true,
      disagreement_state: 'agree',
      reason_codes,
    };
  }

  // Both known, but disagree
  reason_codes.push('llm_disagreement');
  // Plan: "Use deterministic structural signals first; invoke the LLM only for the second opinion/fallback."
  if (structural.confidence === 'high') {
    reason_codes.push('structural_signal_confident', 'structural_override');
  } else {
    reason_codes.push('structural_signal_heuristic');
  }

  return {
    chosen: { layer: structural.layer, lens: structural.lens, cell: structural.cell },
    structural,
    llm,
    agreement: false,
    disagreement_state: 'disagree',
    reason_codes,
  };
}

// ── Original PR Review Evidence Enrichment ────────────────────────────────

export interface EnrichReviewEvidenceOptions {
  prNumber: number;
  issueId?: string;
  slug?: string;
  repoDir?: string;
}

export function enrichOriginalPrReviewEvidence(
  options: EnrichReviewEvidenceOptions,
): ReviewEvidence {
  const repoDir = options.repoDir ?? process.cwd();
  const reviewersRun = new Set<string>();
  const challengeStages = new Set<string>();
  const coverageFlags: string[] = [];
  const notes: string[] = [];
  let provenance: ReviewEvidence['provenance'] = 'unavailable';

  // Probe stage result using task-artifact-lookup
  if (options.issueId || options.slug) {
    try {
      const resolved = resolveTaskArtifact({
        issueId: options.issueId ?? '',
        slug: options.slug,
        // allow-stage-artifact-lookup: resolves review stage result via resolveTaskArtifact
        artifactName: '.review-result.json',
        repoDir,
      });

      if (resolved && existsSync(resolved.path)) {
        provenance = resolved.source === 'live' ? 'direct' : 'archived';
        coverageFlags.push(`review_artifact_${resolved.source}`);
        const parsed = JSON.parse(readFileSync(resolved.path, 'utf-8')) as {
          executedModel?: string;
          model?: string;
          agent?: string;
          challenge?: { stage?: string; role?: string };
        };

        const model = parsed.executedModel || parsed.model || parsed.agent;
        if (model) {
          reviewersRun.add(model);
        }
        if (parsed.challenge?.stage) {
          challengeStages.add(parsed.challenge.stage);
        }
      }
    } catch (err) {
      notes.push(`review_artifact_read_error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // If no artifact was located, record explicit unavailable coverage flag
  if (provenance === 'unavailable') {
    coverageFlags.push('missing_review_artifact');
    notes.push('Historical review evidence unavailable; absent evidence not inferred as unreviewed.');
  }

  return {
    reviewers_run: Array.from(reviewersRun),
    challenge_stages: Array.from(challengeStages),
    provenance,
    coverage_flags: coverageFlags,
    notes: notes.length > 0 ? notes : undefined,
  };
}
