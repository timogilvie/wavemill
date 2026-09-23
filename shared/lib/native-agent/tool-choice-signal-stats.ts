/**
 * Tool-choice signal statistics (HOK-2080).
 *
 * Small, defensible estimator suite for the P2 hypothesis test. Explicitly
 * observational-first: DR/IPS is available but refuses to run on rows that
 * lack `exact` propensity provenance. All results are tagged with propensity
 * basis so surrogate/exact/provider_reported are never merged.
 *
 * Methods:
 *  - stratified per-cell success-rate contrasts with normal-approx CIs;
 *  - binary logistic regression via Newton-Raphson (IRLS) on a handful of
 *    covariates — own implementation, no new deps;
 *  - nonparametric cluster bootstrap over traces (decisions within a trace
 *    are dependent; i.i.d. bootstrap would understate CIs);
 *  - self-normalized IPS + a doubly-robust wrapper that requires exact
 *    propensity and returns a refusal shape otherwise.
 *
 * The estimator is deterministic with a seeded RNG (LCG).
 */

import type { ToolDecisionRow } from './tool-decision-schema.ts';
import type { TraceCovariates } from './tool-choice-outcome-join.ts';

// ---------------------------------------------------------------------------
// Seeded RNG (LCG — sufficient for bootstrap; not for security)
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  // Numerical Recipes LCG constants.
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

export interface CellCount {
  key: string;
  n: number;
  successes: number;
  successRate: number;
  ci95: [number, number];
}

export interface ContrastResult {
  label: string;
  treatmentKey: string;
  controlKey: string;
  treatment: CellCount;
  control: CellCount;
  /** Absolute difference in success rate (treatment − control). */
  diff: number;
  /** Bootstrap CI on the diff (cluster-by-trace). */
  diffCi95: [number, number];
  /** True when the CI excludes zero. */
  significant: boolean;
  gated?: 'insufficient_cell_size';
}

export interface StratifiedResult {
  cells: CellCount[];
  contrasts: ContrastResult[];
  minCellSize: number;
}

// ---------------------------------------------------------------------------
// Basic descriptives
// ---------------------------------------------------------------------------

function isSuccess(row: ToolDecisionRow): number {
  return row.result?.status === 'success' ? 1 : 0;
}

function ciWald(p: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const se = Math.sqrt(Math.max(p * (1 - p), 0) / n);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
}

function toCellCount(key: string, rows: ToolDecisionRow[]): CellCount {
  const n = rows.length;
  const successes = rows.reduce((s, r) => s + isSuccess(r), 0);
  const rate = n === 0 ? 0 : successes / n;
  return { key, n, successes, successRate: rate, ci95: ciWald(rate, n) };
}

// ---------------------------------------------------------------------------
// Cluster bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapOpts {
  iterations: number;
  seed: number;
}

const DEFAULT_BOOTSTRAP: BootstrapOpts = { iterations: 400, seed: 20260923 };

