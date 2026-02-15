import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer } from './session-timer.js';

describe('createTimer', () => {
  it('returns 0 before start', () => {
    const t = createTimer();
    assert.equal(t.elapsed(), 0);
    assert.equal(t.pausedTime(), 0);
  });

  it('tracks elapsed time after start', async () => {
    const t = createTimer();
    t.start();
    await sleep(50);
    const elapsed = t.elapsed();
    assert.ok(elapsed >= 30, `Expected >= 30ms, got ${elapsed}`);
    assert.ok(elapsed <= 150, `Expected <= 150ms, got ${elapsed}`);
  });

  it('excludes paused time from elapsed', async () => {
    const t = createTimer();
    t.start();
    await sleep(50);
    t.pause();
    await sleep(100); // paused — should be excluded
    t.resume();
    await sleep(50);
    const elapsed = t.elapsed();
    const paused = t.pausedTime();

    // Elapsed should be ~100ms (50 + 50), not ~200ms
    assert.ok(elapsed >= 60, `Elapsed too low: ${elapsed}`);
    assert.ok(elapsed <= 250, `Elapsed too high: ${elapsed}`);
    // Paused should be ~100ms
    assert.ok(paused >= 70, `Paused too low: ${paused}`);
    assert.ok(paused <= 200, `Paused too high: ${paused}`);
  });

  it('handles multiple pause/resume cycles', async () => {
    const t = createTimer();
    t.start();
    await sleep(30);
    t.pause();
    await sleep(50);
    t.resume();
    await sleep(30);
    t.pause();
    await sleep(50);
    t.resume();
    await sleep(30);

    const elapsed = t.elapsed();
    const paused = t.pausedTime();

    // Active: ~90ms (30+30+30), Paused: ~100ms (50+50)
    assert.ok(elapsed >= 50, `Elapsed too low: ${elapsed}`);
    assert.ok(elapsed <= 250, `Elapsed too high: ${elapsed}`);
    assert.ok(paused >= 60, `Paused too low: ${paused}`);
    assert.ok(paused <= 250, `Paused too high: ${paused}`);
  });

  it('reports isPaused correctly', () => {
    const t = createTimer();
    assert.equal(t.isPaused(), false);
    t.start();
    assert.equal(t.isPaused(), false);
    t.pause();
    assert.equal(t.isPaused(), true);
    t.resume();
    assert.equal(t.isPaused(), false);
  });

  it('ignores duplicate pause calls', async () => {
    const t = createTimer();
    t.start();
    await sleep(30);
    t.pause();
    t.pause(); // duplicate — should be ignored
    await sleep(50);
    t.resume();
    const paused = t.pausedTime();
    assert.ok(paused >= 30, `Paused too low: ${paused}`);
    assert.ok(paused <= 150, `Paused too high: ${paused}`);
  });

  it('ignores resume without pause', () => {
    const t = createTimer();
    t.start();
    t.resume(); // no-op — not paused
    assert.equal(t.isPaused(), false);
    assert.equal(t.pausedTime(), 0);
  });

  it('ignores operations before start', () => {
    const t = createTimer();
    t.pause();
    t.resume();
    assert.equal(t.elapsed(), 0);
    assert.equal(t.pausedTime(), 0);
    assert.equal(t.isPaused(), false);
  });

  it('reports elapsed correctly while paused', async () => {
    const t = createTimer();
    t.start();
    await sleep(50);
    t.pause();
    await sleep(50);
    // While still paused, elapsed should not include current pause
    const elapsed = t.elapsed();
    assert.ok(elapsed >= 30, `Elapsed too low: ${elapsed}`);
    assert.ok(elapsed <= 150, `Elapsed too high (includes pause?): ${elapsed}`);
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
