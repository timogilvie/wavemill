#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readEvalRecords, readEvalRecordsFromFile } from '../shared/lib/eval-persistence.ts';
import { getEffectiveRegistry } from '../shared/lib/model-registry.ts';
import { auditProviderEndpoints } from '../shared/lib/provider-endpoint-audit.ts';

runTool({ name: 'audit-provider-endpoints', description: 'Rank endpoint qualification opportunities from stored SDK costs and captured endpoint catalogs; no model requests or routing writes.',
  options: { references: { type: 'string', description: 'Optional explicit comparison references: model=exact-tag,model=exact-tag. Does not assert historical execution.' }, repo: { type: 'string', description: 'Repository owning eval records.' }, since: { type: 'string', description: 'Required inclusive ISO start.' },
    until: { type: 'string', description: 'Required inclusive ISO end.' }, evals: { type: 'string', description: 'Optional captured/redacted eval JSONL instead of live repository data.' }, catalogs: { type: 'string', description: 'Captured array of {model,capturedAt,endpoints,error?}.' },
    output: { type: 'string', description: 'New JSON report; existing evidence is never overwritten.' } },
  async run({ args }) {
    const repo = resolve(args.repo ?? process.cwd());
    const after = new Date(args.since ?? ''); const before = new Date(args.until ?? '');
    if (!Number.isFinite(+after) || !Number.isFinite(+before) || +after >= +before || !args.catalogs || !args.output) throw new Error('--since, --until, --catalogs and --output are required');
    const records = args.evals ? readEvalRecordsFromFile(resolve(args.evals), { after, before }) : readEvalRecords({ repoDir: repo, after, before });
    const catalogs = JSON.parse(readFileSync(args.catalogs, 'utf8'));
    const references = Object.fromEntries((args.references ?? '').split(',').filter(Boolean).map(value => { const split = value.indexOf('='); if (split <= 0 || split === value.length - 1) throw new Error('Invalid --references entry'); return [value.slice(0, split), value.slice(split + 1)]; }));
    const report = auditProviderEndpoints(records, getEffectiveRegistry(repo), catalogs, references);
    writeFileSync(args.output, JSON.stringify({ ...report, since: after.toISOString(), until: before.toISOString() }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output: args.output, tasks: report.evaluatedTasks, exclusions: report.exclusions.length,
      opportunities: report.models.filter(model => model.nativeProvider === 'openrouter').map(model => ({ model: model.model, measuredUsd: model.measuredSdkReport.totalUsd, potentialSavingsUsd: model.potentialSavingsUsd, cheapestTag: model.endpoints[0]?.tag })) }, null, 2));
  } });
