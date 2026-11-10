// wavemill-test-suite: none (ran in no suite before HOK-3466; run it or delete it)
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProjectContext } from '../shared/lib/project-context-generator.ts';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

it('initializes project context without shell errors for app/(auth) paths', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-context-special-path-'));
  const files = [
    'app/(auth)/dashboard/page.tsx',
    'app/(auth)/onboarding/page.tsx',
    'app/(auth)/settings/page.tsx',
  ];
  let stderr = '';

  t.mock.method(console, 'log', () => undefined);
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ dependencies: { react: '1.0.0' } }));
  for (const file of files) {
    mkdirSync(join(repoDir, file, '..'), { recursive: true });
    writeFileSync(join(repoDir, file), 'export default function Page() { return null; }\n');
  }

  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test User']);

  for (let i = 1; i <= 3; i++) {
    for (const file of files) {
      writeFileSync(join(repoDir, file), `export const rev = ${i};\n`, { flag: 'a' });
    }
    git(repoDir, ['add', '--', 'package.json', ...files]);
    git(repoDir, ['commit', '-m', `touch auth routes ${i}`]);
  }

  await generateProjectContext({ repoDir, force: true });

  const projectContext = readFileSync(join(repoDir, '.wavemill', 'project-context.md'), 'utf-8');
  assert.match(projectContext, /Subsystem Documentation/);
  assert.doesNotMatch(stderr, /\/bin\/bash/);
  assert.doesNotMatch(stderr, /syntax error near unexpected token/);
  assert.doesNotMatch(stderr, /unexpected EOF/);
});
