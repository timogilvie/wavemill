#!/usr/bin/env -S npx tsx
/**
 * Run every preflight guard in tools/preflight-guards.txt (`npm run
 * test:preflight`). All guards run even when one fails, so one pass shows every
 * finding; `--record` writes which guards failed for tools/report-guard-fires.ts.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { formatStepSummary, loadGuardList, runPreflight } from '../shared/lib/preflight-runner.ts';

runTool({
  name: 'run-preflight',
  description: 'Run every preflight guard, report all failures, and optionally record per-guard results',
  options: {
    'repo-dir': { type: 'string', description: 'Repository root (default: cwd)' },
    record: { type: 'string', description: 'Write the per-guard run record (JSON) to this path' },
    concurrency: { type: 'string', description: 'Guards to run at once (default: up to 4)' },
  },
  examples: ['npx tsx tools/run-preflight.ts', 'npx tsx tools/run-preflight.ts --record preflight-guards.json'],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const concurrency = args.concurrency ? Number.parseInt(args.concurrency as string, 10) : undefined;
    const record = await runPreflight({
      repoDir,
      guards: loadGuardList(repoDir),
      concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
      onResult(result, output) {
        (result.ok ? process.stdout : process.stderr).write(output.endsWith('\n') || !output ? output : `${output}\n`);
      },
    });

    if (args.record) {
      const path = resolve(args.record as string);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatStepSummary(record));
    }

    const failed = record.guards.filter((guard) => !guard.ok);
    if (failed.length > 0) {
      console.error(`\npreflight: ${failed.length} of ${record.guards.length} guard(s) failed: ${failed.map((guard) => guard.guard).join(', ')}`);
      process.exit(1);
    }
    console.log(`preflight: ${record.guards.length} guard(s) passed in ${(record.durationMs / 1000).toFixed(1)}s`);
  },
});
