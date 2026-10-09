/**
 * Soft Gates — non-blocking artifact inconsistency observer (HOK-2263)
 *
 * Wraps artifact-diagnostics.ts to map its findings onto stable public gate IDs,
 * and adds four new gate checks that have no counterpart in artifact-diagnostics.
 * All detection is best-effort and never throws. Emission appends structured
 * JSONL to .wavemill/logs/soft-gates.jsonl with cross-tick dedup.
 *
 * @module soft-gates
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnoseArtifacts, evalRecordMatchesTaskPair, type DiagnoseArtifactsOptions } from './artifact-diagnostics.ts';
import { appendJsonlRecord } from './jsonl-utils.ts';
import { mutateJsonState } from './state-mutex.ts';
import type { EvalRecord, FeatureOutcomeDiagnostics } from './eval-schema.ts';
import { resolveEvalsDir } from './evals-paths.ts';

// ── Public Types ──────────────────────────────────────────────────────────────

export type SoftGateId =
  | 'contract_source_hash_mismatch'
  | 'completion_without_evidence'
  | 'trace_linkage_missing'
  | 'outcome_divergence'
  | 'eval_export_inconsistency'
  | 'route_contract_mismatch'
  | 'ready_inconsistency'
  | 'fallback_verification_mismatch';

export type SoftGateSeverity = 'info' | 'warn' | 'error';

export interface SoftGateWarning {
  timestamp: string;
  issueId: string | null;
  slug: string | null;
  gate: SoftGateId;
  severity: SoftGateSeverity;
  artifacts: string[];
  expected: string;
  actual: string;
  detail: string;
  recommendedAction: string;
}

export interface EvaluateSoftGatesOptions {
  repoDir: string;
  taskId?: string;
  slug?: string;
  featureDir?: string;
}

export interface EmitSoftGatesResult {
  written: number;
  suppressed: number;
}

// ── Dedup fingerprint ──────────────────────────────────────────────────────────

function fingerprintWarning(w: SoftGateWarning): string {
  const key = [
    w.issueId ?? '',
    w.slug ?? '',
    w.gate,
    JSON.stringify(w.artifacts.slice().sort()),
    w.expected,
    w.actual,
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}

// ── Tolerant readers ──────────────────────────────────────────────────────────

function readJsonTolerant<T = Record<string, unknown>>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.trim()) return null;
    const parsed = JSON.parse(content) as T;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readJsonlTolerant<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const records: T[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as T);
      } catch {
        // skip malformed line
      }
    }
    return records;
  } catch {
    return [];
  }
}

function readEvalRecords(repoDir: string): EvalRecord[] {
  try {
    const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
    return readJsonlTolerant<EvalRecord>(join(evalsDir, 'evals.jsonl'));
  } catch {
    return [];
  }
}

// ── Gate: eval_export_inconsistency ──────────────────────────────────────────

const FEATURE_OUTCOME_ELIGIBILITY_ERRORS = new Set([
  'missing_feature_outcome',
  'invalid_feature_outcome',
  'failed_feature_outcome',
]);

function checkEvalExportInconsistency(
  featureDir: string,
  repoDir: string,
  taskId: string | null,
  slug: string | null,
): SoftGateWarning[] {
  const evalRecords = readEvalRecords(repoDir);
  if (evalRecords.length === 0) return [];

  const traceContextPath = join(featureDir, '.trace-context.json');
  const traceCtx = readJsonTolerant<Record<string, unknown>>(traceContextPath);
  const traceId = typeof traceCtx?.traceId === 'string' ? traceCtx.traceId : null;

  // Also get traceId from trace.jsonl first event
  let traceIdFromStream: string | null = null;
  if (!traceId) {
    const traceEvents = readJsonlTolerant<Record<string, unknown>>(join(featureDir, 'trace.jsonl'));
    if (traceEvents.length > 0 && typeof traceEvents[0].traceId === 'string') {
      traceIdFromStream = traceEvents[0].traceId as string;
    }
  }
  const resolvedTraceId = traceId ?? traceIdFromStream;

  const matchingEvals = evalRecords.filter(r => {
    if (resolvedTraceId && r.traceId === resolvedTraceId) return true;
    if (taskId && r.issueId === taskId) return true;
    return evalRecordMatchesTaskPair(r, taskId);
  });

  const warnings: SoftGateWarning[] = [];

  for (const record of matchingEvals) {
    if (record.trainingEligible !== true) continue;

    const diag = record.featureOutcomeDiagnostics as FeatureOutcomeDiagnostics | undefined;
    const eligibilityErrors = record.eligibilityErrors ?? [];

    // Check: eligible but featureOutcomeDiagnostics is missing/invalid
    const hasDiagnosticsIssue =
      !diag ||
      !diag.valid ||
      !diag.used ||
      (diag.missingFields && diag.missingFields.length > 0);

    const hasFeatureOutcomeError = eligibilityErrors.some(e =>
      FEATURE_OUTCOME_ELIGIBILITY_ERRORS.has(e),
    );

    const missingFields = diag?.missingFields ?? [];

    if (hasDiagnosticsIssue || hasFeatureOutcomeError) {
      const detail = hasFeatureOutcomeError
        ? `eval record is training eligible but eligibilityErrors include feature outcome errors: ${eligibilityErrors.filter(e => FEATURE_OUTCOME_ELIGIBILITY_ERRORS.has(e)).join(', ')}`
        : missingFields.length > 0
        ? `eval record is training eligible but normalized outcome has missing fields: ${missingFields.join(', ')}`
        : `eval record is training eligible but featureOutcomeDiagnostics is absent or invalid`;

      warnings.push({
        timestamp: new Date().toISOString(),
        issueId: record.issueId ?? taskId,
        slug,
        gate: 'eval_export_inconsistency',
        severity: 'warn',
        artifacts: [join(featureDir, 'feature-state.json')],
        expected: 'featureOutcomeDiagnostics.used=true with no missingFields',
        actual: diag ? `used=${String(diag.used)}, missingFields=[${missingFields.join(', ')}]` : 'absent',
        detail,
        recommendedAction: 'Re-derive feature-state.json and re-run eval enrichment to populate required label fields',
      });
    }
  }

  return warnings;
}

// ── Gate: route_contract_mismatch ─────────────────────────────────────────────

function checkRouteContractMismatch(
  featureDir: string,
  taskId: string | null,
  slug: string | null,
): SoftGateWarning[] {
  const contractPath = join(featureDir, 'task-contract.json');
  const contract = readJsonTolerant<Record<string, unknown>>(contractPath);
  if (!contract) return [];

  const sources = Array.isArray(contract.sources) ? contract.sources as Array<Record<string, unknown>> : [];
  if (sources.length === 0) return [];

  // Build a map from source path basename → sha256
  const contractHashes = new Map<string, string>();
  for (const src of sources) {
    if (typeof src.sha256 === 'string' && typeof src.path === 'string') {
      contractHashes.set(src.path as string, src.sha256 as string);
    }
  }

  if (contractHashes.size === 0) return [];

  const routeFiles = ['.initial-route.json', '.post-expansion-route.json'];
  const warnings: SoftGateWarning[] = [];

  for (const routeFile of routeFiles) {
    const routePath = join(featureDir, routeFile);
    const route = readJsonTolerant<Record<string, unknown>>(routePath);
    if (!route) continue;

    // Extract input hashes from route artifact
    const provenance = route.provenance as Record<string, unknown> | undefined;
    const routeInputHash = typeof provenance?.inputHash === 'string' ? provenance.inputHash as string : null;
    const routePacketHash = typeof route.packet_hash === 'string' ? route.packet_hash as string : null;

    if (!routeInputHash && !routePacketHash) continue;

    // Check if any route hash appears in the contract sources
    let matched = false;
    for (const [, contractHash] of contractHashes) {
      if (routeInputHash && routeInputHash === contractHash) { matched = true; break; }
      if (routePacketHash && routePacketHash === contractHash) { matched = true; break; }
    }

    if (!matched) {
      const routeHash = routeInputHash ?? routePacketHash ?? 'unknown';
      const contractHashList = [...contractHashes.values()].join(', ');
      warnings.push({
        timestamp: new Date().toISOString(),
        issueId: taskId,
        slug,
        gate: 'route_contract_mismatch',
        severity: 'warn',
        artifacts: [routePath, contractPath],
        expected: `route input hash to match one of contract source hashes: [${contractHashList}]`,
        actual: `route hash: ${routeHash}`,
        detail: `Route artifact ${routeFile} was computed from a task packet not projected by the active task-contract.json`,
        recommendedAction: 'Re-project task-contract.json or re-route from the current task packet',
      });
    }
  }

  return warnings;
}

// ── Gate: ready_inconsistency ─────────────────────────────────────────────────

function checkReadyInconsistency(
  featureDir: string,
  taskId: string | null,
  slug: string | null,
): SoftGateWarning[] {
  // Only check when the .ready-result.json file exists and explicitly passes.
  // Using feature-state.readyPassed alone would be circular self-validation.
  const readyResultPath = join(featureDir, '.ready-result.json');
  const readyResult = readJsonTolerant<Record<string, unknown>>(readyResultPath);
  if (!readyResult) return [];

  const readyResultArtifacts = readyResult.artifacts as Record<string, unknown> | undefined;
  const readyVerdictFromResult = readyResultArtifacts?.type === 'ready'
    ? readyResultArtifacts.verdict
    : undefined;

  const readyResultPassed =
    readyResult.status === 'completed' && readyVerdictFromResult === 'pass';

  if (!readyResultPassed) return [];

  // Read feature-state to cross-check
  const featureStatePath = join(featureDir, 'feature-state.json');
  const featureState = readJsonTolerant<Record<string, unknown>>(featureStatePath);

  // feature-state not present: can't cross-check, skip
  if (!featureState) return [];

  const outcome = featureState.outcome as Record<string, unknown> | undefined;

  // Mismatch: .ready-result.json passes but feature-state doesn't agree
  if (outcome?.readyPassed !== true) {
    return [{
      timestamp: new Date().toISOString(),
      issueId: taskId,
      slug,
      gate: 'ready_inconsistency',
      severity: 'warn',
      artifacts: [readyResultPath, featureStatePath],
      expected: 'feature-state.outcome.readyPassed=true',
      actual: `feature-state.outcome.readyPassed=${String(outcome?.readyPassed ?? 'absent')}`,
      detail: '.ready-result.json verdict is pass but feature-state.json outcome.readyPassed is not true',
      recommendedAction: 'Re-derive feature-state.json to synchronize ready evidence',
    }];
  }

  // Check that feature-state has at least one passing ready_check evidence entry
  const evidence = Array.isArray(featureState.evidence)
    ? featureState.evidence as Array<Record<string, unknown>>
    : [];

  const hasPassingReadyEvidence = evidence.some(
    e => e.kind === 'ready_check' && e.status === 'pass',
  );

  if (!hasPassingReadyEvidence) {
    return [{
      timestamp: new Date().toISOString(),
      issueId: taskId,
      slug,
      gate: 'ready_inconsistency',
      severity: 'warn',
      artifacts: [featureStatePath],
      expected: 'at least one evidence entry with kind=ready_check and status=pass',
      actual: `evidence has ${evidence.length} entries, none are passing ready_check`,
      detail: 'ready check result passed but feature-state.json has no passing ready evidence entry',
      recommendedAction: 'Re-derive feature-state.json to include ready_check evidence',
    }];
  }

  return [];
}

// ── Gate: fallback_verification_mismatch ──────────────────────────────────────

function checkFallbackVerificationMismatch(
  featureDir: string,
  taskId: string | null,
  slug: string | null,
): SoftGateWarning[] {
  const tracePath = join(featureDir, 'trace.jsonl');
  const traceEvents = readJsonlTolerant<Record<string, unknown>>(tracePath);
  if (traceEvents.length === 0) return [];

  const fallbackEvents = traceEvents.filter(e => e.event === 'fallback_used');
  if (fallbackEvents.length === 0) return [];

  // Check feature-state for safeguards
  const featureStatePath = join(featureDir, 'feature-state.json');
  const featureState = readJsonTolerant<Record<string, unknown>>(featureStatePath);

  // Check route artifacts for model-level fallback
  const routeFiles = ['.initial-route.json', '.post-expansion-route.json'];
  const fallbackModels = new Set<string>();
  for (const routeFile of routeFiles) {
    const route = readJsonTolerant<Record<string, unknown>>(join(featureDir, routeFile));
    if (!route) continue;
    const provenance = route.provenance as Record<string, unknown> | undefined;
    if (provenance?.routerMode === 'fallback' || provenance?.source === 'fallback') {
      const model = typeof route.model === 'string' ? route.model : null;
      if (model) fallbackModels.add(model);
    }
  }

  // Evidence of added safeguards: blockers, failing evidence, or specific review evidence
  const blockers = Array.isArray(featureState?.blockers) ? featureState.blockers as Array<Record<string, unknown>> : [];
  const evidence = Array.isArray(featureState?.evidence) ? featureState.evidence as Array<Record<string, unknown>> : [];

  const hasBlocker = blockers.length > 0;
  const hasFallbackEvidence = evidence.some(
    e => e.status === 'fail' || e.kind === 'blocked_completion',
  );

  // Check for a review stage that passed (compensation via review)
  const reviewPassed = (featureState?.outcome as Record<string, unknown> | undefined)?.reviewPassed === true;

  if (!hasBlocker && !hasFallbackEvidence && !reviewPassed) {
    const fallbackCount = fallbackEvents.length;
    return [{
      timestamp: new Date().toISOString(),
      issueId: taskId,
      slug,
      gate: 'fallback_verification_mismatch',
      severity: 'warn',
      artifacts: [tracePath, featureStatePath],
      expected: 'feature-state to show added safeguards (blockers, fail evidence, or review pass) when fallback models were used',
      actual: `${fallbackCount} fallback_used trace event(s) with no compensating safeguards in feature-state`,
      detail: `trace.jsonl records ${fallbackCount} fallback_used event(s) but feature-state shows no added verification safeguards`,
      recommendedAction: 'Verify that fallback model usage was acceptable, or ensure review stage is triggered when fallback models are used',
    }];
  }

  return [];
}

// ── Mapping: artifact-diagnostics findings → soft gate warnings ───────────────

import type { ArtifactDiagnosticFinding } from './artifact-diagnostics.ts';

function mapFindingToWarning(
  finding: ArtifactDiagnosticFinding,
  taskId: string | null,
  slug: string | null,
  featureDir: string,
): SoftGateWarning | null {
  const artifacts: string[] = finding.file ? [finding.file] : [];

  switch (finding.code) {
    case 'contract_hash_drift': {
      const details = finding.details as { sourcePath?: string; storedSha256?: string; currentSha256?: string } | undefined;
      return {
        timestamp: new Date().toISOString(),
        issueId: taskId,
        slug,
        gate: 'contract_source_hash_mismatch',
        severity: 'warn',
        artifacts,
        expected: `sha256=${details?.storedSha256 ?? 'stored'}`,
        actual: `sha256=${details?.currentSha256 ?? 'current'}`,
        detail: finding.message,
        recommendedAction: 'Re-project task-contract.json from the current source files',
      };
    }
    case 'coding_complete_without_evidence': {
      return {
        timestamp: new Date().toISOString(),
        issueId: taskId,
        slug,
        gate: 'completion_without_evidence',
        severity: 'warn',
        artifacts,
        expected: 'at least one non-marker passing evidence entry in feature-state',
        actual: 'coding complete marker exists with no passing evidence beyond legacy markers',
        detail: finding.message,
        recommendedAction: 'Investigate whether the coding stage produced verifiable output',
      };
    }
    case 'trace_id_missing': {
      const details = finding.details as { traceId?: string; artifactClass?: string; stages?: string[] } | undefined;
      return {
        timestamp: new Date().toISOString(),
        issueId: taskId,
        slug,
        gate: 'trace_linkage_missing',
        severity: 'info',
        artifacts,
        expected: `traceId=${details?.traceId ?? 'present'} in ${details?.artifactClass ?? 'artifact'}`,
        actual: 'traceId absent from artifact',
        detail: finding.message,
        recommendedAction: 'Ensure route/stage artifacts are written with the active traceId',
      };
    }
    case 'feature_outcome_state_mismatch': {
      const details = finding.details as Record<string, unknown> | undefined;
      return {
        timestamp: new Date().toISOString(),
        issueId: taskId,
        slug,
        gate: 'outcome_divergence',
        severity: 'warn',
        artifacts,
        expected: String(details?.workflowPhase ?? details?.workflowStatus ?? 'consistent'),
        actual: String(details?.featurePhase ?? details?.featureNormalizedState ?? 'diverged'),
        detail: finding.message,
        recommendedAction: 'Investigate discrepancy between workflow-state.json and feature-state.json',
      };
    }
    default:
      return null;
  }
}

// ── Core detection ────────────────────────────────────────────────────────────

/**
 * Evaluate all soft gates for a given feature and return warnings.
 * Pure detection — does not write or emit. Never throws.
 */
