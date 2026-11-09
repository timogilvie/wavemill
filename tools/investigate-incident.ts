#!/usr/bin/env -S npx tsx
/**
 * Background runner for root-cause investigations (HOK-3325).
 *
 * Reads an investigation request marker written by the observer, loads the
 * incident from the local IncidentStore, runs the root-cause skill via
 * `investigateConfirmedIncident`, and persists the payload under
 * `.wavemill/incidents/<fingerprint>/investigation-<revision>.json`.
 *
 * Exit 0 when an artefact was produced (ready, draft, or skipped); exit 1
 * on an unexpected crash. The launcher is responsible for bounded retry.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { investigateConfirmedIncident } from '../shared/lib/root-cause-escalation.ts';
import { reconcileIncidentForFiling } from '../shared/lib/incident-filing-reconciler.ts';
import { IncidentStore } from '../shared/lib/wavemill-incident-store.ts';

export interface InvestigationRequest {
  readonly fingerprint: string;
  readonly repoDir: string;
  readonly evidenceRevision: string;
  readonly requestedAt: string;
}

function readRequest(path: string): InvestigationRequest {
  if (!existsSync(path)) {
    throw new Error(`investigation request not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`malformed investigation request: ${path}`);
  }
  const req = raw as Partial<InvestigationRequest>;
  if (!req.fingerprint || !req.repoDir || !req.evidenceRevision) {
    throw new Error(`investigation request missing required fields: ${path}`);
  }
  return req as InvestigationRequest;
}

function resolveRepoDir(repoDir: string): string {
  return isAbsolute(repoDir) ? repoDir : join(process.cwd(), repoDir);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requestPath = args.find((arg) => arg.startsWith('--request='))?.slice('--request='.length)
    ?? args[args.indexOf('--request') + 1];
  if (!requestPath) {
    process.stderr.write('Usage: investigate-incident.ts --request <path>\n');
    process.exit(2);
  }

  const request = readRequest(requestPath);
  const repoDir = resolveRepoDir(request.repoDir);
  const storeDir = join(repoDir, '.wavemill', 'incidents');
  const store = new IncidentStore(storeDir);
  const incident = await store.getIncident(request.fingerprint);
  if (!incident) {
    process.stderr.write(`incident ${request.fingerprint} not found in ${storeDir}\n`);
    process.exit(1);
  }

  // A queued request can be superseded while another revision is running.
  if (store.computeEvidenceRevision(incident) !== request.evidenceRevision) return;
  const reconciliation = reconcileIncidentForFiling(incident, repoDir);
  const outcome = await investigateConfirmedIncident({
    incident,
    repoDir,
    reconciliation,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    fingerprint: request.fingerprint,
    state: outcome.state,
    reason: outcome.reason,
    mode: outcome.payload?.mode,
  }, null, 2));

  if (outcome.state === 'exhausted') {
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`investigate-incident failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
