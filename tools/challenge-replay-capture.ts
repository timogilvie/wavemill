/**
 * CLI tool for capturing replay instances from incidents.
 *
 * Usage:
 *   npx tsx tools/challenge-replay-capture.ts <fingerprint>
 *   npx tsx tools/challenge-replay-capture.ts <fingerprint> --bad-patch path/to/bad.patch --good-patch path/to/good.patch
 *
 * @see shared/lib/challenge-replay-capture.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';
import { getIncidentConfig } from '../shared/lib/config.ts';
import { captureReplayIncident, markInstanceReady, markInstanceDraft } from '../shared/lib/challenge-replay-capture.ts';

interface CliArgs {
  fingerprint?: string;
  badPatch?: string;
  goodPatch?: string;
  taskTitle?: string;
  taskDescription?: string;
  baseSha?: string;
  repoDir?: string;
  markReady?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token.startsWith('--')) {
      const flag = token.slice(2);
      if (flag === 'bad-patch' && next) {
        args.badPatch = next;
        index += 1;
      } else if (flag === 'good-patch' && next) {
        args.goodPatch = next;
        index += 1;
      } else if (flag === 'task-title' && next) {
        args.taskTitle = next;
        index += 1;
      } else if (flag === 'task-description' && next) {
        args.taskDescription = next;
        index += 1;
      } else if (flag === 'base-sha' && next) {
        args.baseSha = next;
        index += 1;
      } else if (flag === 'repo-dir' && next) {
        args.repoDir = next;
        index += 1;
      } else if (flag === 'mark-ready') {
        args.markReady = true;
      }
    } else if (!args.fingerprint) {
      args.fingerprint = token;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.fingerprint) {
    throw new Error(
      'Missing required fingerprint argument\n' +
      'Usage: npx tsx tools/challenge-replay-capture.ts <fingerprint> [--bad-patch FILE] [--good-patch FILE]'
    );
  }

  const repoDir = args.repoDir ?? process.cwd();
  const incidentConfig = getIncidentConfig(repoDir);
  const incidentStore = new IncidentStore(incidentConfig.dir);

  // Load the incident by fingerprint
  const incident = await incidentStore.get(args.fingerprint);
  if (!incident) {
    throw new Error(`Incident not found: ${args.fingerprint}`);
  }

  console.log(`Loaded incident: ${incident.fingerprint.slice(0, 8)} (${incident.rootCauseClass})`);

  // Load patches from files if provided
  let badPatchContent = args.badPatch ? readFileSync(resolve(args.badPatch), 'utf-8') : undefined;
  let goodPatchContent = args.goodPatch ? readFileSync(resolve(args.goodPatch), 'utf-8') : undefined;

  // Capture the replay instance
  const result = captureReplayIncident({
    incident,
    badPatchContent,
    goodPatchContent,
    taskTitle: args.taskTitle,
    taskDescription: args.taskDescription,
    baseSha: args.baseSha,
    markScorable: args.markReady,
  });

  let instance = result.instance;

  // Mark as ready or draft based on completeness
  if (args.markReady && result.isComplete) {
    instance = markInstanceReady(instance, false);
  } else if (!result.isComplete) {
    instance = markInstanceDraft(instance, `Missing: ${result.missingFields.join(', ')}`);
  }

  // Output the instance
  console.log('\n--- Captured Replay Instance ---\n');
  console.log(JSON.stringify(instance, null, 2));

  if (!result.isComplete) {
    console.log('\n⚠️  Instance is incomplete. Missing fields:', result.missingFields.join(', '));
    console.log('   Provide them with: --bad-patch FILE --good-patch FILE');
  } else {
    console.log('\n✓ Instance is complete and ready for scoring.');
  }
}

await main();
