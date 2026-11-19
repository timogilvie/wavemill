#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditOpenRouterAliases,
  fetchEndpointsForAliases,
  hasBlockingAliasFindings,
  parseEndpointsFixture,
  scopeAliasAuditToBaseline,
  type AliasAuditReport,
} from '../shared/lib/openrouter-alias-audit.ts';
import {
  fetchOpenRouterModelEndpoints,
  fetchOpenRouterModels,
  loadLaunchPriorityList,
  type OpenRouterApiResponse,
  type OpenRouterEndpoint,
  type OpenRouterModel,
} from '../shared/lib/openrouter-catalog.ts';
import { DEFAULT_MODEL_REGISTRY, type ModelRegistry } from '../shared/lib/model-registry.ts';
import { loadModelRegistryCatalog } from '../shared/lib/model-registry-loader.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const DEFAULT_OUT_PATH = '.wavemill/audits/openrouter-alias-drift.json';

const options = {
  'catalog-json': { type: 'string', description: 'Raw OpenRouter /api/v1/models JSON file' },
  'endpoints-json': { type: 'string', description: 'Offline endpoints JSON keyed by model id (with --catalog-json/--fixture)' },
  fixture: { type: 'boolean', description: 'Use launch-priority fixture IDs as the catalog' },
  output: { type: 'string', description: 'Output JSON path' },
  'repo-dir': { type: 'string', description: 'Repository directory' },
  json: { type: 'boolean', description: 'Print the full audit report as JSON' },
  'no-write': { type: 'boolean', description: 'Do not write the audit report artifact' },
  'baseline-registry': {
    type: 'string',
    description: 'Registry catalog JSON from the base commit; fail only on findings for aliases this change added or edited',
  },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface OpenRouterAliasAuditToolDeps {
  fetchCatalog: () => Promise<Map<string, OpenRouterModel>>;
  fetchEndpoints: (modelId: string) => Promise<OpenRouterEndpoint[]>;
  registry: ModelRegistry;
  now: () => Date;
  /** The checked-out registry catalog, compared with `--baseline-registry`. */
  loadHeadCatalog?: () => unknown;
}

const defaultDeps: OpenRouterAliasAuditToolDeps = {
  fetchCatalog: () => fetchOpenRouterModels(),
  fetchEndpoints: (modelId) => fetchOpenRouterModelEndpoints(modelId),
  registry: DEFAULT_MODEL_REGISTRY,
  now: () => new Date(),
};

function resolveOutPath(repoDir: string, out: string | undefined): string {
  const raw = out ?? DEFAULT_OUT_PATH;
  return isAbsolute(raw) ? raw : resolve(repoDir, raw);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

function mapFromApiResponse(path: string): Map<string, OpenRouterModel> {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OpenRouterApiResponse;
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error(`Invalid OpenRouter catalog JSON at ${path}: missing data array`);
  }
  return new Map(parsed.data
    .filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
    .map((model) => [model.id, model]));
}

function fixtureCatalog(): Map<string, OpenRouterModel> {
  return new Map(loadLaunchPriorityList().map((model) => [
    model.openrouterId,
    { id: model.openrouterId },
  ]));
}

function renderHumanSummary(report: AliasAuditReport): void {
  console.log(
    `Audited ${report.checked} native-openrouter aliases. `
      + `Findings: ${report.findings.length}. Selectable findings: ${report.selectableFindings}.`,
  );
  if (report.findings.length === 0) {
    console.log('Alias drift findings: none');
    return;
  }
  console.log('Alias drift findings:');
  for (const finding of report.findings) {
    const suffix = !finding.selectable
      ? ' (retired - expected)'
      : finding.inheritedFromBaseline ? ' (inherited - registry entry unchanged by this change)' : '';
    console.log(`  ${finding.alias}\t${finding.reason}\t${finding.wireModelId ?? 'unresolved'}${suffix}`);
    if (finding.reason === 'pricing-drift') {
      console.log(`    ${finding.detail}`);
    }
  }
}

export async function runOpenRouterAliasAuditCommand(
  args: CliArgs,
  deps: OpenRouterAliasAuditToolDeps = defaultDeps,
): Promise<number> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const outPath = resolveOutPath(repoDir, args.output);
  let catalogSource: AliasAuditReport['catalogSource'] = 'live';
  let catalog: Map<string, OpenRouterModel>;
  let endpoints: Map<string, readonly OpenRouterEndpoint[]> | undefined;

  try {
    if (args['catalog-json']) {
      catalogSource = 'file';
      catalog = mapFromApiResponse(args['catalog-json']);
    } else if (args.fixture === true) {
      catalogSource = 'fixture';
      catalog = fixtureCatalog();
    } else {
      catalog = await deps.fetchCatalog();
    }
  } catch (error) {
    console.error(`OpenRouter alias audit could not load catalog: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  try {
    if (catalogSource === 'live') {
      endpoints = await fetchEndpointsForAliases(deps.registry, catalog, deps.fetchEndpoints);
    } else if (args['endpoints-json']) {
      endpoints = parseEndpointsFixture(JSON.parse(readFileSync(args['endpoints-json'], 'utf-8')));
    }
  } catch (error) {
    console.error(`OpenRouter alias audit could not load endpoints: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let report = auditOpenRouterAliases({
    registry: deps.registry,
    openRouterModels: catalog,
    openRouterEndpoints: endpoints,
    now: deps.now(),
    catalogSource,
  });
  const baselinePath = args['baseline-registry'];
  if (baselinePath) {
    // An unreadable baseline must not relax the audit: exit before scoping.
    try {
      const baseline: unknown = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      report = scopeAliasAuditToBaseline(report, (deps.loadHeadCatalog ?? loadModelRegistryCatalog)(), baseline);
    } catch (error) {
      console.error(`OpenRouter alias audit could not read baseline registry ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (args['no-write'] !== true) {
    writeAtomic(outPath, serialized);
  }
  renderHumanSummary(report);
  if (args.json === true) {
    console.log(serialized.trimEnd());
  }
  if (report.baseline && report.baseline.inheritedSelectableFindings > 0) {
    // GitHub renders this as a run annotation; elsewhere it is a plain line.
    console.log(
      `::warning title=OpenRouter alias drift not caused by this change::${report.baseline.inheritedSelectableFindings} `
        + 'selectable finding(s) sit on registry entries this change did not edit. They do not fail this run; '
        + 'the scheduled audit fails on them until the registry is reconciled (docs/model-additions.md).',
    );
  }
  return hasBlockingAliasFindings(report) ? 1 : 0;
}

export async function runOpenRouterAliasAuditCli(
  argv: string[] = process.argv.slice(2),
  deps: OpenRouterAliasAuditToolDeps = defaultDeps,
): Promise<void> {
  await runTool({
    name: 'audit-openrouter-aliases',
    description: 'Audit native OpenRouter registry aliases against the OpenRouter model catalog',
    options,
    examples: [
      'npx tsx tools/audit-openrouter-aliases.ts --json',
      'npx tsx tools/audit-openrouter-aliases.ts --catalog-json catalog.json --output reports/openrouter-alias-drift.json',
      'npx tsx tools/audit-openrouter-aliases.ts --fixture --no-write',
      'npx tsx tools/audit-openrouter-aliases.ts --no-write --baseline-registry /tmp/base-registry.json',
    ],
    async run({ args }) {
      const code = await runOpenRouterAliasAuditCommand(args, deps);
      if (code !== 0) {
        process.exit(code);
      }
    },
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runOpenRouterAliasAuditCli();
}