export function evaluateSoftGates(options: EvaluateSoftGatesOptions): SoftGateWarning[] {
  const repoDir = resolve(options.repoDir);
  const warnings: SoftGateWarning[] = [];

  let diagOptions: DiagnoseArtifactsOptions = { repoDir };
  if (options.taskId) diagOptions.taskId = options.taskId;
  if (options.slug) diagOptions.slug = options.slug;
  if (options.featureDir) diagOptions.featureDir = options.featureDir;

  let report: ReturnType<typeof diagnoseArtifacts>;
  try {
    report = diagnoseArtifacts(diagOptions);
  } catch {
    return [];
  }

  const { featureDir, taskId, slug } = report;

  // Map reusable findings from artifact-diagnostics
  for (const finding of report.findings) {
    try {
      const mapped = featureDir ? mapFindingToWarning(finding, taskId, slug, featureDir) : null;
      if (mapped) warnings.push(mapped);
    } catch {
      // best-effort
    }
  }

  if (!featureDir) return warnings;

  // New gates
  try {
    warnings.push(...checkEvalExportInconsistency(featureDir, repoDir, taskId, slug));
  } catch {
    // best-effort
  }

  try {
    warnings.push(...checkRouteContractMismatch(featureDir, taskId, slug));
  } catch {
    // best-effort
  }

  try {
    warnings.push(...checkReadyInconsistency(featureDir, taskId, slug));
  } catch {
    // best-effort
  }

  try {
    warnings.push(...checkFallbackVerificationMismatch(featureDir, taskId, slug));
  } catch {
    // best-effort
  }

  return warnings;
}

