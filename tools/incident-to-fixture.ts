#!/usr/bin/env -S npx tsx
/**
 * HOK-3231 — convert recorded incident evidence into replay fixtures.
 *
 * Thin wrapper over `shared/lib/incident-fixture-converter.ts`. The business
 * logic lives there; this file only parses flags and prints results.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  evidencePathFor,
  fingerprintFromPath,
  incidentToFixture,
  listClustersFromDir,
  loadIncidentByFingerprint,
  readEvidenceLog,
  readIncidentIndex,
  resolveIncidentsDir,
  serializeFixture,
  type IncidentCluster,
  type IncidentFixture,
} from '../shared/lib/incident-fixture-converter.ts';

interface ConvertArgs {
  input: string | undefined;
  cluster: boolean;
  top: number;
  incidentsDir: string;
  outDir: string;
  stateSnapshot: string | undefined;
  expect: 'merged' | 'escalated' | undefined;
  maxObservations: number;
  check: boolean;
  force: boolean;
  homeDir: string;
  repoDir: string;
}

/** CLI entry — exported for tests. */
export async function runIncidentToFixtureCommand(args: ConvertArgs): Promise<number> {
  const dir = resolveIncidentsDir(args.incidentsDir, process.cwd());
  if (args.cluster && !existsSync(dir)) {
    console.log('No incidents found to cluster');
    return 0;
  }
  const outDir = isAbsolute(args.outDir) ? args.outDir : join(process.cwd(), args.outDir);
  if (!args.check) mkdirSync(outDir, { recursive: true });

  if (args.cluster) {
    const { clusters, warnings } = listClustersFromDir(dir, { top: args.top });
    for (const w of warnings) console.error(`WARN: ${w}`);
    if (clusters.length === 0) {
      console.log('No incidents found to cluster');
      return 0;
    }
    console.log(printClusterTable(clusters));
    let wrote = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const c = clusters[i];
      const { record, evidence } = loadIncidentByFingerprint(dir, c.representative.fingerprint);
      if (!record) {
        console.error(`SKIP ${c.class}: record missing`);
        continue;
      }
      const fixture = incidentToFixture(record, evidence, {
        fixtureIndex: i + 1,
        stateSnapshotPath: args.stateSnapshot ?? null,
        expect: args.expect,
        maxObservations: args.maxObservations,
        homeDir: args.homeDir,
        repoDir: args.repoDir,
      });
      const outPath = join(outDir, `${fixture.chain}.json`);
      wrote += writeFixture(fixture, outPath, args.check, args.force) ? 1 : 0;
    }
    console.log(`Wrote ${wrote}/${clusters.length} fixture(s)${args.check ? ' (check-only)' : ''}`);
    return wrote > 0 || args.check ? 0 : 1;
  }

  if (!args.input) {
    console.error('Error: --input <fingerprint|path> or --cluster is required');
    return 1;
  }
  const inputIsEvidencePath = args.input.endsWith('.evidence.jsonl');
  const fp = inputIsEvidencePath ? fingerprintFromPath(args.input) : args.input;
  const { record, evidence, warnings } = loadIncidentByFingerprint(dir, args.input);
  for (const w of warnings) console.error(`WARN: ${w}`);
  if (!record) {
    const path = inputIsEvidencePath ? args.input : evidencePathFor(dir, fp);
    const log = readEvidenceLog(path);
    if (log.entries.length === 0) {
      console.error(`Error: no record for ${fp} in ${dir}/index.json and no evidence at ${path}`);
      return 1;
    }
    console.error(`Error: no index record for ${fp}; cannot derive class/category`);
    return 1;
  }
  const fixture = incidentToFixture(record, evidence, {
    fixtureIndex: 1,
    stateSnapshotPath: args.stateSnapshot ?? null,
    expect: args.expect,
    maxObservations: args.maxObservations,
    homeDir: args.homeDir,
    repoDir: args.repoDir,
  });
  const fileName = `${fixture.chain}-${fp.slice(0, 12)}.json`;
  const outPath = join(outDir, fileName);
  const ok = writeFixture(fixture, outPath, args.check, args.force);
  return ok || args.check ? 0 : 1;
}

function writeFixture(fixture: IncidentFixture, outPath: string, check: boolean, force: boolean): boolean {
  const serialised = serializeFixture(fixture);
  if (check) {
    process.stdout.write(serialised);
    return true;
  }
  if (existsSync(outPath) && !force) {
    console.error(`SKIP ${basename(outPath)}: already exists (use --force to overwrite)`);
    return false;
  }
  writeFileSync(outPath, serialised);
  console.log(`wrote ${outPath}`);
  return true;
}

function printClusterTable(clusters: IncidentCluster[]): string {
  const lines: string[] = ['# rootCauseClass → records (representative)'];
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    lines.push(`${(i + 1).toString().padStart(2)}  ${c.class.padEnd(42)}  ${String(c.count).padStart(4)}  ${c.representative.fingerprint.slice(0, 12)}  [${c.categories.join(',')}]`);
  }
  return lines.join('\n');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) runTool({
  name: 'incident-to-fixture',
  description: 'Convert recorded incident evidence into replay fixtures (HOK-3231)',
  options: {
    input: { type: 'string', description: 'Fingerprint or evidence path to convert' },
    cluster: { type: 'boolean', description: 'Cluster all incidents and convert one per class' },
    top: { type: 'string', description: 'Top-N classes to convert when clustering (default 15)' },
    'incidents-dir': { type: 'string', description: 'Path to .wavemill/incidents (default <cwd>/.wavemill/incidents)' },
    'out-dir': { type: 'string', description: 'Output dir (default tests/fixtures/incident-replay/real/)' },
    'state-snapshot': { type: 'string', description: 'Optional A5 real-state fixture path recorded as provenance' },
    expect: { type: 'string', description: 'Pin convergence to merged|escalated' },
    'max-observations': { type: 'string', description: 'Cap on retained cycles per fixture (default 40)' },
    check: { type: 'boolean', description: 'Print to stdout; do not write any files' },
    force: { type: 'boolean', description: 'Overwrite existing fixtures' },
  },
  examples: [
    'npx tsx tools/incident-to-fixture.ts --cluster --top 15 --incidents-dir /path/.wavemill/incidents',
    'npx tsx tools/incident-to-fixture.ts --input <fingerprint> --expect merged',
    'npx tsx tools/incident-to-fixture.ts --cluster --check',
  ],
  async run({ args }) {
    const expect = args.expect === 'merged' || args.expect === 'escalated' ? args.expect : undefined;
    if (args.expect && !expect) {
      console.error(`Error: --expect must be merged|escalated, got ${args.expect}`);
      process.exit(1);
    }
    const home = process.env.HOME ?? '';
    const code = await runIncidentToFixtureCommand({
      input: args.input,
      cluster: Boolean(args.cluster),
      top: Number(args.top ?? 15),
      incidentsDir: args['incidents-dir'] ?? '',
      outDir: args['out-dir'] ?? 'tests/fixtures/incident-replay/real',
      stateSnapshot: args['state-snapshot'],
      expect,
      maxObservations: Number(args['max-observations'] ?? 40),
      check: Boolean(args.check),
      force: Boolean(args.force),
      homeDir: home,
      repoDir: process.cwd(),
    });
    process.exit(code);
  },
});
