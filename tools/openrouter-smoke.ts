#!/usr/bin/env -S npx tsx

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchOpenRouterModels,
  loadLaunchPriorityFixture,
  normalizeCatalog,
  resolveOpenRouterModelIdentity,
  resolveWavemillAliasFromOpenRouterId,
  type ModelFamily,
  type NormalizedCatalogEntry,
} from '../shared/lib/openrouter-catalog.ts';
import { runOpenRouterSmoke } from '../shared/lib/openrouter-smoke.ts';
import type { SmokeReport } from '../shared/lib/openrouter-smoke.ts';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import type { OpenRouterTransport } from '../shared/lib/openrouter-runtime.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(moduleDir, '..', 'shared', 'fixtures', 'openrouter-responses', 'success');
const OPENROUTER_URL_PATTERN = /https:\/\/openrouter\.ai\/\S+/g;
export const WATCHLIST_SMOKE_MODELS = [
  'qwen-3-235b',
  'kimi-k2-thinking',
  'mistral-medium-3',
] as const;

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

export function createDryRunEntries(): NormalizedCatalogEntry[] {
  const fixture = loadLaunchPriorityFixture();
  const mockModels = new Map(
    fixture.models.map((model) => [
      model.openrouterId,
      {
        id: model.openrouterId,
        context_length: 200_000,
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
    ]),
  );
  return normalizeCatalog(fixture.models, mockModels, { resolvedAt: 'dry-run' }).entries
    .filter((entry) => resolveOpenRouterModelIdentity(entry.wavemillAlias)?.nativeOpenRouter === true);
}

export function createDryRunTransport(entries: readonly NormalizedCatalogEntry[]): OpenRouterTransport {
  const familyFixtures = new Map<ModelFamily, Record<string, unknown>>([
    ['claude', readFixture('claude')],
    ['gpt', readFixture('gpt')],
    ['qwen', readFixture('qwen')],
    ['deepseek', readFixture('deepseek')],
    ['kimi', readFixture('kimi')],
    ['gemini', readFixture('gemini')],
    ['glm', readFixture('glm')],
    ['llama', readFixture('qwen')],
    ['mistral', readFixture('qwen')],
    ['grok', readFixture('qwen')],
  ]);
  const familyByOpenrouterId = new Map(entries.map((entry) => [entry.openrouterId, entry.family]));

  return async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { model: string };
    const family = familyByOpenrouterId.get(payload.model) ?? 'qwen';
    const baseFixture = familyFixtures.get(family) ?? familyFixtures.get('qwen');
    const alias = resolveWavemillAliasFromOpenRouterId(payload.model) ?? payload.model;
    return jsonResponse({
      ...baseFixture,
      id: `dry-run-${alias}`,
      model: payload.model,
    });
  };
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function selectSmokeEntries(
  entries: readonly NormalizedCatalogEntry[],
  filters: { models?: string[]; families?: string[] },
): NormalizedCatalogEntry[] {
  const requestedModels = [...new Set(filters.models ?? [])];
  const requestedFamilies = [...new Set(filters.families ?? [])];
  if (requestedModels.length === 0 && requestedFamilies.length === 0) {
    return [...entries];
  }

  const modelSet = new Set(requestedModels);
  const familySet = new Set(requestedFamilies);
  const selected = entries.filter((entry) => {
    const modelMatches = modelSet.size === 0
      || modelSet.has(entry.wavemillAlias)
      || modelSet.has(entry.openrouterId);
    const familyMatches = familySet.size === 0 || familySet.has(entry.family);
    return modelMatches && familyMatches;
  });

  const knownModels = new Set(entries.flatMap((entry) => [entry.wavemillAlias, entry.openrouterId]));
  const unknownModels = requestedModels.filter((model) => !knownModels.has(model));
  if (unknownModels.length > 0) {
    throw new Error(`Unknown launch-priority model(s): ${unknownModels.join(', ')}`);
  }

  const knownFamilies = new Set(entries.map((entry) => entry.family));
  const unknownFamilies = requestedFamilies.filter((family) => !knownFamilies.has(family as ModelFamily));
  if (unknownFamilies.length > 0) {
    throw new Error(`Unknown launch-priority family/families: ${unknownFamilies.join(', ')}`);
  }

  return selected;
}

export function sanitizeSmokeDetail(detail: string | undefined): string | undefined {
  if (!detail) {
    return detail;
  }
  return detail.replace(OPENROUTER_URL_PATTERN, '[openrouter-url-redacted]');
}

export function sanitizeSmokeReports(reports: readonly SmokeReport[]): SmokeReport[] {
  return reports.map((report) => report.status === 'blocker'
    ? { ...report, detail: sanitizeSmokeDetail(report.detail) }
    : { ...report });
}

function formatText(
  mode: 'dry-run' | 'live',
  reports: Awaited<ReturnType<typeof runOpenRouterSmoke>>,
): string {
  const okCount = reports.filter((report) => report.status === 'ok').length;
  const blockerCount = reports.length - okCount;
  return [
    `${mode}: ${okCount} ok, ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`,
    ...reports.map((report) =>
      report.status === 'ok'
        ? `- OK ${report.modelId}`
        : `- BLOCKER ${report.modelId} [${report.category}] ${report.detail}`),
  ].join('\n');
}

const options = {
  live: { type: 'boolean', description: 'Run the live OpenRouter smoke after the dry-run passes.' },
  json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
  prompt: { type: 'string', description: 'Override the smoke prompt (default: ping).' },
  models: { type: 'string', description: 'Comma-separated Wavemill aliases or OpenRouter IDs to smoke.' },
  watchlist: { type: 'boolean', description: 'Smoke the non-deprecated native watchlist aliases from HOK-2582.' },
  families: { type: 'string', description: 'Comma-separated launch-priority families to smoke.' },
  'repo-dir': { type: 'string', description: 'Repository directory to resolve before running.' },
} as const;

export async function runOpenRouterSmokeCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool({
    name: 'openrouter-smoke',
    description: 'Run a dry-run or gated live smoke sweep across launch-priority OpenRouter models.',
    options,
    examples: [
      'npx tsx tools/openrouter-smoke.ts --json',
      'npx tsx tools/openrouter-smoke.ts --models glm-5.2 --json',
      'npx tsx tools/openrouter-smoke.ts --watchlist --json',
      'OPENROUTER_LIVE_SMOKE=1 npx tsx tools/openrouter-smoke.ts --families qwen --live --json',
    ],
    async run({ args }) {
    process.chdir(resolveRepoDir(args['repo-dir'] as string | undefined));

    const prompt = (args.prompt as string | undefined) || 'ping';
    const filters = {
      models: args.watchlist === true
        ? [...WATCHLIST_SMOKE_MODELS, ...parseCsv(args.models as string | undefined)]
        : parseCsv(args.models as string | undefined),
      families: parseCsv(args.families as string | undefined),
    };
    const dryRunEntries = selectSmokeEntries(createDryRunEntries(), filters);
    const dryRun = sanitizeSmokeReports(await runOpenRouterSmoke({
      entries: dryRunEntries,
      transport: createDryRunTransport(dryRunEntries),
      prompt,
    }));

    if (args.live !== true) {
      const output = args.json === true
        ? JSON.stringify({ mode: 'dry-run', reports: dryRun }, null, 2)
        : formatText('dry-run', dryRun);
      console.log(output);
      return;
    }

    if (process.env.OPENROUTER_LIVE_SMOKE !== '1' || !process.env.OPENROUTER_API_KEY) {
      const message = 'live: skipped because OPENROUTER_LIVE_SMOKE=1 and OPENROUTER_API_KEY are required.';
      const output = args.json === true
        ? JSON.stringify({ mode: 'dry-run', reports: dryRun, live: { skipped: true, message } }, null, 2)
        : `${formatText('dry-run', dryRun)}\n${message}`;
      console.log(output);
      return;
    }

    const liveModels = await fetchOpenRouterModels();
    const liveEntries = selectSmokeEntries(
      normalizeCatalog(loadLaunchPriorityFixture().models, liveModels).entries
        .filter((entry) => resolveOpenRouterModelIdentity(entry.wavemillAlias)?.nativeOpenRouter === true),
      filters,
    );
    const live = sanitizeSmokeReports(await runOpenRouterSmoke({
      entries: liveEntries,
      apiKey: process.env.OPENROUTER_API_KEY,
      prompt,
    }));

    const output = args.json === true
      ? JSON.stringify({ dryRun, live }, null, 2)
      : `${formatText('dry-run', dryRun)}\n${formatText('live', live)}`;
    console.log(output);
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runOpenRouterSmokeCli();
}
