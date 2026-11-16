#!/usr/bin/env -S npx tsx
/** Operator command: preregister and run an isolated fixed-model endpoint comparison. */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueContribution } from '../shared/lib/hokusai-queue.ts';
import { getHokusaiSubmissionConfig } from '../shared/lib/config.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';
import { fetchOpenRouterModelEndpoints, type OpenRouterEndpoint } from '../shared/lib/openrouter-catalog.ts';
import { resolveCertificationSubject } from '../shared/lib/native-agent/certification/identity.ts';
import { comparisonPlan, runEndpointComparison, endpointComparisonReport, reconcileEndpointComparisonEconomics } from '../shared/lib/native-agent/certification/endpoint-comparison.ts';

export async function runEndpointQualificationCommand(argv = process.argv.slice(2)) {
  return runTool({ name: 'native-agent-qualify-endpoints', description: 'Preregister endpoint qualification and run bounded, paired native workflows in isolated repositories. Production routing is unchanged.',
    options: {
      model: { type: 'string', description: 'Existing canonical native OpenRouter model.' },
      reference: { type: 'string', description: 'Exact reference endpoint tag from the current catalog.' },
      candidates: { type: 'string', description: 'Comma-separated exact alternative endpoint tags from the catalog.' },
      output: { type: 'string', description: 'New report path; immutable plan, catalog and append-only run evidence are adjacent.' },
      catalog: { type: 'string', description: 'Optional previously captured catalog snapshot for reproducible offline planning.' },
      repo: { type: 'string', description: 'Repository supplying registry and credentials.' },
      'max-cost-usd': { type: 'string', description: 'Required experiment spend reservation, including failed/retried attempts.' },
      'max-regression': { type: 'string', description: 'Maximum completion regression as a fraction (default .05 at 95% confidence).' },
      'latency-ratio': { type: 'string', description: 'Maximum p95 latency relative to reference (default 2).' },
      replay: { type: 'string', description: 'Reconcile an existing .plan.json and adjacent .runs.jsonl with its original catalog; no model calls or overwritten history.' },
      live: { type: 'boolean', description: 'Execute credentialed requests after writing the preregistration. Without this flag, plan only.' },
    },
    async run({ args }) {
      const repoDir = resolve((args.repo as string | undefined) ?? process.cwd());
      if (args.replay) {
        if (!args.output || args.live) throw new Error('--replay requires a new --output and cannot use --live');
        const planPath = resolve(args.replay as string);
        if (!planPath.endsWith('.plan.json')) throw new Error('--replay expects the original .plan.json');
        const base = planPath.slice(0, -'.plan.json'.length);
        const packet = JSON.parse(readFileSync(planPath, 'utf8'));
        const catalog = JSON.parse(readFileSync(base + '.catalog.json', 'utf8'));
        const runs = readFileSync(base + '.runs.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const corrected = await reconcileEndpointComparisonEconomics(runs, catalog.endpoints, getEffectiveRegistry(repoDir));
        const report = endpointComparisonReport(packet.plan, corrected);
        const exports = await exportComparisonRuns(corrected, repoDir);
        writeFileSync(resolve(args.output as string), JSON.stringify({ ...report,
          exports,
          reconciliation: { reason: 'Original SDK estimates lacked endpoint rate overrides when generation metadata was unavailable. Replayed retained observations through the existing SDK; original runs and outcomes are unchanged.', originalRuns: runs } }, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ output: args.output, live: false, totalUsd: report.economics.sdkReport.totalUsd, subjects: report.subjects.map(subject => ({ tag: subject.endpoint.tag, verdict: subject.promotionVerdict })) }));
        return;
      }

      const model = args.model as string;
      const reference = args.reference as string;
      const candidates = (args.candidates as string | undefined)?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
      if (!model || !reference || !candidates.length || !args.output || !args['max-cost-usd']) throw new Error('--model, --reference, --candidates, --output and --max-cost-usd are required');
      const output = resolve(args.output as string);
      for (const path of [output, output + '.plan.json', output + '.runs.jsonl']) if (existsSync(path)) throw new Error('Output evidence already exists; choose a new run path rather than overwriting history');
      const registry = getEffectiveRegistry(repoDir);
      const subject = resolveCertificationSubject({ provider: 'openrouter', model, registry }).subject;
      const capturedAt = new Date().toISOString();
      const snapshot = args.catalog ? JSON.parse(readFileSync(args.catalog as string, 'utf8')) : { capturedAt, model: subject.providerNativeId, endpoints: await fetchOpenRouterModelEndpoints(subject.providerNativeId) };
      if (snapshot.model !== subject.providerNativeId || !Array.isArray(snapshot.endpoints)) throw new Error('Catalog snapshot must name the same model and contain endpoints');
      const entries: OpenRouterEndpoint[] = [reference, ...candidates].map(tag => {
        const found = snapshot.endpoints.find((entry: OpenRouterEndpoint) => entry.tag === tag);
        if (!found) throw new Error(`Endpoint not found in captured catalog: ${tag}`);
        return found;
      });
      const plan = comparisonPlan(entries, reference, { maxSpendUsd: Number(args['max-cost-usd']), maxCompletionRegression: Number(args['max-regression'] ?? .05), confidence: .95, maxP95LatencyRatio: Number(args['latency-ratio'] ?? 2) });
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output + '.catalog.json', JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
      writeFileSync(output + '.plan.json', JSON.stringify({ capturedAt, model, modelSubject: subject, plan }, null, 2) + '\n', { flag: 'wx' });
      const runs = args.live ? await runEndpointComparison({ repoDir, model, registry, entries, plan, certificationRoot: output + '.certifications',
        async onRun(run) { appendFileSync(output + '.runs.jsonl', JSON.stringify(run) + '\n');
          const exports = await exportComparisonRuns([run], repoDir);
          appendFileSync(output + '.exports.jsonl', JSON.stringify(exports) + '\n'); },
      }) : [];
      const report = endpointComparisonReport(plan, runs);
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ output, live: args.live === true, requiredPairs: plan.requiredPairs, scheduledRuns: plan.plannedRunCount,
        subjects: report.subjects.map(subject => ({ tag: subject.endpoint.tag, compatibility: subject.compatibility, verdict: subject.promotionVerdict })) }, null, 2));
    },
  }, argv);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runEndpointQualificationCommand();

/** Reuse the normal config/consent and idempotent queue; never bypass an opt-out. */
async function exportComparisonRuns(runs: import('../shared/lib/native-agent/certification/endpoint-comparison.ts').EndpointComparisonRun[], repoDir: string) {
  const exports: Array<{ attemptId: string; status: string }> = [];
  for (const run of runs) for (const attempt of run.result.attemptEvidence ?? []) {
    if (!attempt.contribution) { exports.push({ attemptId: attempt.attemptId, status: 'missing-evidence' }); continue; }
    if (!getHokusaiSubmissionConfig(repoDir).enabled) { exports.push({ attemptId: attempt.attemptId, status: 'disabled' }); continue; }
    try {
      const result = await enqueueContribution(attempt.contribution, { repoDir, provenance: { evalId: attempt.attemptId, source: 'live' } });
      exports.push({ attemptId: attempt.attemptId, status: result.status });
    } catch { exports.push({ attemptId: attempt.attemptId, status: 'failed' }); }
  }
  return exports;
}
