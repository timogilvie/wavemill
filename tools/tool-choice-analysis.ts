#!/usr/bin/env -S npx tsx

/**
 * Tool-choice signal analysis and decision gate (HOK-2080).
 *
 * Thin CLI wrapper — orchestrates the analyzer, optionally backfills the
 * corpus from historical session-event streams, writes a markdown report,
 * and prints the decision.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  analyzeToolChoice,
  loadInputsForAnalysis,
  renderMarkdownReport,
} from '../shared/lib/native-agent/tool-choice-analyzer.ts';
import { captureToolDecisionsFromStream } from '../shared/lib/native-agent/tool-decision-capture.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

function isDecisionValue(value: string): value is 'go' | 'no-go' | 'inconclusive' {
  return value === 'go' || value === 'no-go' || value === 'inconclusive';
}

runTool({
  name: 'tool-choice-analysis',
  description: 'Assemble → validate → analyze → decide the tool-choice signal (HOK-2080)',
  options: {
    corpus: {
      type: 'string',
      description: 'Path to the tool-decision corpus JSONL (default: .wavemill/tool-decisions/corpus.jsonl)',
    },
    evals: {
      type: 'string',
      description: 'Path to the eval records JSONL (default: .wavemill/evals/evals.jsonl)',
    },
    'session-events': {
      type: 'string',
      description: 'Directory of session-events JSONL streams (default: .wavemill/session-events)',
    },
    backfill: {
      type: 'boolean',
      description: 'Project historical session-event streams into the corpus before analysis',
    },
    'target-tool': {
      type: 'string',
      description: 'Tool name to score for off-policy estimates (default: most-common)',
    },
    seed: {
      type: 'string',
      description: 'Bootstrap RNG seed (default: 20260923)',
    },
    iterations: {
      type: 'string',
      description: 'Bootstrap iterations (default: 400)',
    },
    'decision-override': {
      type: 'string',
      description: 'Operator override: go|no-go|inconclusive (records computed value alongside)',
    },
    'decision-reason': {
      type: 'string',
      description: 'Reason for operator override (required when --decision-override is set)',
    },
    report: {
      type: 'string',
      description: 'Write the full markdown report to this path',
    },
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of the human-readable summary on stdout',
    },
  },
  examples: [
    'npx tsx tools/tool-choice-analysis.ts',
    'npx tsx tools/tool-choice-analysis.ts --backfill --report docs/tool-choice-analysis-report.md',
    'npx tsx tools/tool-choice-analysis.ts --corpus /path/to/corpus.jsonl --evals /path/to/evals.jsonl',
    'npx tsx tools/tool-choice-analysis.ts --decision-override no-go --decision-reason "operator kill on 2026-09-23"',
  ],
  run({ args }) {
    const repoDir = resolve('.');
    const corpusPath = args.corpus
      ? resolve(String(args.corpus))
      : resolve(repoDir, '.wavemill/tool-decisions/corpus.jsonl');
    const evalsPath = args.evals
      ? resolve(String(args.evals))
      : resolve(repoDir, '.wavemill/evals/evals.jsonl');
    const streamsDir = args['session-events']
      ? resolve(String(args['session-events']))
      : resolve(repoDir, '.wavemill/session-events');

    if (args.backfill) {
      if (!existsSync(streamsDir)) {
        console.warn(`backfill: session-events directory not found at ${streamsDir}; skipping`);
      } else {
        const files = readdirSync(streamsDir).filter((f) => f.endsWith('.jsonl'));
        let ok = 0;
        let skipped = 0;
        for (const f of files) {
          const streamPath = resolve(streamsDir, f);
          const result = captureToolDecisionsFromStream({
            eventStreamPath: streamPath,
            repoDir,
            corpusDir: dirname(corpusPath),
          });
          if (result.ok) ok += 1;
          else skipped += 1;
        }
        console.log(`backfill: streams=${files.length} projected=${ok} skipped=${skipped}`);
      }
    }

    const loaded = loadInputsForAnalysis({
      repoDir,
      corpusPath,
      evalsPath,
    });

    const seed = args.seed ? Number(args.seed) : 20260923;
    const iterations = args.iterations ? Number(args.iterations) : 400;
    if (!Number.isFinite(seed) || !Number.isFinite(iterations) || iterations <= 0) {
      console.error('Error: --seed and --iterations must be positive numbers');
      process.exit(1);
    }

    const overrideValue = args['decision-override']
      ? String(args['decision-override']).toLowerCase()
      : undefined;
    let operatorOverride;
    if (overrideValue) {
      if (!isDecisionValue(overrideValue)) {
        console.error(`Error: --decision-override must be one of go|no-go|inconclusive, got: ${overrideValue}`);
        process.exit(1);
      }
      if (!args['decision-reason']) {
        console.error('Error: --decision-reason is required when --decision-override is set');
        process.exit(1);
      }
      operatorOverride = {
        decision: overrideValue,
        reason: String(args['decision-reason']),
      };
    }

    const result = analyzeToolChoice({
      rows: loaded.rows,
      evalRecords: loaded.evalRecords,
      bootstrap: { seed, iterations },
      ...(args['target-tool'] ? { targetTool: String(args['target-tool']) } : {}),
      ...(operatorOverride ? { operatorOverride } : {}),
    });

    // Streams count for the report metadata.
    let streamCount = 0;
    if (existsSync(streamsDir)) {
      streamCount = readdirSync(streamsDir).filter((f) => f.endsWith('.jsonl')).length;
    }

    const cliCommand = 'npx tsx tools/tool-choice-analysis.ts --backfill --report docs/tool-choice-analysis-report.md';
    const markdown = renderMarkdownReport(result, {
      timestamp: new Date().toISOString(),
      corpusPath,
      evalsPath,
      streamsDir,
      streamCount,
      evalCount: loaded.evalRecords.length,
      cliCommand,
    });

    if (args.report) {
      const target = resolve(String(args.report));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, markdown, 'utf-8');
      console.log(`wrote ${target}`);
    }

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            decision: result.decision,
            quality: {
              observationalGatePass: result.quality.observationalGatePass,
              offPolicyGatePass: result.quality.offPolicyGatePass,
              coverage: result.quality.coverage,
              menu: result.quality.menu,
              outcome: {
                joined: result.quality.outcome.joined,
                unjoinable: result.quality.outcome.unjoinable,
                pending: result.quality.outcome.pending,
                reasons: result.quality.outcome.reasons,
              },
              propensity: result.quality.propensity,
              checks: result.quality.checks,
              notes: result.quality.notes,
            },
            analysis: {
              contrasts: result.analysis.stratified.contrasts.map((c) => ({
                label: c.label,
                treatmentKey: c.treatmentKey,
                controlKey: c.controlKey,
                diff: c.diff,
                diffCi95: c.diffCi95,
                significant: c.significant,
                gated: c.gated,
              })),
              sensitivity: result.analysis.sensitivity,
              offPolicy: result.analysis.offPolicy,
              covariateNotes: result.analysis.covariateNotes,
            },
          },
          null,
          2,
        ),
      );
    } else {
      // Compact stdout summary; the full report goes to --report.
      console.log(`corpus: ${corpusPath} (${result.quality.coverage.totalDecisions} rows)`);
      console.log(`evals:  ${evalsPath} (${loaded.evalRecords.length} records)`);
      console.log('');
      console.log(`Decision: ${result.decision.decision}`);
      for (const r of result.decision.reasons) console.log(`  - ${r}`);
      if (result.decision.minimumAdditionalCapture) {
        console.log(
          `  additional joined traces needed: ${result.decision.minimumAdditionalCapture.additionalJoinedTraces}`,
        );
        console.log(
          `  additional exact-propensity rows needed: ${result.decision.minimumAdditionalCapture.additionalExactPropensityRows}`,
        );
      }
    }
  },
});
