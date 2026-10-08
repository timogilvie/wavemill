// HOK-3150 §3.1: seed a scratch git repo + Wavemill-shaped task packet+plan.
// The task is small but forces at least one multi-file apply_patch, a read, a
// search, and a completion artifact. Everything lives under mkdtemp — HOK-3157
// rule: tests must not write tracked repo paths.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FixtureTask {
  readonly scratch: string;
  readonly worktree: string;
  readonly featureDir: string;
  readonly slug: string;
}

const TASK_PACKET = `# Task Packet — spike/multi-file

## Objective

Add a function \`greet(name: string)\` to \`src/a.ts\` that returns
\`"Hello, <name>!"\`. Export it from \`src/index.ts\`. Add a Node test in
\`src/a.test.ts\` that uses \`node:test\` to verify the output.

## Files to Modify

- src/a.ts (new file)
- src/index.ts (edit: add export)
- src/a.test.ts (new file)

## Validation Steps

- \`node --test src/a.test.ts\` passes.
`;

const PLAN_MD = `# Plan — spike/multi-file

1. Create src/a.ts with \`greet(name)\`.
2. Edit src/index.ts to export greet.
3. Create src/a.test.ts with a passing \`node:test\` test.
4. Run \`node --test src/a.test.ts\`.
5. Create \`.coding-complete\` with \`{"stage":"coding","confidence":"high"}\`.
`;

const SEED_INDEX = `// Seed index. Added exports will go here.
export const SEED = true;
`;

export async function createFixtureTask(): Promise<FixtureTask> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'pi-crash-'));
  const worktree = path.join(scratch, 'repo');
  await mkdir(worktree, { recursive: true });
  await mkdir(path.join(worktree, 'src'), { recursive: true });
  await writeFile(path.join(worktree, 'src', 'index.ts'), SEED_INDEX, 'utf8');
  await writeFile(path.join(worktree, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: worktree, stdio: ['ignore', 'ignore', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 'spike@local']);
  git(['config', 'user.name', 'spike']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed']);

  const slug = 'spike-multi-file';
  const featureDir = path.join(worktree, 'features', slug);
  await mkdir(featureDir, { recursive: true });
  await writeFile(path.join(featureDir, 'task-packet.md'), TASK_PACKET, 'utf8');
  await writeFile(path.join(featureDir, 'plan.md'), PLAN_MD, 'utf8');

  return { scratch, worktree, featureDir, slug };
}
