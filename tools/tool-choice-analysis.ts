#!/usr/bin/env -S npx tsx

/**
 * Tool-choice signal analysis CLI (HOK-2080).
 *
 * Thin wrapper (thin-tools pattern): parses arguments, resolves paths, and
 * orchestrates load → join → quality → analysis → recommendation → report.
 * All substantive logic lives in
 * shared/lib/native-agent/tool-choice-analyzer.ts.
 *
 * HOK-3123: `--report-only` runs the same coverage-gate telemetry without an
 * operator decision, writing `.wavemill/tool-decisions/latest-gate.{json,md}`
 * so scheduled/backstage callers can surface I-27 progress without signing
 * anything. The signed HOK-2081 decision path (with `--decision`) is
 * unchanged and remains the sole writer of `docs/tool-choice-analysis-report.md`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveToolDecisionCorpusPath } from '../shared/lib/native-agent/tool-decision-corpus.ts';
import {
  analyzeSignal,
  buildLatestGateSnapshot,
  deriveRecommendation,
  generateReport,
  generateReportOnlyMarkdown,
  joinOutcomes,
  loadCorpusTolerant,
  loadEvalOutcomes,
  validateDataQuality,
} from '../shared/lib/native-agent/tool-choice-analyzer.ts';

const DECISION_VALUES = ['go', 'no-go', 'inconclusive'] as const;
type OperatorDecision = (typeof DECISION_VALUES)[number];

function isOperatorDecision(value: string): value is OperatorDecision {
  return (DECISION_VALUES as readonly string[]).includes(value);
}

const REPORT_ONLY_DEFAULT_MD = '.wavemill/tool-decisions/latest-gate.md';
const REPORT_ONLY_DEFAULT_JSON = '.wavemill/tool-decisions/latest-gate.json';

runTool({
  name: 'tool-choice-analysis',
  description: 'Analyze the tool-decision corpus and generate the HOK-2080 Go/No-go report',
  options: {
    corpus: { type: 'string', description: 'Explicit corpus JSONL path (must exist; default: .wavemill/tool-decisions/<namespace>.jsonl)' },
    'corpus-dir': { type: 'string', description: 'Corpus directory (used when --corpus is not set)' },
    namespace: { type: 'string', description: 'Corpus namespace filename stem', default: 'corpus' },
    evals: { type: 'string', description: 'Path to evals.jsonl (default: resolved evals directory)' },
    output: {
      type: 'string',
      description:
        'Report output path (default: docs/tool-choice-analysis-report.md for the signed decision path; .wavemill/tool-decisions/latest-gate.md under --report-only)',
    },
    decision: { type: 'string', description: 'Required operator decision: go | no-go | inconclusive (omit with --report-only)' },
    'decision-reason': { type: 'string', description: 'Required justification recorded verbatim in the report (omit with --report-only)' },
    note: { type: 'string', multiple: true, description: 'Context note appended to the Data Quality Appendix (repeatable)' },
    now: { type: 'string', description: 'Timestamp recorded in the report header (default: current time, ISO 8601)' },
    json: { type: 'boolean', description: 'Print a machine-readable summary instead of the human summary' },
    'report-only': {
      type: 'boolean',
      description:
        'Write .wavemill/tool-decisions/latest-gate.{json,md} without recording an operator decision. Never touches docs/tool-choice-analysis-report.md. --decision/--decision-reason become optional; --output defaults to the latest-gate.md artifact.',
    },
    'json-output': {
      type: 'string',
      description:
        'Override the JSON artifact path in --report-only mode (default: .wavemill/tool-decisions/latest-gate.json).',
    },
  },
  examples: [
    'npx tsx tools/tool-choice-analysis.ts --decision inconclusive --decision-reason "Corpus empty; gates failed"',
    'npx tsx tools/tool-choice-analysis.ts --corpus .wavemill/tool-decisions/corpus.jsonl --decision go --decision-reason "Signal found" --json',
    'npx tsx tools/tool-choice-analysis.ts --report-only',
  ],
  run({ args }) {
    const reportOnly = args['report-only'] === true;
    let decision: OperatorDecision | null = null;
    let decisionReason = '';
    if (!reportOnly) {
      const rawDecision = String(args.decision ?? '');
      if (!isOperatorDecision(rawDecision)) {
        throw new Error(`--decision is required and must be one of: ${DECISION_VALUES.join(', ')}`);
      }
      decision = rawDecision;
      decisionReason = String(args['decision-reason'] ?? '');
      if (decisionReason.trim() === '') {
        throw new Error('--decision-reason is required');
      }
    } else if (args.decision !== undefined || args['decision-reason'] !== undefined) {
      throw new Error('--report-only cannot be combined with --decision or --decision-reason');
    }

    const repoDir = resolve('.');
    const corpusPath = args.corpus
      ? resolve(String(args.corpus))
      : resolveToolDecisionCorpusPath({
          repoDir,
          ...(args['corpus-dir'] ? { explicitDir: String(args['corpus-dir']) } : {}),
          namespace: String(args.namespace ?? 'corpus'),
        });
    if (args.corpus && !existsSync(corpusPath)) {
      throw new Error(`Corpus file not found at ${corpusPath}`);
    }
    const evalsPath = args.evals
      ? resolve(String(args.evals))
      : resolve(resolveEvalsDir().dir, 'evals.jsonl');

    const load = loadCorpusTolerant(corpusPath);
    const evalIndex = loadEvalOutcomes(evalsPath);
    const join = joinOutcomes(load, evalIndex);
    const quality = validateDataQuality(load, join, { evalIndex });
    const analysis = analyzeSignal(join, quality);
    const recommendation = deriveRecommendation(quality, analysis);
    const now = args.now ? String(args.now) : new Date().toISOString();

    if (reportOnly) {
      const mdOutput = resolve(String(args.output ?? REPORT_ONLY_DEFAULT_MD));
      const jsonOutput = resolve(String(args['json-output'] ?? REPORT_ONLY_DEFAULT_JSON));
      if (mdOutput === resolve('docs/tool-choice-analysis-report.md')) {
        throw new Error(
          '--report-only refuses to overwrite docs/tool-choice-analysis-report.md; pass --output with a different path or omit it to use the default latest-gate.md',
        );
      }
      const markdown = generateReportOnlyMarkdown({
        quality,
        recommendation,
        now,
        corpusPath,
        evalsPath,
      });
      const snapshot = buildLatestGateSnapshot({ quality, recommendation, now });
      mkdirSync(dirname(mdOutput), { recursive: true });
      writeFileSync(mdOutput, markdown);
      mkdirSync(dirname(jsonOutput), { recursive: true });
      writeFileSync(jsonOutput, `${JSON.stringify(snapshot, null, 2)}\n`);
      if (args.json === true) {
        console.log(
          JSON.stringify(
            {
              reportOnly: true,
              corpusPath,
              evalsPath,
              markdownPath: mdOutput,
              jsonPath: jsonOutput,
              progressLine: snapshot.progressLine,
              computedRecommendation: snapshot.computedRecommendation,
              gates: snapshot.gates.map((gate) => ({ id: gate.id, passed: gate.passed })),
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(snapshot.progressLine);
      console.log(`Report-only markdown written to ${mdOutput}`);
      console.log(`Report-only JSON written to ${jsonOutput}`);
      return;
    }

    const notes = (args.note ?? []).map((note) => String(note));
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision: decision as OperatorDecision,
      decisionReason,
      evalsPath,
      now,
      ...(notes.length > 0 ? { notes } : {}),
    });

    const outputPath = resolve(String(args.output ?? 'docs/tool-choice-analysis-report.md'));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, report);

    const divergence = decision !== recommendation.decision;
    if (args.json === true) {
      console.log(
        JSON.stringify(
          {
            corpusPath,
            evalsPath,
            outputPath,
            corpusFileMissing: load.fileMissing,
            validRows: load.rows.length,
            joined: join.diagnostics.joined,
            computedRecommendation: recommendation.decision,
            operatorDecision: decision,
            divergence,
            gates: quality.gates.map((gate) => ({ id: gate.id, passed: gate.passed })),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Report written to ${outputPath}`);
    console.log(
      `  corpus: ${load.fileMissing ? 'absent' : `${load.rows.length} valid row(s)`} (${corpusPath})`,
    );
    console.log(
      `  eval outcomes joined: ${join.diagnostics.joined}/${join.diagnostics.candidates}`,
    );
    console.log(
      `  coverage gates: ${quality.gates
        .map((gate) => `${gate.id} ${gate.passed ? 'pass' : 'fail'}`)
        .join(', ')}`,
    );
    console.log(`  computed recommendation: ${recommendation.decision}`);
    console.log(
      `  operator decision: ${decision}${divergence ? ' (diverges from computed recommendation)' : ''}`,
    );
  },
});