// ── Emission ──────────────────────────────────────────────────────────────────

const SOFT_GATES_LOG = '.wavemill/logs/soft-gates.jsonl';
const SOFT_GATES_SEEN = '.wavemill/logs/.soft-gates-seen.json';

/**
 * Append new warnings to the JSONL log, suppressing already-seen fingerprints.
 * Returns counts of written and suppressed warnings.
 */
export async function emitSoftGates(
  warnings: SoftGateWarning[],
  options: { repoDir: string; noEmit?: boolean },
): Promise<EmitSoftGatesResult> {
  if (warnings.length === 0) return { written: 0, suppressed: 0 };

  const repoDir = resolve(options.repoDir);
  const logPath = join(repoDir, SOFT_GATES_LOG);
  const seenPath = join(repoDir, SOFT_GATES_SEEN);

  let seenFingerprints: Set<string>;
  if (options.noEmit) {
    try {
      const current = existsSync(seenPath)
        ? JSON.parse(readFileSync(seenPath, 'utf-8')) as Record<string, boolean>
        : {};
      seenFingerprints = new Set(Object.keys(current));
    } catch {
      seenFingerprints = new Set();
    }
  } else {
    try {
      const current = await mutateJsonState<Record<string, boolean>>(
        seenPath,
        s => s,
        { createIfMissing: true, initial: {} },
      );
      seenFingerprints = new Set(Object.keys(current));
    } catch {
      seenFingerprints = new Set();
    }
  }

  let written = 0;
  let suppressed = 0;
  const newFingerprints: string[] = [];

  for (const warning of warnings) {
    const fp = fingerprintWarning(warning);
    if (seenFingerprints.has(fp)) {
      suppressed++;
      continue;
    }

    if (!options.noEmit) {
      try {
        appendJsonlRecord(logPath, warning);
      } catch {
        // best-effort
      }

      // Print grep-friendly line
      const artifactStr = warning.artifacts[0] ?? '';
      process.stdout.write(
        `soft-gate.warning issue=${warning.issueId ?? 'unknown'} gate=${warning.gate} severity=${warning.severity} artifact=${artifactStr} detail="${warning.detail}"\n`,
      );
    }

    seenFingerprints.add(fp);
    newFingerprints.push(fp);
    written++;
  }

  // Persist new fingerprints
  if (newFingerprints.length > 0 && !options.noEmit) {
    try {
      await mutateJsonState<Record<string, boolean>>(
        seenPath,
        current => {
          const next = { ...current };
          for (const fp of newFingerprints) {
            next[fp] = true;
          }
          return next;
        },
        { createIfMissing: true, initial: {} },
      );
    } catch {
      // best-effort
    }
  }

  return { written, suppressed };
}

/**
 * Convenience wrapper: evaluate + emit soft gates for a feature.
 * Never throws.
 */
export async function checkAndEmitSoftGates(
  options: EvaluateSoftGatesOptions & { noEmit?: boolean },
): Promise<{ warnings: SoftGateWarning[] } & EmitSoftGatesResult> {
  let warnings: SoftGateWarning[] = [];
  try {
    warnings = evaluateSoftGates(options);
  } catch {
    // best-effort
  }

  try {
    const result = await emitSoftGates(warnings, { repoDir: options.repoDir, noEmit: options.noEmit });
    return { warnings, ...result };
  } catch {
    return { warnings, written: 0, suppressed: 0 };
  }
}
