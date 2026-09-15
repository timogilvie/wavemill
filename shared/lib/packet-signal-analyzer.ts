/**
 * Packet Signal Analyzer
 *
 * Analyzes historical eval records to determine whether task packet
 * structural features carry predictive signal for intervention outcomes,
 * after controlling for task difficulty.
 *
 * @module packet-signal-analyzer
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveEvalsDir } from './evals-paths.ts';
import { extractPacketFeatures, type PacketFeatures } from './task-packet-feature-extractor.ts';
import { fitLogisticRegression, type LogisticRegressionResult } from './stats-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface AnalysisRecord {
  id: string;
  interventionRequired: boolean;
  features: PacketFeatures;
}

export interface AnalysisReport {
  sampleSize: number;
  baseInterventionRate: number;
  regression: LogisticRegressionResult | null;
  recommendation: 'GO' | 'NO-GO';
  flaggedPrecision: number | null;
  baselinePrecision: number | null;
}

// ────────────────────────────────────────────────────────────────
// Data Loading
// ────────────────────────────────────────────────────────────────

interface MinimalEvalRecord {
  id: string;
  interventionRequired?: boolean;
  interventionCount?: number;
}

async function loadEvalRecords(evalsDir: string): Promise<MinimalEvalRecord[]> {
  const jsonlPath = path.join(evalsDir, 'evals.jsonl');
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const records: MinimalEvalRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

async function resolvePacketPath(evalsDir: string, recordId: string): Promise<string | null> {
  const artifactsDir = path.join(evalsDir, 'artifacts', recordId);
  const candidates = ['task-packet.md', 'task-packet-header.md'];
  for (const name of candidates) {
    const filePath = path.join(artifactsDir, name);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // try next
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Analysis
// ────────────────────────────────────────────────────────────────

function featuresToRow(f: PacketFeatures): { values: number[]; names: string[] } {
  const names = [
    'total_chars',
    'file_count',
    'req_tag_count',
    'validation_scenario_count',
    'vague_phrase_count',
    'objective_length',
    'success_criteria_length',
    'implementation_approach_length',
    'difficulty',
  ];
  const values = [
    f.total_chars / 1000, // normalize for regression
    f.file_count,
    f.req_tag_count,
    f.validation_scenario_count,
    f.vague_phrase_count,
    f.section_lengths.objective / 100,
    f.section_lengths.success_criteria / 100,
    f.section_lengths.implementation_approach / 100,
    f.difficulty,
  ];
  return { values, names };
}

export async function analyzePacketSignal(
  repoDir?: string,
  evalsDir?: string,
): Promise<AnalysisReport> {
  const resolved = resolveEvalsDir(evalsDir, repoDir);
  const records = await loadEvalRecords(resolved.dir);

  if (records.length === 0) {
    return {
      sampleSize: 0,
      baseInterventionRate: 0,
      regression: null,
      recommendation: 'NO-GO',
      flaggedPrecision: null,
      baselinePrecision: null,
    };
  }

  const joined: AnalysisRecord[] = [];
  for (const record of records) {
    const packetPath = await resolvePacketPath(resolved.dir, record.id);
    if (!packetPath) {
      process.stderr.write(`[warn] Missing artifact directory for run ${record.id}\n`);
      continue;
    }
    try {
      const features = await extractPacketFeatures(packetPath);
      joined.push({
        id: record.id,
        interventionRequired: Boolean(record.interventionRequired || (record.interventionCount && record.interventionCount > 0)),
        features,
      });
    } catch {
      process.stderr.write(`[warn] Failed to extract features for run ${record.id}\n`);
    }
  }

  if (joined.length === 0) {
    return {
      sampleSize: 0,
      baseInterventionRate: 0,
      regression: null,
      recommendation: 'NO-GO',
      flaggedPrecision: null,
      baselinePrecision: null,
    };
  }

  const interventionCount = joined.filter(r => r.interventionRequired).length;
  const baseInterventionRate = interventionCount / joined.length;

  // Build feature matrix
  const { names } = featuresToRow(joined[0].features);
  const X = joined.map(r => featuresToRow(r.features).values);
  const y = joined.map(r => r.interventionRequired ? 1 : 0);

  let regression: LogisticRegressionResult | null = null;
  try {
    regression = fitLogisticRegression(X, y, names);
  } catch {
    // regression failed, we'll report NO-GO
  }

  let recommendation: 'GO' | 'NO-GO' = 'NO-GO';
  if (regression) {
    const significantFeatures = regression.coefficients.filter(
      c => c.pValue < 0.05 && c.name !== 'difficulty',
    );
    if (significantFeatures.length > 0) {
      recommendation = 'GO';
    }
  }

  // Compute flagged precision from held-out split (simple: last 20%)
  let flaggedPrecision: number | null = null;
  const baselinePrecision = baseInterventionRate;
  if (joined.length >= 20 && regression) {
    const splitIdx = Math.floor(joined.length * 0.8);
    const testSet = joined.slice(splitIdx);
    const flagged = testSet.filter(r => {
      const row = featuresToRow(r.features);
      let logit = regression!.intercept.coefficient;
      for (let i = 0; i < row.values.length; i++) {
        logit += regression!.coefficients[i].coefficient * row.values[i];
      }
      const prob = 1 / (1 + Math.exp(-logit));
      return prob > 0.5;
    });
    if (flagged.length > 0) {
      const truePositives = flagged.filter(r => r.interventionRequired).length;
      flaggedPrecision = truePositives / flagged.length;
    }
  }

  return {
    sampleSize: joined.length,
    baseInterventionRate,
    regression,
    recommendation,
    flaggedPrecision,
    baselinePrecision,
  };
}

export function formatReport(report: AnalysisReport): string {
  const lines: string[] = [];

  lines.push('=== Task Packet Signal Analysis ===');
  lines.push('');
  lines.push(`Sample size: ${report.sampleSize}`);
  lines.push(`Base intervention rate: ${(report.baseInterventionRate * 100).toFixed(1)}%`);

  if (report.regression) {
    lines.push('');
    lines.push('Logistic regression coefficients (outcome = intervention):');
    lines.push('');
    lines.push(
      'Feature'.padEnd(35) +
      'Coefficient'.padStart(12) +
      'p-value'.padStart(10),
    );
    lines.push('-'.repeat(57));

    lines.push(
      report.regression.intercept.name.padEnd(35) +
      report.regression.intercept.coefficient.toFixed(4).padStart(12) +
      report.regression.intercept.pValue.toFixed(4).padStart(10),
    );

    for (const coef of report.regression.coefficients) {
      const sig = coef.pValue < 0.05 ? ' *' : '';
      lines.push(
        coef.name.padEnd(35) +
        coef.coefficient.toFixed(4).padStart(12) +
        coef.pValue.toFixed(4).padStart(10) +
        sig,
      );
    }

    lines.push('');
    lines.push(`Converged: ${report.regression.converged ? 'yes' : 'no'}`);
  }

  if (report.flaggedPrecision !== null) {
    lines.push('');
    lines.push(`Flagged-packet precision: ${(report.flaggedPrecision * 100).toFixed(1)}%`);
    lines.push(`Baseline precision: ${((report.baselinePrecision ?? 0) * 100).toFixed(1)}%`);
  }

  lines.push('');
  lines.push(`RECOMMENDATION: ${report.recommendation}`);

  return lines.join('\n');
}
