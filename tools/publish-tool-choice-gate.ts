#!/usr/bin/env -S npx tsx

/**
 * Publish the daily tool-choice-gate progress (HOK-3123).
 *
 * Runs the report-only analyzer path (identical to
 * `tools/tool-choice-analysis.ts --report-only`), writes
 * `.wavemill/tool-decisions/latest-gate.{json,md}`, then overwrites the
 * Linear document `I-27 tool-choice gate progress` on initiative I-27 so the
 * weekly cloud routine can read the current gate telemetry without local
 * corpus access.
 *
 * Exit codes:
 *   0  — artifacts wrote and Linear publish succeeded.
 *   1  — artifact-write failure (the analyzer, disk, etc.).
 *   2  — artifacts wrote but Linear publish failed; the backstage hook
 *        records this as `lastRunStatus:'artifacts-only'` in
 *        `.wavemill/backstage-health.json → services.toolChoiceGate`.
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
  generateReportOnlyMarkdown,
  joinOutcomes,
  loadCorpusTolerant,
  loadEvalOutcomes,
  validateDataQuality,
} from '../shared/lib/native-agent/tool-choice-analyzer.ts';
import {
  publishToolChoiceGate,
  TOOL_CHOICE_GATE_DOCUMENT_TITLE,
} from '../shared/lib/tool-choice-gate-publisher.ts';

runTool({
  name: 'publish-tool-choice-gate',
  description:
    'Refresh .wavemill/tool-decisions/latest-gate.{json,md} and publish the Linear document "I-27 tool-choice gate progress"',
  options: {
    'repo-dir': { type: 'string', description: 'Repo root (default: cwd)' },
    corpus: { type: 'string', description: 'Explicit corpus JSONL path' },
    'corpus-dir': { type: 'string', description: 'Corpus directory (used when --corpus is not set)' },
    namespace: { type: 'string', description: 'Corpus namespace filename stem', default: 'corpus' },
    evals: { type: 'string', description: 'Evals JSONL path (default: resolved evals directory)' },
    'initiative-id': {
      type: 'string',
      description: 'Explicit Linear initiative UUID (overrides name lookup)',
    },
    'skip-linear': {
      type: 'boolean',
      description:
        'Write local artifacts, skip Linear publish. Used by the backstage hook when LINEAR_API_KEY is missing.',
    },
    now: { type: 'string', description: 'ISO 8601 timestamp for the report (default: now)' },
    json: { type: 'boolean', description: 'Print a machine-readable result summary' },
  },
  examples: [
    'npx tsx tools/publish-tool-choice-gate.ts',
    'npx tsx tools/publish-tool-choice-gate.ts --skip-linear',
    'npx tsx tools/publish-tool-choice-gate.ts --initiative-id 00000000-0000-0000-0000-000000000000',
  ],
  async run({ args }) {
    const repoDir = args['repo-dir'] ? resolve(String(args['repo-dir'])) : resolve('.');
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
      : resolve(resolveEvalsDir(undefined, repoDir).dir, 'evals.jsonl');

    const now = args.now ? String(args.now) : new Date().toISOString();

    const load = loadCorpusTolerant(corpusPath);
    const evalIndex = loadEvalOutcomes(evalsPath);
    const join = joinOutcomes(load, evalIndex);
    const quality = validateDataQuality(load, join, { evalIndex });
    const analysis = analyzeSignal(join, quality);
    const recommendation = deriveRecommendation(quality, analysis);

    const markdown = generateReportOnlyMarkdown({
      quality,
      recommendation,
      now,
      corpusPath,
      evalsPath,
    });
    const snapshot = buildLatestGateSnapshot({ quality, recommendation, now });

    const mdPath = resolve(repoDir, '.wavemill/tool-decisions/latest-gate.md');
    const jsonPath = resolve(repoDir, '.wavemill/tool-decisions/latest-gate.json');
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, markdown);
    writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    const skipLinear = args['skip-linear'] === true;
    const hasKey = typeof process.env.LINEAR_API_KEY === 'string' && process.env.LINEAR_API_KEY !== '';

    if (skipLinear || !hasKey) {
      const detail = skipLinear ? '--skip-linear' : 'LINEAR_API_KEY unset';
      if (args.json === true) {
        console.log(
          JSON.stringify(
            {
              status: 'artifacts-only',
              detail,
              progressLine: snapshot.progressLine,
              markdownPath: mdPath,
              jsonPath,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(snapshot.progressLine);
        console.log(`Artifacts refreshed at ${mdPath} and ${jsonPath}.`);
        console.log(`Skipping Linear publish (${detail}).`);
      }
      return;
    }

    try {
      const publishResult = await publishToolChoiceGate({
        markdown,
        now,
        ...(args['initiative-id'] ? { initiativeId: String(args['initiative-id']) } : {}),
      });
      if (args.json === true) {
        console.log(
          JSON.stringify(
            {
              status: 'ok',
              progressLine: snapshot.progressLine,
              markdownPath: mdPath,
              jsonPath,
              documentId: publishResult.documentId,
              documentUrl: publishResult.documentUrl,
              initiativeId: publishResult.initiativeId,
              action: publishResult.action,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(snapshot.progressLine);
        console.log(`Artifacts refreshed at ${mdPath} and ${jsonPath}.`);
        console.log(
          `Linear document "${TOOL_CHOICE_GATE_DOCUMENT_TITLE}" ${publishResult.action}${
            publishResult.documentUrl ? ` (${publishResult.documentUrl})` : ''
          }.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Linear publish failed: ${message}`);
      console.error(`Artifacts refreshed at ${mdPath} and ${jsonPath}.`);
      process.exitCode = 2;
    }
  },
});
