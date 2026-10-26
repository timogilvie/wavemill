#!/usr/bin/env tsx
// Journey driver (HOK-3314): a long-lived observer-cycle runner. Reads one
// request per line on stdin, writes one response per line on stdout, so the
// journey script pays the tsx startup cost only once.
//
// Request shape:    {"cmd": "cycle", "observed": ["fp1", ...]}
// Response shape:   {"queueFingerprint": "...", "fresh": [...], "observed": [...]}
//
// Env:
//   OBS_HEALTH      queue-health.json path (one per journey run)
//   OBS_INCIDENTS   incidents directory path (one per journey run)

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = `${here}/../../..`;

const { DependencyHealthDetector } = await import(`${repoRoot}/shared/lib/wavemill-incident-detector.ts`);
const { IncidentStore } = await import(`${repoRoot}/shared/lib/wavemill-incident-store.ts`);

const healthPath = process.env.OBS_HEALTH;
const incidentsDir = process.env.OBS_INCIDENTS;
if (!healthPath || !incidentsDir) {
  console.error('OBS_HEALTH and OBS_INCIDENTS must be set');
  process.exit(2);
}
const repoDir = dirname(dirname(healthPath));

const store = new IncidentStore(incidentsDir);
const detector = new DependencyHealthDetector();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request: { cmd?: string; observed?: unknown };
  try {
    request = JSON.parse(trimmed);
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `invalid JSON: ${(err as Error).message}` }) + '\n');
    continue;
  }
  if (request.cmd !== 'cycle') {
    process.stdout.write(JSON.stringify({ error: `unknown cmd: ${request.cmd}` }) + '\n');
    continue;
  }

  const context = { repoDir, session: 'journey', now: new Date() };
  const candidates = detector.detectRepo(repoDir, context);
  const freshFingerprints = new Set<string>();
  const observedFingerprints = new Set<string>();

  for (const candidate of candidates) {
    const { record, freshEvent } = await store.upsertDetailed(candidate);
    if (freshEvent) freshFingerprints.add(record.fingerprint);
    observedFingerprints.add(record.fingerprint);
  }

  const extra = Array.isArray(request.observed) ? request.observed : [];
  for (const fp of extra) {
    if (typeof fp === 'string' && fp) observedFingerprints.add(fp);
  }

  await store.runResolutionSweep(
    { fresh: freshFingerprints, observed: observedFingerprints },
    () => true,
  );

  let queueFingerprint = '';
  try {
    const idx = JSON.parse(readFileSync(`${incidentsDir}/index.json`, 'utf8')) as Record<string, { rootCauseClass?: string }>;
    for (const fp of [...freshFingerprints, ...observedFingerprints]) {
      if (idx[fp]?.rootCauseClass?.startsWith('queue_')) {
        queueFingerprint = fp;
        break;
      }
    }
  } catch {
    // index may not exist on empty cycles
  }

  process.stdout.write(JSON.stringify({
    queueFingerprint,
    fresh: [...freshFingerprints],
    observed: [...observedFingerprints],
  }) + '\n');
}