function bootstrapDiffCi(
  treatmentRows: ToolDecisionRow[],
  controlRows: ToolDecisionRow[],
  opts: BootstrapOpts = DEFAULT_BOOTSTRAP,
): [number, number] {
  // Cluster by trace: sample the set of trace-ids with replacement, then
  // recompute per-cell rates only on the sampled clusters.
  const rng = makeRng(opts.seed);
  const rowsByTrace = new Map<string, ToolDecisionRow[]>();
  for (const r of [...treatmentRows, ...controlRows]) {
    const b = rowsByTrace.get(r.traceId) ?? [];
    b.push(r);
    rowsByTrace.set(r.traceId, b);
  }
  const traceIds = [...rowsByTrace.keys()];
  if (traceIds.length === 0) return [0, 0];
  const diffs: number[] = [];
  const treatmentKeys = new Set(treatmentRows.map((r) => r.decisionId));
  for (let i = 0; i < opts.iterations; i++) {
    let tN = 0, tS = 0, cN = 0, cS = 0;
    for (let j = 0; j < traceIds.length; j++) {
      const idx = Math.floor(rng() * traceIds.length);
      const bucket = rowsByTrace.get(traceIds[idx])!;
      for (const row of bucket) {
        const s = isSuccess(row);
        if (treatmentKeys.has(row.decisionId)) {
          tN += 1; tS += s;
        } else {
          cN += 1; cS += s;
        }
      }
    }
    const tRate = tN === 0 ? 0 : tS / tN;
    const cRate = cN === 0 ? 0 : cS / cN;
    diffs.push(tRate - cRate);
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor(0.025 * diffs.length)] ?? 0;
  const hi = diffs[Math.floor(0.975 * diffs.length)] ?? 0;
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// Stratified contrasts (cell = phase × model × menu-digest × prior-error)
// ---------------------------------------------------------------------------

export interface StratifyOpts {
  minCellSize?: number;
  bootstrap?: BootstrapOpts;
}

function cellKey(row: ToolDecisionRow): string {
  const menu = row.toolMenu?.digest ?? 'no_menu';
  const priorErr = row.state.priorErrorFlag ? 'e1' : 'e0';
  return `${row.phase}|${row.model}|${menu}|${priorErr}`;
}

/**
 * Contrast tool-choice values within a cell. For each cell that has ≥ two
 * chosen-tool categories with sufficient rows, emit a contrast between the
 * two most-frequent tool choices; other tool contrasts are gated out with a
 * `gated: 'insufficient_cell_size'` tag.
 */
export function stratifiedContrasts(
  rows: ToolDecisionRow[],
  opts: StratifyOpts = {},
): StratifiedResult {
  const minCell = opts.minCellSize ?? 30;
  const boot = opts.bootstrap ?? DEFAULT_BOOTSTRAP;

  const byCell = new Map<string, ToolDecisionRow[]>();
  for (const row of rows) {
    if (row.kind !== 'tool_call' && row.kind !== 'forced_tool_call') continue;
    if (!row.chosenTool) continue;
    const key = cellKey(row);
    const bucket = byCell.get(key) ?? [];
    bucket.push(row);
    byCell.set(key, bucket);
  }
  const cellCounts: CellCount[] = [];
  const contrasts: ContrastResult[] = [];
  for (const [cell, cellRows] of byCell) {
    cellCounts.push(toCellCount(cell, cellRows));
    if (cellRows.length < minCell) {
      // Emit a gated contrast for reporter visibility.
      contrasts.push({
        label: cell,
        treatmentKey: 'n/a',
        controlKey: 'n/a',
        treatment: toCellCount('n/a', []),
        control: toCellCount('n/a', []),
        diff: 0,
        diffCi95: [0, 0],
        significant: false,
        gated: 'insufficient_cell_size',
      });
      continue;
    }
    // Two most-frequent chosen tools in this cell.
    const byTool = new Map<string, ToolDecisionRow[]>();
    for (const r of cellRows) {
      const tool = r.chosenTool!;
      const b = byTool.get(tool) ?? [];
      b.push(r);
      byTool.set(tool, b);
    }
    const sortedTools = [...byTool.entries()].sort((a, b) => b[1].length - a[1].length);
    if (sortedTools.length < 2) continue;
    const [treatment, control] = sortedTools;
    const tCount = toCellCount(treatment[0], treatment[1]);
    const cCount = toCellCount(control[0], control[1]);
    const diff = tCount.successRate - cCount.successRate;
    const diffCi = bootstrapDiffCi(treatment[1], control[1], boot);
    const significant = diffCi[0] > 0 || diffCi[1] < 0;
    contrasts.push({
      label: cell,
      treatmentKey: treatment[0],
      controlKey: control[0],
      treatment: tCount,
      control: cCount,
      diff,
      diffCi95: diffCi,
      significant,
    });
  }
  return { cells: cellCounts, contrasts, minCellSize: minCell };
}

// ---------------------------------------------------------------------------
// Logistic regression via IRLS (Newton-Raphson)
// ---------------------------------------------------------------------------

export interface LogisticFit {
  coefficients: number[];
  featureNames: string[];
  iterations: number;
  converged: boolean;
  logLikelihood: number;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Solve A x = b via Gaussian elimination with partial pivoting.
 * A is destroyed. Returns null when singular.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    }
    if (Math.abs(M[pivot][i]) < 1e-12) return null;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    for (let r = i + 1; r < n; r++) {
      const factor = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    x[i] = s / M[i][i];
  }
  return x;
}

