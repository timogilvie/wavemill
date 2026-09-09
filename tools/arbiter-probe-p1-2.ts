#!/usr/bin/env -S npx tsx
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { runTool } from '../shared/lib/tool-runner.ts';
import { loadPairContext } from '../shared/lib/arbiter-probes/pair-context.ts';
import { loadSurvivalLabelsByPrUrl } from '../shared/lib/arbiter-probes/survival-labels.ts';
import {
  computeSurvivalAgreement,
  renderSurvivalReportMarkdown,
} from '../shared/lib/arbiter-probes/survival-agreement.ts';
import {
  computeEvalDisagreement,
  renderEvalDisagreementReportMarkdown,
} from '../shared/lib/arbiter-probes/eval-disagreement.ts';
import type { HorizonDays } from '../shared/lib/arbiter-survival-label.ts';
import { createHash } from 'node:crypto';

function hashFile(path: string): string {
  const content = readFileSync(path, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function getGitHead(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function runProbes(options: {
  repoDir: string;
  evalsDir: string;
  recordsPath: string;
  survivalLabelsPath: string | undefined;
  horizon: HorizonDays;
  outDir: string;
  dataOutDir: string;
  probes: ('b' | 'c')[];
  json: boolean;
}): Promise<void> {
  // Load pair context
  console.error('Loading pair context...');
  const pairContext = await loadPairContext(options.recordsPath, options.evalsDir);

  const results: Record<string, unknown> = {
    population: pairContext.pairs.length,
    selected: pairContext.ledger.selectedPairs,
    timestamp: new Date().toISOString(),
    gitHead: getGitHead(),
    files: {
      records: options.recordsPath,
    },
    hashes: {
      records: hashFile(options.recordsPath),
    },
  };

  // Probe B: Judge vs kept-side survival
  if (options.probes.includes('b')) {
    console.error('Running Probe B (judge vs kept-side survival)...');

    // Load survival labels
    let survivalLabels;
    if (!options.survivalLabelsPath || !existsSync(options.survivalLabelsPath)) {
      console.error(
        `⚠️  Survival labels file not found at ${options.survivalLabelsPath}. Probe B will report n=0.`,
      );
      survivalLabels = new Map();
    } else {
      survivalLabels = await loadSurvivalLabelsByPrUrl(options.survivalLabelsPath);
    }

    const survivalSummary = computeSurvivalAgreement({
      pairs: pairContext.pairs,
      survivalLabels,
      evalIndex: pairContext.evalIndex,
      horizon: options.horizon,
    });

    // Write Probe B report
    const survivalMarkdown = renderSurvivalReportMarkdown(survivalSummary);
    const survivalReportPath = join(options.outDir, 'p1-2-survival-probe-report.md');
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(survivalReportPath, survivalMarkdown, 'utf-8');
    console.log(`✓ Probe B report: ${survivalReportPath}`);

    // Write Probe B JSON data
    const survivalJsonPath = join(options.dataOutDir, 'p1-2-survival-probe.json');
    mkdirSync(options.dataOutDir, { recursive: true });
    writeFileSync(survivalJsonPath, JSON.stringify(survivalSummary, null, 2), 'utf-8');
    console.log(`✓ Probe B data: ${survivalJsonPath}`);

    results.probeB = {
      analyzed: survivalSummary.analyzed,
      agreementRate: survivalSummary.overall.cell.rate,
      excluded: survivalSummary.excluded,
    };
  }

  // Probe C: Judge vs eval judge disagreement
  if (options.probes.includes('c')) {
    console.error('Running Probe C (judge vs eval judge disagreement)...');

    const evalSummary = computeEvalDisagreement({
      pairs: pairContext.pairs,
      evalIndex: pairContext.evalIndex,
    });

    // Write Probe C report
    const evalMarkdown = renderEvalDisagreementReportMarkdown(evalSummary);
    const evalReportPath = join(options.outDir, 'p1-2-eval-disagreement-report.md');
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(evalReportPath, evalMarkdown, 'utf-8');
    console.log(`✓ Probe C report: ${evalReportPath}`);

    // Write Probe C JSON data
    const evalJsonPath = join(options.dataOutDir, 'p1-2-eval-disagreement.json');
    mkdirSync(options.dataOutDir, { recursive: true });
    writeFileSync(evalJsonPath, JSON.stringify(evalSummary, null, 2), 'utf-8');
    console.log(`✓ Probe C data: ${evalJsonPath}`);

    results.probeC = {
      analyzed: evalSummary.analyzed,
      disagreementRate: evalSummary.overall.disagreementCell.rate,
      ties: evalSummary.ties,
      excluded: evalSummary.excluded,
    };
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

runTool({
  name: 'arbiter-probe-p1-2',
  description: 'Probe the judge against survival and eval disagreements',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory (default: .)' },
    'evals-dir': { type: 'string', description: 'Evals directory (auto-resolved if not provided)' },
    records: {
      type: 'string',
      description: 'Path to challenge-records.jsonl (default: ${evalsDir}/challenge-records.jsonl)',
    },
    'survival-labels': {
      type: 'string',
      description: 'Path to survival-labels.jsonl (default: ${evalsDir}/survival-labels.jsonl)',
    },
    horizon: {
      type: 'string',
      description: 'Survival horizon: 14, 30, or 60 days (default: 30)',
    },
    probe: { type: 'string', description: 'Which probe to run: b, c, or both (default: both)' },
    'out-dir': { type: 'string', description: 'Output directory for reports (default: docs/arbiter)' },
    'data-out-dir': {
      type: 'string',
      description: 'Output directory for JSON data (default: .wavemill/evals/arbiter-probes)',
    },
    json: { type: 'boolean', description: 'Also output summary JSON to stdout' },
  },
  examples: [
    'npx tsx tools/arbiter-probe-p1-2.ts',
    'npx tsx tools/arbiter-probe-p1-2.ts --probe b',
    'npx tsx tools/arbiter-probe-p1-2.ts --horizon 14 --json',
  ],
  additionalHelp: `Probe P1.2 analyzes judge accuracy:
  - Probe B: Do verdicts match kept-side survival?
  - Probe C: Where do comparison and eval judges disagree?

Reports are written to docs/arbiter/, data to .wavemill/evals/arbiter-probes/.`,
  async run({ args }) {
    const repoDir = resolve((args['repo-dir'] as string) || '.');
    let evalsDir = args['evals-dir'] as string | undefined;

    // Auto-resolve evals dir if not provided
    if (!evalsDir) {
      const possibleDirs = [
        join(repoDir, '.wavemill/evals'),
        join(repoDir, 'evals'),
      ];
      evalsDir = possibleDirs.find((dir) => existsSync(dir)) || join(repoDir, '.wavemill/evals');
    }

    const recordsPath = resolve((args.records as string) || join(evalsDir, 'challenge-records.jsonl'));
    const survivalLabelsPath = (args['survival-labels'] as string)
      ? resolve(args['survival-labels'] as string)
      : join(evalsDir, 'survival-labels.jsonl');
    const outDir = resolve((args['out-dir'] as string) || join(repoDir, 'docs/arbiter'));
    const dataOutDir = resolve(
      (args['data-out-dir'] as string) || join(repoDir, '.wavemill/evals/arbiter-probes'),
    );

    const horizonStr = (args.horizon as string) || '30';
    const horizon = parseInt(horizonStr) as HorizonDays;
    if (![14, 30, 60].includes(horizon)) {
      throw new Error(`Invalid horizon "${horizonStr}". Use 14, 30, or 60.`);
    }

    const probeStr = (args.probe as string) || 'both';
    const probes: ('b' | 'c')[] = [];
    if (probeStr === 'both') {
      probes.push('b', 'c');
    } else if (probeStr === 'b' || probeStr === 'c') {
      probes.push(probeStr);
    } else {
      throw new Error(`Invalid probe "${probeStr}". Use "b", "c", or "both".`);
    }

    await runProbes({
      repoDir,
      evalsDir,
      recordsPath,
      survivalLabelsPath,
      horizon,
      outDir,
      dataOutDir,
      probes,
      json: args.json === true,
    });
  },
});
