#!/usr/bin/env bash
# protects: the planner keeps conflicting tasks apart even when its judge says independent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGroundedPlanning } from './shared/lib/grounded-planner.ts';
import { buildQueuePlan, selectLaunchSet } from './shared/lib/plan-queue-utils.ts';
import { planTaskDependencies } from './shared/lib/task-dependency-planner.ts';
const repo = mkdtempSync(join(tmpdir(), 'grounded-overlap-'));
try {
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'journey@example.invalid');
  git('config', 'user.name', 'Journey');
  writeFileSync(join(repo, 'service.ts'), 'export const value = 0;\n');
  git('add', 'service.ts'); git('commit', '-qm', 'base');
  const tasks = [1, 2].map(n => ({ id: `JRN-${n}`, title: 'Update service.ts', description: 'Edit `service.ts`', fingerprint: `fp${n}` }));
  const calls = [];
  const plan = await runGroundedPlanning(tasks, {
    repoDir: repo, coChange: null,
    llm: async (prompt, kind) => { calls.push(kind); return { text: '{"verdicts":[]}' }; },
  });
  assert.equal(plan.deterministicConflicts.length, 1);
  assert.deepEqual(plan.deterministicConflicts[0].files, ['service.ts']);
  assert.equal(plan.stats.pairsSentToLlm, 0);
  const queue = planTaskDependencies(tasks, plan.edges);
  const launch = selectLaunchSet(buildQueuePlan(plan.edges, queue), tasks.map(t => ({ id: t.id, score: 1 })), { freeSlots: 2 });
  assert.equal(launch.launchNext.length, 1);
  assert.equal(launch.held.length, 1);
  assert.deepEqual(launch.held[0].detail.files, ['service.ts']);
  assert.equal(plan.waves.waves.length, 2);
  // Execute the scheduled waves against the real repo; no concurrent writes or operator recovery.
  for (const [index, wave] of plan.waves.waves.entries()) {
    assert.equal(wave.taskIds.length, 1);
    writeFileSync(join(repo, 'service.ts'), `export const value = ${index + 1};\n`);
    git('add', 'service.ts'); git('commit', '-qm', wave.taskIds[0]);
  }
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '3');
  assert.equal(git('status', '--porcelain').trim(), '');
  console.log('grounded-overlap journey: deterministic conflict -> separate waves -> clean commits');
} finally { rmSync(repo, { recursive: true, force: true }); }
JS
