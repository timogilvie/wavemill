#!/usr/bin/env -S npx tsx

/**
 * Tool-choice signal analysis CLI (HOK-2080).
 *
 * Thin wrapper (thin-tools pattern): parses arguments, resolves paths, and
 * orchestrates load → join → quality → analysis → recommendation → report.
 * All substantive logic lives in
 * shared/lib/native-agent/tool-choice-analyzer.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { resolveToolDecisionCorpusPath } from '../shared/lib/native-agent/tool-decision-corpus.ts';
import {
  analyzeSignal,
  deriveRecommendation,
  generateReport,
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

runTool({
  name: 'tool-choice-analysis',
  description: 'Analyze the tool-decision corpus and generate the HOK-2080 Go/No-go report',
  options: {
    corpus: { type: 'string', description: 'Explicit corpus JSONL path (must exist; default: .wavemill/tool-decisions/<namespace>.jsonl)' },
    'corpus-dir': { type: 'string', description: 'Corpus directory (used when --corpus is not set)' },
    namespace: { type: 'string', description: 'Corpus namespace filename stem', default: 'corpus' },
    evals: { type: 'string', description: 'Path to evals.jsonl (default: resolved evals directory)' },
    output: { type: 'string', description: 'Report output path', default: 'docs/tool-choice-analysis-report.md' },
    decision: { type: 'string', description: 'Required operator decision: go | no-go | inconclusive' },
    'decision-reason': { type: 'string', description: 'Required justification recorded verbatim in the report' },
    note: { type: 'string', multiple: true, description: 'Context note appended to the Data Quality Appendix (repeatable)' },
    now: { type: 'string', description: 'Timestamp recorded in the report header (default: current time, ISO 8601)' },
    json: { type: 'boolean', description: 'Print a machine-readable summary instead of the human summary' },
  },
  examples: [
    'npx tsx tools/tool-choice-analysis.ts --decision inconclusive --decision-reason "Corpus empty; gates failed"',
    'npx tsx tools/tool-choice-analysis.ts --corpus .wavemill/tool-decisions/corpus.jsonl --decision go --decision-reason "Signal found" --json',
  ],
  run({ args }) {
    const decision = String(args.decision ?? '');
    if (!isOperatorDecision(decision)) {
      throw new Error(`--decision is required and must be one of: ${DECISION_VALUES.join(', ')}`);
    }
    const decisionReason = String(args['decision-reason'] ?? '');
    if (decisionReason.trim() === '') {
      throw new Error('--decision-reason is required');
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
    const notes = (args.note ?? []).map((note) => String(note));
    const report = generateReport({
      load,
      quality,
      analysis,
      recommendation,
      decision,
      decisionReason,
      evalsPath,
      now: args.now ? String(args.now) : new Date().toISOString(),
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
