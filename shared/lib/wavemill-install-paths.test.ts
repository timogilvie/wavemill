import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { TERMINAL_RECONCILER_SCRIPT, WAVEMILL_COMMON_SCRIPT } from './terminal-inbox-cleanup.ts';

// Wavemill's shell libraries and prompts ship with the install. Joining them
// onto the milled repo's dir only works when the mill runs on wavemill itself;
// in any other repo `wavemill cleanup` and native heartbeats silently break.

test('terminal inbox cleanup sources shell libs from the wavemill install', () => {
  for (const script of [WAVEMILL_COMMON_SCRIPT, TERMINAL_RECONCILER_SCRIPT]) {
    assert.ok(isAbsolute(script), script);
    assert.ok(existsSync(script), script);
  }
});

test('no shared/lib module resolves wavemill shell libs or prompts under a repo dir', () => {
  const offenders: string[] = [];
  const pattern = /join\(\s*[\w.]*repoDir\s*,\s*'(shared\/lib|tools\/prompts)\//i;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.ts') && !file.endsWith('.test.ts') && pattern.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }
  };
  walk('shared/lib');
  assert.deepEqual(offenders, []);
});
