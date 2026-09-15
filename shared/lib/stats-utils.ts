export interface ProportionInterval {
  p: number | null;
  lo: number | null;
  hi: number | null;
}

export function wilsonInterval(successes: number, n: number, z = 1.96): ProportionInterval {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || successes < 0 || n < 0 || successes > n) {
    throw new Error(`Invalid Wilson interval inputs: successes=${successes}, n=${n}`);
  }
  if (n === 0) {
    return { p: null, lo: null, hi: null };
  }

  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    p,
    lo: Math.max(0, (centre - margin) / denominator),
    hi: Math.min(1, (centre + margin) / denominator),
  };
}

// ────────────────────────────────────────────────────────────────
// Logistic Regression (dependency-free IRLS)
// ────────────────────────────────────────────────────────────────

export interface LogisticRegressionCoefficient {
  name: string;
  coefficient: number;
  standardError: number;
  zScore: number;
  pValue: number;
}

export interface LogisticRegressionResult {
  coefficients: LogisticRegressionCoefficient[];
  intercept: LogisticRegressionCoefficient;
  n: number;
  converged: boolean;
}

function sigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

function normalCdfApprox(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function fitLogisticRegression(
  X: number[][],
  y: number[],
  featureNames: string[],
  maxIter = 25,
): LogisticRegressionResult {
  const n = y.length;
  const k = featureNames.length;

  // Augment X with intercept column
  const Xa = X.map(row => [1, ...row]);
  const kFull = k + 1;
  const beta = new Float64Array(kFull);

  let converged = false;

  for (let iter = 0; iter < maxIter; iter++) {
    const probs = new Float64Array(n);
    const W = new Float64Array(n);
    const residuals = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      let eta = 0;
      for (let j = 0; j < kFull; j++) eta += Xa[i][j] * beta[j];
      probs[i] = sigmoid(eta);
      W[i] = Math.max(1e-10, probs[i] * (1 - probs[i]));
      residuals[i] = y[i] - probs[i];
    }

    // Compute X^T W X (Hessian)
    const H = Array.from({ length: kFull }, () => new Float64Array(kFull));
    for (let j = 0; j < kFull; j++) {
      for (let l = j; l < kFull; l++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += Xa[i][j] * W[i] * Xa[i][l];
        H[j][l] = sum;
        H[l][j] = sum;
      }
    }

    // Compute X^T residuals (gradient)
    const grad = new Float64Array(kFull);
    for (let j = 0; j < kFull; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Xa[i][j] * residuals[i];
      grad[j] = sum;
    }

    // Solve H * delta = grad via Cholesky-ish (add ridge for stability)
    for (let j = 0; j < kFull; j++) H[j][j] += 1e-8;
    const delta = solveSymmetric(H, grad);

    let maxDelta = 0;
    for (let j = 0; j < kFull; j++) {
      beta[j] += delta[j];
      maxDelta = Math.max(maxDelta, Math.abs(delta[j]));
    }

    if (maxDelta < 1e-8) {
      converged = true;
      break;
    }
  }

  // Compute standard errors from inverse Hessian
  const probs = new Float64Array(n);
  const W = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let eta = 0;
    for (let j = 0; j < kFull; j++) eta += Xa[i][j] * beta[j];
    probs[i] = sigmoid(eta);
    W[i] = Math.max(1e-10, probs[i] * (1 - probs[i]));
  }

  const H = Array.from({ length: kFull }, () => new Float64Array(kFull));
  for (let j = 0; j < kFull; j++) {
    for (let l = j; l < kFull; l++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Xa[i][j] * W[i] * Xa[i][l];
      H[j][l] = sum;
      H[l][j] = sum;
    }
  }
  for (let j = 0; j < kFull; j++) H[j][j] += 1e-8;

  const invH = invertSymmetric(H);
  const se = new Float64Array(kFull);
  for (let j = 0; j < kFull; j++) {
    se[j] = Math.sqrt(Math.max(0, invH[j][j]));
  }

  function makeCoef(name: string, idx: number): LogisticRegressionCoefficient {
    const z = se[idx] > 0 ? beta[idx] / se[idx] : 0;
    const pVal = 2 * (1 - normalCdfApprox(Math.abs(z)));
    return { name, coefficient: beta[idx], standardError: se[idx], zScore: z, pValue: pVal };
  }

  return {
    intercept: makeCoef('(intercept)', 0),
    coefficients: featureNames.map((name, i) => makeCoef(name, i + 1)),
    n,
    converged,
  };
}

function solveSymmetric(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));

  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < j; k++) sum += L[j][k] * L[j][k];
    L[j][j] = Math.sqrt(Math.max(1e-15, A[j][j] - sum));
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i][k] * L[j][k];
      L[i][j] = (A[i][j] - s) / L[j][j];
    }
  }

  // Forward substitution: L y = b
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < i; k++) s += L[i][k] * y[k];
    y[i] = (b[i] - s) / L[i][i];
  }

  // Back substitution: L^T x = y
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = 0;
    for (let k = i + 1; k < n; k++) s += L[k][i] * x[k];
    x[i] = (y[i] - s) / L[i][i];
  }

  return x;
}

function invertSymmetric(A: Float64Array[]): Float64Array[] {
  const n = A.length;
  const inv = Array.from({ length: n }, () => new Float64Array(n));
  for (let col = 0; col < n; col++) {
    const e = new Float64Array(n);
    e[col] = 1;
    const x = solveSymmetric(A, e);
    for (let row = 0; row < n; row++) inv[row][col] = x[row];
  }
  return inv;
}
