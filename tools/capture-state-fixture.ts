#!/usr/bin/env -S npx tsx
/**
 * capture-state-fixture — operator-run CLI (HOK-3225 / A5)
 *
 * Thin wrapper over `shared/lib/fixture-capturer.ts`. Reads the current repo's
 * `.wavemill/workflow-state.json`, matching hooks and stage results, and
 * writes a sanitised JSON fixture to `tests/fixtures/real-state/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureFixture,
  FIXTURE_PHASES,
  type FixturePhase,
} from '../shared/lib/fixture-capturer.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const options = {
  phase: {
    type: 'string',
    description: `Fixture phase label (one of: ${FIXTURE_PHASES.join(', ')})`,
  },
  task: {
    type: 'string',
    multiple: true,
    description: 'Task id (HOK-1234 or HOK-1234_c); may be passed multiple times',
  },
  'repo-dir': { type: 'string', description: 'Repository directory to read state from' },
  session: { type: 'string', description: 'Override session name (defaults to state.session)' },
  out: { type: 'string', description: 'Output file path (default under tests/fixtures/real-state/)' },
  notes: { type: 'string', description: 'Human-readable capture notes recorded under $fixture.notes' },
  'hook-dir': { type: 'string', description: 'Override /tmp for hook files (test only)' },
  'id-prefix': { type: 'string', description: 'Sanitised id prefix (default HOK-FIXTURE)' },
  check: { type: 'boolean', description: 'Print the sanitised fixture to stdout without writing' },
  'debug-id-map': {
    type: 'boolean',
    description: 'Include the original→fixture id map under $fixture.idMap',
  },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function parsePhase(value: string | undefined): FixturePhase {
  if (!value) throw new Error('--phase is required');
  if ((FIXTURE_PHASES as readonly string[]).includes(value)) return value as FixturePhase;
  throw new Error(`invalid --phase ${JSON.stringify(value)}; expected one of ${FIXTURE_PHASES.join(', ')}`);
}

function defaultOutputPath(repoDir: string, phase: FixturePhase, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return join(repoDir, 'tests', 'fixtures', 'real-state', `${yyyy}-${mm}-${dd}-${phase}.json`);
}

function resolveOutput(repoDir: string, out: string | undefined, phase: FixturePhase, now: Date): string {
  if (!out) return defaultOutputPath(repoDir, phase, now);
  return isAbsolute(out) ? out : resolve(repoDir, out);
}

export async function runCaptureStateFixtureCommand(args: CliArgs): Promise<string> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const phase = parsePhase(args.phase);
  const taskIds = Array.isArray(args.task) ? args.task : [];
  if (taskIds.length === 0) {
    throw new Error('at least one --task <ID> argument is required');
  }
  const now = new Date();
  const fixture = await captureFixture({
    repoDir,
    taskIds,
    phase,
    ...(args.session ? { session: args.session } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
    ...(args['hook-dir'] ? { hookDir: args['hook-dir'] } : {}),
    ...(args['id-prefix'] ? { idPrefix: args['id-prefix'] } : {}),
    debugIdMap: Boolean(args['debug-id-map']),
    now: () => now,
  });
  const serialised = `${JSON.stringify(fixture, null, 2)}\n`;
  if (args.check) {
    process.stdout.write(serialised);
    return '(not written)';
  }
  const outputPath = resolveOutput(repoDir, args.out, phase, now);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialised, 'utf-8');
  const taskCount = Object.keys(fixture.workflowState.tasks ?? {}).length;
  const hookCount = Object.keys(fixture.hooks).length;
  console.log(
    `wrote ${outputPath} (phase=${phase} tasks=${taskCount} hooks=${hookCount})`,
  );
  return outputPath;
}

export async function runCaptureStateFixtureCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runTool(
    {
      name: 'capture-state-fixture',
      description:
        'Capture a sanitised real-state fixture from the live workflow-state.json, hook files, and stage artifacts.',
      options,
      examples: [
        'npx tsx tools/capture-state-fixture.ts --phase planning --task HOK-3225',
        'npx tsx tools/capture-state-fixture.ts --phase challenge-pair --task HOK-3227 --task HOK-3227_c',
        'npx tsx tools/capture-state-fixture.ts --phase ready --task HOK-3260 --check',
      ],
      run: ({ args }) => runCaptureStateFixtureCommand(args),
    },
    argv,
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runCaptureStateFixtureCli();
}
