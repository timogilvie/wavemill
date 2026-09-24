/**
 * HOK-2081 runtime gate.
 *
 * Reads the HOK-2080 gate artifact and reports whether counterfactual
 * exploration may proceed. The gate is a first-class invariant: no live
 * counterfactual run may execute unless the upstream tool-choice signal
 * analysis (HOK-2080) records a `"go"` decision, and the referenced report's
 * SHA-256 hash matches what the operator signed.
 *
 * Callers use the `enabled` boolean and, on refusal, the machine-readable
 * `reason` to explain why. A `--dry-run` code path in the CLI is explicitly
 * allowed to run regardless (see `tools/run-counterfactual-exploration.ts`).
 *
 * @module native-agent/hok2081-gate
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Machine-readable reasons the gate refused to enable counterfactual runs.
 * Additive: readers must tolerate unknown codes.
 */
export type Hok2081GateRefusalReason =
  | 'gate_artifact_missing'
  | 'gate_artifact_unreadable'
  | 'gate_artifact_malformed'
  | 'gate_decision_not_go'
  | 'gate_issue_id_mismatch'
  | 'gate_report_missing'
  | 'gate_report_hash_mismatch';

/** Shape of the on-disk HOK-2080 gate artifact. */
export interface Hok2081GateArtifact {
  /** Must be exactly `"HOK-2080"`. */
  issueId: string;
  /** Explicit decision recorded by the analyst. */
  decision: 'go' | 'no-go' | 'inconclusive';
  /** ISO-8601 timestamp when the decision was recorded. */
  decidedAt: string;
  /** Free-form identifier of the operator who signed the decision. */
  decidedBy?: string;
  /** Repository-relative path to the corresponding analysis report. */
  reportPath?: string;
  /** SHA-256 hex digest of the report at signing time. Required for `go`. */
  reportSha256?: string;
  /** Optional operator signature blob. Unvalidated here. */
  operatorSignature?: string;
}

/**
 * Discriminated union describing the gate's state.
 *
 * `enabled: true` means every checked-in invariant holds and the CLI may run
 * live counterfactual exploration. `enabled: false` carries a stable
 * `reason` code plus a human-readable `message` for logging.
 */
export type Hok2081GateResult =
  | { enabled: true; artifact: Hok2081GateArtifact; source: string }
  | { enabled: false; reason: Hok2081GateRefusalReason; message: string; source?: string };

const DEFAULT_GATE_PATH = '.wavemill/gates/HOK-2080.json';
const EXPECTED_ISSUE_ID = 'HOK-2080';

/**
 * Resolve the checked-in gate artifact path, honoring the
 * `WAVEMILL_HOK2080_GATE_PATH` env override for CI escape hatches.
 */
export function resolveGateArtifactPath(repoDir?: string): string {
  const override = process.env.WAVEMILL_HOK2080_GATE_PATH?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(repoDir ?? process.cwd(), override);
  }
  return resolve(repoDir ?? process.cwd(), DEFAULT_GATE_PATH);
}

function parseArtifact(text: string): Hok2081GateArtifact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.issueId !== 'string') return null;
  if (
    record.decision !== 'go'
    && record.decision !== 'no-go'
    && record.decision !== 'inconclusive'
  ) {
    return null;
  }
  if (typeof record.decidedAt !== 'string') return null;
  return {
    issueId: record.issueId,
    decision: record.decision,
    decidedAt: record.decidedAt,
    decidedBy: typeof record.decidedBy === 'string' ? record.decidedBy : undefined,
    reportPath: typeof record.reportPath === 'string' ? record.reportPath : undefined,
    reportSha256: typeof record.reportSha256 === 'string' ? record.reportSha256 : undefined,
    operatorSignature:
      typeof record.operatorSignature === 'string' ? record.operatorSignature : undefined,
  };
}

/**
 * Read the raw gate artifact and return it, or `null` on any missing/malformed
 * state. This is a lower-level API; most callers should use
 * {@link isCounterfactualExplorationEnabled} which folds every check into a
 * single result.
 */
export function readGateArtifact(repoDir?: string): {
  path: string;
  artifact: Hok2081GateArtifact | null;
  raw: string | null;
} {
  const path = resolveGateArtifactPath(repoDir);
  if (!existsSync(path)) {
    return { path, artifact: null, raw: null };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { path, artifact: null, raw: null };
  }
  return { path, artifact: parseArtifact(raw), raw };
}

function hashFile(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compute whether counterfactual exploration may proceed for a repo.
 *
 * The gate enables only when every invariant below holds simultaneously:
 *   - the artifact exists at the resolved path,
 *   - the file parses as JSON in the expected shape,
 *   - `issueId === "HOK-2080"`,
 *   - `decision === "go"`,
 *   - if a `reportPath` is declared, the file exists and its SHA-256 matches
 *     `reportSha256` (this is the tamper-evidence tie between the recorded
 *     Go and the report the operator inspected).
 */
export function isCounterfactualExplorationEnabled(repoDir?: string): Hok2081GateResult {
  const { path, artifact, raw } = readGateArtifact(repoDir);

  if (raw === null) {
    return {
      enabled: false,
      reason: 'gate_artifact_missing',
      message: `HOK-2080 gate artifact not found at ${path}`,
      source: path,
    };
  }

  if (!artifact) {
    return {
      enabled: false,
      reason: 'gate_artifact_malformed',
      message: `HOK-2080 gate artifact at ${path} is malformed or missing required fields`,
      source: path,
    };
  }

  if (artifact.issueId !== EXPECTED_ISSUE_ID) {
    return {
      enabled: false,
      reason: 'gate_issue_id_mismatch',
      message: `Expected issueId "${EXPECTED_ISSUE_ID}", found "${artifact.issueId}" in ${path}`,
      source: path,
    };
  }

  if (artifact.decision !== 'go') {
    return {
      enabled: false,
      reason: 'gate_decision_not_go',
      message: `HOK-2080 gate decision is "${artifact.decision}", not "go" (${path})`,
      source: path,
    };
  }

  if (artifact.reportPath) {
    const reportAbs = isAbsolute(artifact.reportPath)
      ? artifact.reportPath
      : join(repoDir ?? process.cwd(), artifact.reportPath);
    if (!existsSync(reportAbs)) {
      return {
        enabled: false,
        reason: 'gate_report_missing',
        message: `HOK-2080 gate references report ${artifact.reportPath} but it does not exist`,
        source: path,
      };
    }
    if (artifact.reportSha256) {
      const observed = hashFile(reportAbs);
      if (observed !== artifact.reportSha256) {
        return {
          enabled: false,
          reason: 'gate_report_hash_mismatch',
          message: `HOK-2080 gate report hash mismatch: expected ${artifact.reportSha256}, observed ${observed ?? '<unreadable>'}`,
          source: path,
        };
      }
    }
  }

  return { enabled: true, artifact, source: path };
}
