#!/usr/bin/env tsx
import { resolve } from 'node:path';
import {
  formatCanaryCohortReport,
  formatCertificationRemediationReport,
  formatMillConfigPreflightReport,
  runMillConfigPreflight,
} from '../shared/lib/mill-config-preflight.ts';

interface Args {
  repoDir: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repoDir: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--repo-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo-dir requires a value');
      }
      args.repoDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.repoDir = resolve(args.repoDir);
  return args;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`mill-config-preflight: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }

  try {
    const result = await runMillConfigPreflight(args.repoDir, { json: args.json });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.ok) {
      console.error(formatMillConfigPreflightReport(result.report));
    } else {
      if (result.report.certificationRemediation) {
        console.error(formatCertificationRemediationReport(result.report));
      }
      // Cohort alert must reach operators before coding-ready supply hits
      // zero, so it prints even when preflight succeeds.
      if (result.report.canaryCohortRefresh || result.report.canaryCohortHealth?.belowMinimum) {
        console.error(formatCanaryCohortReport(result.report));
      }
    }
    process.exit(result.ok ? 0 : 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Mill preflight internal error: ${message}`);
      console.error('Unable to validate Wavemill config before startup.');
    }
    process.exit(3);
  }
}

await main();