export interface LogisticInput {
  /** [n_samples][n_features]. Include a constant column for intercept. */
  X: number[][];
  /** Binary labels 0/1. Length = n_samples. */
  y: number[];
  featureNames: string[];
  maxIter?: number;
  tolerance?: number;
  ridge?: number;
}

export function fitLogistic(input: LogisticInput): LogisticFit {
  const { X, y, featureNames } = input;
  const maxIter = input.maxIter ?? 50;
  const tolerance = input.tolerance ?? 1e-6;
  const ridge = input.ridge ?? 1e-6;
  const n = X.length;
  const p = featureNames.length;
  let beta = new Array(p).fill(0);
  let iterations = 0;
  let converged = false;
  let logLikelihood = -Infinity;
  for (let it = 0; it < maxIter; it++) {
    // Compute predictions, residuals, and Hessian.
    const w = new Array(n).fill(0);
    const r = new Array(n).fill(0);
    let ll = 0;
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < p; j++) z += beta[j] * X[i][j];
      const pi = sigmoid(z);
      w[i] = Math.max(pi * (1 - pi), 1e-9);
      r[i] = y[i] - pi;
      ll += y[i] * Math.log(Math.max(pi, 1e-12)) + (1 - y[i]) * Math.log(Math.max(1 - pi, 1e-12));
    }
    logLikelihood = ll;
    // Gradient and Hessian (with ridge).
    const grad = new Array(p).fill(0);
    const H: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let j = 0; j < p; j++) {
      for (let i = 0; i < n; i++) grad[j] += X[i][j] * r[i];
      grad[j] -= ridge * beta[j];
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k <= j; k++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += w[i] * X[i][j] * X[i][k];
        s += j === k ? ridge : 0;
        H[j][k] = -s;
        H[k][j] = -s;
      }
    }
    // Solve H * delta = -grad → delta = -H^-1 grad.
    const negGrad = grad.map((g) => -g);
    const delta = solveLinearSystem(H.map((row) => [...row]), negGrad);
    if (!delta) break;
    let maxAbs = 0;
    for (let j = 0; j < p; j++) {
      beta[j] += delta[j];
      maxAbs = Math.max(maxAbs, Math.abs(delta[j]));
    }
    iterations = it + 1;
    if (maxAbs < tolerance) {
      converged = true;
      break;
    }
  }
  return { coefficients: beta, featureNames, iterations, converged, logLikelihood };
}

// ---------------------------------------------------------------------------
// IPS / Doubly-Robust with strict provenance gating
// ---------------------------------------------------------------------------

export type OffPolicyResult =
  | {
      eligibleRows: number;
      estimate: number;
      seEstimate: number;
      basis: 'exact';
      method: 'ips' | 'dr';
      refused?: false;
    }
  | {
      eligibleRows: 0;
      refused: true;
      reason: string;
      basis: 'exact' | 'provider_reported' | 'surrogate' | 'unavailable' | 'mixed';
    };

/**
 * Self-normalized IPS on the reward: E[r * (I[a=target] / p(a|x))].
 * Uses only rows whose propensity is `exact`. Refuses otherwise.
 */
export function selfNormalizedIps(
  rows: ToolDecisionRow[],
  targetTool: string,
): OffPolicyResult {
  const exact = rows.filter((r) => r.propensity.provenance === 'exact');
  if (exact.length === 0) {
    const anyProv = new Set(rows.map((r) => r.propensity.provenance));
    return {
      eligibleRows: 0,
      refused: true,
      reason: 'no_exact_propensity_rows',
      basis: anyProv.size === 1 ? [...anyProv][0] : 'mixed',
    };
  }
  let num = 0;
  let den = 0;
  const summands: number[] = [];
  for (const row of exact) {
    const p = row.propensity.distribution?.[row.chosenTool ?? ''];
    if (typeof p !== 'number' || p <= 0) continue;
    if (row.chosenTool !== targetTool) continue;
    const w = 1 / p;
    const r = isSuccess(row);
    num += w * r;
    den += w;
    summands.push(w * r);
  }
  const estimate = den === 0 ? 0 : num / den;
  // Rough SE from summand spread (self-normalized weights).
  const meanW = summands.length === 0 ? 0 : summands.reduce((a, b) => a + b, 0) / summands.length;
  const varW =
    summands.length === 0
      ? 0
      : summands.reduce((a, b) => a + (b - meanW) ** 2, 0) / Math.max(summands.length - 1, 1);
  const seEstimate = summands.length === 0 ? 0 : Math.sqrt(varW / summands.length);
  return {
    eligibleRows: exact.length,
    estimate,
    seEstimate,
    basis: 'exact',
    method: 'ips',
  };
}

