import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEvalsDir } from './evals-paths.ts';
import { extractPacketFeatures, TaskPacketNotFoundError, type PacketFeatures } from './task-packet-feature-extractor.ts';
import { scoreTaskPacket } from './task-packet-scorer.ts';
import { fitLogisticRegression, wilsonInterval } from './stats-utils.ts';

interface EvalLikeRecord {
  id?: string;
  issueId?: string;
  timestamp?: string;
  interventionRequired?: boolean;
  interventionCount?: number;
  score?: number;
}

interface JoinedPacketRecord {
  evalRecord: EvalLikeRecord;
  features: PacketFeatures;
  label: number;
}

export interface PacketSignalAnalysisResult {
  report: string;
  warnings: string[];
  recommendation: 'GO' | 'NO-GO';
  joinedCount: number;
}

const FEATURE_NAMES = [
  'total_chars',
  'file_count',
  'req_tag_count',
  'validation_scenario_count',
  'missing_section_ratio',
  'vague_phrase_density',
  'difficulty',
] as const;

function readJsonl(filePath: string): EvalLikeRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EvalLikeRecord];
      } catch {
        return [];
      }
    });
}

function interventionLabel(record: EvalLikeRecord): number {
  if (record.interventionRequired === true) return 1;
  if ((record.interventionCount ?? 0) > 0) return 1;
  if (typeof record.score === 'number' && record.score < 0.6) return 1;
  return 0;
}

function candidateArtifactPaths(evalsDir: string, record: EvalLikeRecord): string[] {
  const artifacts = join(evalsDir, 'artifacts');
  return [
    record.issueId ? join(artifacts, record.issueId) : '',
    record.id ? join(artifacts, record.id) : '',
  ].filter(Boolean);
}

function missingSectionRatio(features: PacketFeatures): number {
  const values = Object.values(features.section_lengths);
  if (values.length === 0) return 1;
  return values.filter((value) => value === 0).length / values.length;
}

function featureRow(features: PacketFeatures): number[] {
  return [
    Math.log1p(features.total_chars),
    features.file_count,
    features.req_tag_count,
    features.validation_scenario_count,
    missingSectionRatio(features),
    features.vague_phrase_density,
    features.difficulty,
  ];
}

function standardize(rows: number[][]): number[][] {
  const width = rows[0]?.length ?? 0;
  const means = Array(width).fill(0);
  const stds = Array(width).fill(1);
  for (let col = 0; col < width; col += 1) {
    const values = rows.map((row) => row[col]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
    means[col] = mean;
    stds[col] = Math.sqrt(variance) || 1;
  }
  return rows.map((row) => row.map((value, col) => (value - means[col]) / stds[col]));
}

async function joinEvalPackets(records: EvalLikeRecord[], evalsDir: string): Promise<{ joined: JoinedPacketRecord[]; warnings: string[] }> {
  const joined: JoinedPacketRecord[] = [];
  const warnings: string[] = [];

  for (const record of records) {
    let matched = false;
    for (const candidate of candidateArtifactPaths(evalsDir, record)) {
      if (!candidate || !existsSync(candidate)) continue;
      try {
        const features = await extractPacketFeatures(candidate);
        joined.push({ evalRecord: record, features, label: interventionLabel(record) });
        matched = true;
        break;
      } catch (error) {
        if (!(error instanceof TaskPacketNotFoundError)) {
          warnings.push(`[warn] ${record.id ?? record.issueId ?? 'unknown'} packet read failed: ${(error as Error).message}`);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      warnings.push(`[warn] ${record.id ?? record.issueId ?? 'unknown'} missing packet artifact`);
    }
  }

  return { joined, warnings };
}

export async function analyzePacketSignal(options: {
  evalsDir?: string;
  repoDir?: string;
} = {}): Promise<PacketSignalAnalysisResult> {
  const evalsDir = resolveEvalsDir(options.evalsDir, options.repoDir).dir;
  const records = readJsonl(join(evalsDir, 'evals.jsonl'));
  if (records.length === 0) {
    return {
      report: 'No evaluation data found.',
      warnings: [],
      recommendation: 'NO-GO',
      joinedCount: 0,
    };
  }

  const { joined, warnings } = await joinEvalPackets(records, evalsDir);
  if (joined.length < 5) {
    const report = [
      `Packet signal analysis`,
      `N: ${joined.length}`,
      `Insufficient joined packet data for regression.`,
      `RECOMMENDATION: NO-GO`,
    ].join('\n');
    return { report, warnings, recommendation: 'NO-GO', joinedCount: joined.length };
  }

  joined.sort((a, b) => String(a.evalRecord.timestamp ?? '').localeCompare(String(b.evalRecord.timestamp ?? '')));
  const rows = standardize(joined.map((item) => featureRow(item.features)));
  const labels = joined.map((item) => item.label);
  const fit = fitLogisticRegression(rows, labels);
  const featureRows = FEATURE_NAMES.map((name, index) => ({
    name,
    coefficient: fit.coefficients[index + 1],
    pValue: fit.pValues[index + 1],
  }));
  const significant = featureRows.filter((row) => row.name !== 'difficulty' && row.pValue < 0.05);
  const recommendation: 'GO' | 'NO-GO' = significant.length > 0 ? 'GO' : 'NO-GO';

  const split = Math.max(1, Math.floor(joined.length * 0.7));
  const heldOut = joined.slice(split);
  const baseInterventions = heldOut.reduce((sum, item) => sum + item.label, 0);
  const flagged = heldOut.filter((item) => scoreTaskPacket(item.features).decision !== 'run');
  const flaggedInterventions = flagged.reduce((sum, item) => sum + item.label, 0);
  const flaggedInterval = wilsonInterval(flaggedInterventions, flagged.length);
  const baseInterval = wilsonInterval(baseInterventions, heldOut.length);

  const lines = [
    'Packet signal analysis',
    `N: ${joined.length}`,
    'feature\tcoefficient\tp_value',
    `intercept\t${fit.coefficients[0].toFixed(4)}\t${fit.pValues[0].toFixed(4)}`,
    ...featureRows.map((row) => `${row.name}\t${row.coefficient.toFixed(4)}\t${row.pValue.toFixed(4)}`),
    `heldout_flagged_precision\t${flaggedInterval.p === null ? 'n/a' : flaggedInterval.p.toFixed(4)}\t${flaggedInterventions}/${flagged.length}`,
    `heldout_base_intervention_rate\t${baseInterval.p === null ? 'n/a' : baseInterval.p.toFixed(4)}\t${baseInterventions}/${heldOut.length}`,
    `RECOMMENDATION: ${recommendation}`,
  ];

  return {
    report: lines.join('\n'),
    warnings,
    recommendation,
    joinedCount: joined.length,
  };
}
