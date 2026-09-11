#!/usr/bin/env tsx
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  type SoakSample,
  buildCertificationArtifact,
  writeCertificationReport,
} from '../shared/lib/terminal-lifecycle-cert.ts';

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseDurationMs(value: string | undefined): number {
  if (!value) return 0;
  const match = /^([0-9]+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`Invalid --duration value: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return amount * multipliers[unit];
}

function countDirEntries(dir: string, predicate: (name: string) => boolean = () => true): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(predicate).length;
}

function sample(repoDir: string, cycle: number): SoakSample {
  const tmux = spawnSync('tmux', ['list-panes', '-a'], { encoding: 'utf-8' });
  const tmuxPanes = tmux.status === 0 ? tmux.stdout.trim().split('\n').filter(Boolean).length : 0;
  const worktree = spawnSync('git', ['-C', repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8' });
  const worktrees = worktree.status === 0
    ? worktree.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length
    : 0;
  const branches = spawnSync('git', ['-C', repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/task/'], { encoding: 'utf-8' });
  return {
    cycle,
    timestamp: new Date().toISOString(),
    tmuxPanes,
    worktrees,
    branches: branches.status === 0 ? branches.stdout.trim().split('\n').filter(Boolean).length : 0,
    tempEntries: countDirEntries(process.env.TMPDIR ?? '/tmp', (name) => name.startsWith('wavemill-incident-') || name.startsWith('wavemill-terminal-lifecycle-')),
    repeatedEpisodesBeforeRetry: 0,
  };
}

const args = process.argv.slice(2);
const repoDir = resolve(argValue(args, '--repo-dir') ?? process.cwd());
const outDir = resolve(repoDir, argValue(args, '--out') ?? '.wavemill/terminal-lifecycle-cert/reports');
const runId = argValue(args, '--run-id') ?? `terminal-lifecycle-soak-${Date.now()}`;
const durationMs = parseDurationMs(argValue(args, '--duration'));
const iterations = Number(argValue(args, '--iterations') ?? (durationMs > 0 ? Number.POSITIVE_INFINITY : 1));
const started = Date.now();
const samples: SoakSample[] = [];
mkdirSync(outDir, { recursive: true });
const jsonlPath = join(outDir, `${runId}.samples.jsonl`);

let cycle = 0;
while (cycle < iterations && (durationMs === 0 || Date.now() - started < durationMs)) {
  cycle += 1;
  const driver = spawnSync('bash', ['tests/terminal-lifecycle-cert-matrix.test.sh'], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, WAVEMILL_TERMINAL_CERT_SCENARIOS: process.env.WAVEMILL_TERMINAL_CERT_SCENARIOS ?? 'smoke' },
  });
  if (driver.status !== 0) {
    process.stderr.write(driver.stdout);
    process.stderr.write(driver.stderr);
    process.exit(driver.status ?? 1);
  }
  const next = sample(repoDir, cycle);
  samples.push(next);
  appendFileSync(jsonlPath, `${JSON.stringify(next)}\n`, 'utf-8');
}

const artifact = buildCertificationArtifact({ repoDir, runId, soakSamples: samples });
const written = writeCertificationReport(artifact, outDir);
console.log(JSON.stringify({
  ok: artifact.gates.soak.pass && artifact.gates.shadow.pass,
  samples: jsonlPath,
  jsonPath: written.jsonPath,
  markdownPath: written.markdownPath,
  gates: artifact.gates,
}, null, 2));
process.exit(artifact.gates.soak.pass && artifact.gates.shadow.pass ? 0 : 1);
