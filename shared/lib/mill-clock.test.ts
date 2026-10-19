import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { millClockNowMs, millClockSleep, resetMillClockForTests } from './mill-clock.ts';

const shellClock = join(dirname(fileURLToPath(import.meta.url)), 'mill-clock.sh');

function tickEnv(contents?: string): NodeJS.ProcessEnv {
  const file = join(mkdtempSync(join(tmpdir(), 'mill-clock-')), 'tick');
  if (contents !== undefined) writeFileSync(file, contents);
  return { WAVEMILL_TICK_CLOCK_FILE: file, WAVEMILL_TICK_CLOCK_SECONDS: '60' };
}

function shell(env: NodeJS.ProcessEnv, script: string): string {
  return execFileSync('bash', ['-c', `source "${shellClock}"; ${script}`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  }).trim();
}

describe('mill clock seam', () => {
  beforeEach(() => resetMillClockForTests());

  it('is the wall clock when no tick file is configured', async () => {
    const before = Date.now();
    const now = millClockNowMs({});
    assert.ok(now >= before && now <= Date.now());
    const started = Date.now();
    await millClockSleep(20, {});
    assert.ok(Date.now() - started >= 15);
  });

  it('derives time from the tick counter and agrees with the shell twin', () => {
    const env = tickEnv('3 1000\n');
    assert.equal(millClockNowMs(env), (1000 + 3 * 60) * 1000);
    assert.equal(shell(env, 'mill_clock_now'), String(1000 + 3 * 60));
  });

  it('shell advance keeps the epoch fixed and bumps the tick', () => {
    const env = { ...tickEnv(), WAVEMILL_TICK_CLOCK_EPOCH: '5000' };
    shell(env, 'mill_clock_advance_tick; mill_clock_advance_tick');
    assert.equal(shell(env, 'mill_clock_tick'), '2');
    assert.equal(millClockNowMs(env), (5000 + 2 * 60) * 1000);
  });

  it('sleeps resolve instantly and advance virtual time so deadline loops terminate', async () => {
    const env = tickEnv('0 1000\n');
    const deadline = millClockNowMs(env) + 30_000;
    let polls = 0;
    const started = Date.now();
    while (millClockNowMs(env) < deadline) {
      polls += 1;
      await millClockSleep(10_000, env);
    }
    assert.equal(polls, 3);
    assert.ok(Date.now() - started < 1000);
  });
});
