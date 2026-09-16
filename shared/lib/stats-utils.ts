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

export interface LogisticRegressionFit {
  coefficients: number[];
  standardErrors: number[];
  pValues: number[];
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function invertMatrix(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][col]) < 1e-10) {
      return null;
    }
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];

    const divisor = augmented[col][col];
    for (let j = 0; j < n * 2; j += 1) {
      augmented[col][j] /= divisor;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = 0; j < n * 2; j += 1) {
        augmented[row][j] -= factor * augmented[col][j];
      }
    }
  }

  return augmented.map((row) => row.slice(n));
}

export function fitLogisticRegression(
  rows: number[][],
  labels: number[],
  options: { iterations?: number; learningRate?: number; l2?: number } = {},
): LogisticRegressionFit {
  if (rows.length !== labels.length || rows.length === 0) {
    throw new Error('fitLogisticRegression requires matching non-empty rows and labels');
  }
  const width = rows[0].length + 1;
  const coefficients = Array(width).fill(0);
  const iterations = options.iterations ?? 2500;
  const learningRate = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 0.001;
  const design = rows.map((row) => [1, ...row.map((value) => (Number.isFinite(value) ? value : 0))]);

  for (let iter = 0; iter < iterations; iter += 1) {
    const gradient = Array(width).fill(0);
    for (let i = 0; i < design.length; i += 1) {
      const predicted = 1 / (1 + Math.exp(-design[i].reduce((sum, value, j) => sum + value * coefficients[j], 0)));
      const error = predicted - labels[i];
      for (let j = 0; j < width; j += 1) {
        gradient[j] += error * design[i][j];
      }
    }
    for (let j = 0; j < width; j += 1) {
      const penalty = j === 0 ? 0 : l2 * coefficients[j];
      coefficients[j] -= learningRate * ((gradient[j] / design.length) + penalty);
    }
  }

  const info = Array.from({ length: width }, () => Array(width).fill(0));
  for (const row of design) {
    const predicted = 1 / (1 + Math.exp(-row.reduce((sum, value, j) => sum + value * coefficients[j], 0)));
    const weight = Math.max(1e-6, predicted * (1 - predicted));
    for (let a = 0; a < width; a += 1) {
      for (let b = 0; b < width; b += 1) {
        info[a][b] += weight * row[a] * row[b];
      }
    }
  }
  for (let j = 1; j < width; j += 1) {
    info[j][j] += l2;
  }

  const inverse = invertMatrix(info);
  const standardErrors = coefficients.map((_, i) => {
    const variance = inverse?.[i]?.[i];
    return typeof variance === 'number' && variance > 0 ? Math.sqrt(variance) : Number.POSITIVE_INFINITY;
  });
  const pValues = coefficients.map((coefficient, i) => {
    const se = standardErrors[i];
    if (!Number.isFinite(se) || se === 0) return 1;
    const z = Math.abs(coefficient / se);
    return Math.max(0, Math.min(1, 2 * (1 - normalCdf(z))));
  });

  return { coefficients, standardErrors, pValues };
}