/**
 * Doubly-robust wrapper: same gating as IPS, plus a supplied outcome model
 * predictor `qHat(row, tool)`. The formula:
 *   DR = E[qHat(x, targetTool)] + E[(I[a=target]/p) * (r - qHat(x, a))]
 * Reduces bias when the outcome model is correct; still refuses without
 * exact propensity.
 */
export function doublyRobust(
  rows: ToolDecisionRow[],
  targetTool: string,
  qHat: (row: ToolDecisionRow, tool: string) => number,
): OffPolicyResult {
  const exact = rows.filter((r) => r.propensity.provenance === 'exact');
  if (exact.length === 0) {
    const anyProv = new Set(rows.map((r) => r.propensity.provenance));
    return {
      eligibleRows: 0,
      refused: true,
      reason: 'no_exact_propensity_rows',
      basis: anyProv.size === 1 ? [...anyProv][0] : 'mixed',
    };
  }
  let baselineSum = 0;
  let correctionSum = 0;
  const summands: number[] = [];
  for (const row of exact) {
    const p = row.propensity.distribution?.[row.chosenTool ?? ''];
    if (typeof p !== 'number' || p <= 0) continue;
    const q0 = qHat(row, targetTool);
    baselineSum += q0;
    if (row.chosenTool === targetTool) {
      const r = isSuccess(row);
      const term = (1 / p) * (r - qHat(row, row.chosenTool!));
      correctionSum += term;
      summands.push(q0 + term);
    } else {
      summands.push(q0);
    }
  }
  const N = exact.length;
  const estimate = N === 0 ? 0 : (baselineSum + correctionSum) / N;
  const meanS = summands.length === 0 ? 0 : summands.reduce((a, b) => a + b, 0) / summands.length;
  const varS =
    summands.length === 0
      ? 0
      : summands.reduce((a, b) => a + (b - meanS) ** 2, 0) / Math.max(summands.length - 1, 1);
  const seEstimate = summands.length === 0 ? 0 : Math.sqrt(varS / summands.length);
  return {
    eligibleRows: N,
    estimate,
    seEstimate,
    basis: 'exact',
    method: 'dr',
  };
}

// ---------------------------------------------------------------------------
// Sensitivity helper: leave-one-model-out / leave-one-issue-out
// ---------------------------------------------------------------------------

export interface SensitivityAnalysis {
  perModel: Array<{ leftOut: string; contrastMean: number; sig: number }>;
  perIssue: Array<{ leftOut: string; contrastMean: number; sig: number }>;
}

export function sensitivitySweep(
  rows: ToolDecisionRow[],
  runContrasts: (r: ToolDecisionRow[]) => StratifiedResult,
): SensitivityAnalysis {
  const models = new Set(rows.map((r) => r.model));
  const issues = new Set(rows.map((r) => r.outcome?.issue).filter((x): x is string => !!x));
  const perModel: SensitivityAnalysis['perModel'] = [];
  const perIssue: SensitivityAnalysis['perIssue'] = [];
  for (const m of models) {
    const filtered = rows.filter((r) => r.model !== m);
    const res = runContrasts(filtered);
    const summarized = summarizeContrasts(res);
    perModel.push({ leftOut: m, ...summarized });
  }
  for (const iss of issues) {
    const filtered = rows.filter((r) => r.outcome?.issue !== iss);
    const res = runContrasts(filtered);
    const summarized = summarizeContrasts(res);
    perIssue.push({ leftOut: iss, ...summarized });
  }
  return { perModel, perIssue };
}

function summarizeContrasts(res: StratifiedResult): { contrastMean: number; sig: number } {
  const kept = res.contrasts.filter((c) => !c.gated);
  if (kept.length === 0) return { contrastMean: 0, sig: 0 };
  const mean = kept.reduce((s, c) => s + c.diff, 0) / kept.length;
  const sig = kept.filter((c) => c.significant).length;
  return { contrastMean: mean, sig };
}

