#!/usr/bin/env tsx
import { resolve } from 'node:path';
import {
  buildCertificationArtifact,
  writeCertificationReport,
} from '../shared/lib/terminal-lifecycle-cert.ts';

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const repoDir = resolve(argValue(args, '--repo-dir') ?? process.cwd());
const outDir = resolve(
  repoDir,
  argValue(args, '--out') ?? '.wavemill/terminal-lifecycle-cert/reports',
);
const runId = argValue(args, '--run-id');

const artifact = buildCertificationArtifact({ repoDir, runId });
const written = writeCertificationReport(artifact, outDir);

console.log(JSON.stringify({
  ok: artifact.gates.shadow.pass && artifact.gates.soak.pass && artifact.gates.budgets.pass,
  jsonPath: written.jsonPath,
  markdownPath: written.markdownPath,
  gates: artifact.gates,
}, null, 2));
