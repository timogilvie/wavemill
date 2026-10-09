#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { compareParentMonitorFiles, formatDriftReport } from '../shared/lib/parent-monitor-drift.ts';
import { resolveWavemillInstallDir } from '../shared/lib/native-agent/install-paths.ts';

interface CliOptions {
  parent: string;
  monitor: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage: npx tsx tools/check-parent-monitor-drift.ts [--parent PATH] [--monitor PATH] [--json]',
    '',
    'Analyzes shell functions duplicated between the parent mill script',
    '(shared/lib/wavemill-mill.sh) and the committed monitor script',
    '(shared/lib/wavemill-monitor.sh).',
    '',
    '  --parent PATH   parent script (default: shared/lib/wavemill-mill.sh)',
    '  --monitor PATH  monitor script (default: shared/lib/wavemill-monitor.sh)',
    '  --file PATH     backwards-compatible alias for --parent',
    '  --json          emit the report as JSON',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const installDir = resolveWavemillInstallDir();
  const options: CliOptions = {
    parent: join(installDir, 'shared/lib/wavemill-mill.sh'),
    monitor: join(installDir, 'shared/lib/wavemill-monitor.sh'),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--parent' || arg === '--file') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.parent = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === '--monitor') {
      const value = argv[index + 1];
      if (!value) throw new Error('--monitor requires a path');
      options.monitor = resolve(process.cwd(), value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = compareParentMonitorFiles(
      readFileSync(options.parent, 'utf8'),
      readFileSync(options.monitor, 'utf8'),
    );

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDriftReport(report));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`check-parent-monitor-drift: ${message}`);
    process.exit(2);
  }
}

main();