// ---------------------------------------------------------------------------
// Covariate-controlled convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Fit a logistic on tool-success ∼ intercept + model dummies + phase dummies
 * + priorErrorFlag + tool dummies. Returns coefficients for the tool dummies
 * so the caller can spot systematic tool effects after controls.
 */
export interface ControlledFitOutcome {
  fit: LogisticFit;
  toolTermIndexes: number[];
  toolTermNames: string[];
  n: number;
}

export function fitCovariateControlled(rows: ToolDecisionRow[]): ControlledFitOutcome {
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const phases = [...new Set(rows.map((r) => r.phase))].sort();
  const tools = [...new Set(rows.map((r) => r.chosenTool).filter((x): x is string => !!x))].sort();
  const featureNames: string[] = ['intercept'];
  for (const m of models.slice(1)) featureNames.push(`model=${m}`);
  for (const ph of phases.slice(1)) featureNames.push(`phase=${ph}`);
  featureNames.push('priorErrorFlag');
  const toolTermIndexes: number[] = [];
  const toolTermNames: string[] = [];
  for (const t of tools.slice(1)) {
    toolTermIndexes.push(featureNames.length);
    toolTermNames.push(`tool=${t}`);
    featureNames.push(`tool=${t}`);
  }
  const X: number[][] = [];
  const y: number[] = [];
  for (const row of rows) {
    if (row.kind !== 'tool_call' && row.kind !== 'forced_tool_call') continue;
    const feat = [1];
    for (const m of models.slice(1)) feat.push(row.model === m ? 1 : 0);
    for (const ph of phases.slice(1)) feat.push(row.phase === ph ? 1 : 0);
    feat.push(row.state.priorErrorFlag ? 1 : 0);
    for (const t of tools.slice(1)) feat.push(row.chosenTool === t ? 1 : 0);
    X.push(feat);
    y.push(isSuccess(row));
  }
  const fit = fitLogistic({ X, y, featureNames });
  return { fit, toolTermIndexes, toolTermNames, n: y.length };
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  stratified: StratifiedResult;
  controlled?: ControlledFitOutcome;
  sensitivity?: SensitivityAnalysis;
  offPolicy: {
    ips: OffPolicyResult;
    dr?: OffPolicyResult;
    targetTool: string;
  };
  covariateNotes: {
    modelCount: number;
    phaseCount: number;
    toolCount: number;
    n: number;
    tracesJoined: number;
  };
}

export interface AnalysisInput {
  rows: ToolDecisionRow[];
  covariates?: TraceCovariates[];
  targetTool?: string;
  observationalOnly?: boolean;
  bootstrap?: BootstrapOpts;
}

export function analyzeSignal(input: AnalysisInput): AnalysisResult {
  const rows = input.rows;
  const stratified = stratifiedContrasts(
    rows,
    input.bootstrap ? { bootstrap: input.bootstrap } : {},
  );
  const target = input.targetTool ?? mostCommonTool(rows) ?? '';
  const ips = selfNormalizedIps(rows, target);
  const controlled = rows.length > 0 ? fitCovariateControlled(rows) : undefined;
  const sensitivity = rows.length > 0
    ? sensitivitySweep(rows, (rs) =>
        stratifiedContrasts(rs, input.bootstrap ? { bootstrap: input.bootstrap } : {}),
      )
    : undefined;
  const tracesJoined = new Set(
    rows.filter((r) => r.outcome?.status === 'joined').map((r) => r.traceId),
  ).size;
  return {
    stratified,
    ...(controlled ? { controlled } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    offPolicy: {
      ips,
      targetTool: target,
    },
    covariateNotes: {
      modelCount: new Set(rows.map((r) => r.model)).size,
      phaseCount: new Set(rows.map((r) => r.phase)).size,
      toolCount: new Set(rows.map((r) => r.chosenTool).filter(Boolean)).size,
      n: rows.length,
      tracesJoined,
    },
  };
}

function mostCommonTool(rows: ToolDecisionRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.chosenTool) continue;
    counts.set(r.chosenTool, (counts.get(r.chosenTool) ?? 0) + 1);
  }
  let top: string | undefined;
  let best = -1;
  for (const [t, c] of counts) {
    if (c > best) {
      best = c;
      top = t;
    }
  }
  return top;
}
