/**
 * HOK-3260: low prompt-cache hit-rate detection. Protects that a flagged run
 * logs a warn line every time but emits at most one observer finding per
 * (model, provider route, stage, UTC day), that the threshold comes from
 * config, and that detection never throws.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { clearConfigCache } from '../config.ts';
import type { StageExecutionUsage } from '../stage-result.ts';
import { promptCacheDedupPath, reportPromptCacheHitRate } from './prompt-cache-detector.ts';

const dirs: string[] = [];

function makeRepo(config: Record<string, unknown> = { integration: { enabled: false } }): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-cache-detector-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify(config), 'utf-8');
  clearConfigCache(dir);
  return dir;
}

function findings(repoDir: string): Array<Record<string, any>> {
  const path = join(repoDir, '.wavemill', 'observer-findings.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function lowUsage(overrides: Partial<StageExecutionUsage> = {}): StageExecutionUsage {
  return {
    turnsCompleted: 3,
    totalInputTokens: 5600,
    cacheReadTokens: 4000,
    cacheWriteTokens: 4200,
    cacheHitRate: 0.4545,
    providerRoute: 'anthropic',
    ...overrides,
  };
}

const DAY_1 = () => new Date('2026-10-21T09:00:00Z');
const DAY_1_LATER = () => new Date('2026-10-21T23:59:00Z');
const DAY_2 = () => new Date('2026-10-22T00:01:00Z');

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    clearConfigCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('reportPromptCacheHitRate', () => {
  it('warns once and emits one finding for a low-hit run', () => {
    const repoDir = makeRepo();
    const warns: string[] = [];
    const result = reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'claude-sonnet-5-5',
      usage: lowUsage(),
      now: DAY_1,
      warn: (line) => warns.push(line),
    });

    assert.equal(result.finding, 'emitted');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /^\[native-coding\] low prompt-cache hit rate: 0\.455 below 0\.500 over 3 turns/);
    assert.match(warns[0], /model=claude-sonnet-5-5 provider=anthropic/);

    const rows = findings(repoDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subsystem, 'native-prompt-cache');
    assert.equal(rows[0].severity, 'medium');
    assert.equal(rows[0].context.stage, 'coding');
    assert.equal(rows[0].context.model, 'claude-sonnet-5-5');
    assert.equal(rows[0].context.providerRoute, 'anthropic');
    assert.equal(rows[0].context.dayUtc, '2026-10-21');
    assert.equal(rows[0].context.threshold, 0.5);
    // The observer derives finding ids from markerPath/markerKind.
    assert.equal(rows[0].context.markerKind, 'prompt-cache-low-hit-rate');
    assert.equal(
      rows[0].context.markerPath,
      promptCacheDedupPath(repoDir, {
        dayUtc: '2026-10-21',
        model: 'claude-sonnet-5-5',
        providerRoute: 'anthropic',
        stage: 'coding',
      }),
    );
  });

  it('deduplicates the finding on a re-run the same UTC day but still warns', () => {
    const repoDir = makeRepo();
    const warns: string[] = [];
    const input = { repoDir, stage: 'review' as const, model: 'gpt-5.4', usage: lowUsage(), warn: (l: string) => warns.push(l) };

    assert.equal(reportPromptCacheHitRate({ ...input, now: DAY_1 }).finding, 'emitted');
    assert.equal(reportPromptCacheHitRate({ ...input, now: DAY_1_LATER }).finding, 'deduplicated');

    assert.equal(findings(repoDir).length, 1);
    assert.equal(warns.length, 2);
  });

  it('emits a new finding on the next UTC day', () => {
    const repoDir = makeRepo();
    const input = { repoDir, stage: 'planning' as const, model: 'gemini-3-pro', usage: lowUsage(), warn: () => {} };

    assert.equal(reportPromptCacheHitRate({ ...input, now: DAY_1 }).finding, 'emitted');
    assert.equal(reportPromptCacheHitRate({ ...input, now: DAY_2 }).finding, 'emitted');

    assert.deepEqual(findings(repoDir).map((row) => row.context.dayUtc), ['2026-10-21', '2026-10-22']);
  });

  it('keys the dedup on model, provider route and stage', () => {
    const repoDir = makeRepo();
    const base = { repoDir, stage: 'coding' as const, model: 'm1', usage: lowUsage(), now: DAY_1, warn: () => {} };

    reportPromptCacheHitRate(base);
    reportPromptCacheHitRate({ ...base, model: 'm2' });
    reportPromptCacheHitRate({ ...base, usage: lowUsage({ providerRoute: 'openrouter' }) });
    reportPromptCacheHitRate({ ...base, stage: 'review' });

    assert.equal(findings(repoDir).length, 4);
  });

  it('does nothing for a run with fewer than 3 turns', () => {
    const repoDir = makeRepo();
    const warns: string[] = [];
    const result = reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'm',
      usage: lowUsage({ turnsCompleted: 2, cacheHitRate: 0 }),
      now: DAY_1,
      warn: (line) => warns.push(line),
    });

    assert.equal(result.finding, 'not-flagged');
    assert.deepEqual(warns, []);
    assert.deepEqual(findings(repoDir), []);
  });

  it('does nothing when the run has no hit rate', () => {
    const repoDir = makeRepo();
    const warns: string[] = [];
    reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'm',
      usage: lowUsage({ turnsCompleted: 8, cacheHitRate: null }),
      now: DAY_1,
      warn: (line) => warns.push(line),
    });

    assert.deepEqual(warns, []);
    assert.deepEqual(findings(repoDir), []);
  });

  it('does nothing for a run at or above the threshold', () => {
    const repoDir = makeRepo();
    const warns: string[] = [];
    reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'm',
      usage: lowUsage({ cacheHitRate: 0.93 }),
      now: DAY_1,
      warn: (line) => warns.push(line),
    });

    assert.deepEqual(warns, []);
    assert.deepEqual(findings(repoDir), []);
  });

  it('reads the threshold from reliability.promptCache.minHitRate', () => {
    const repoDir = makeRepo({ integration: { enabled: false }, reliability: { promptCache: { minHitRate: 0.3 } } });
    const warns: string[] = [];
    const result = reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'm',
      usage: lowUsage({ cacheHitRate: 0.4 }),
      now: DAY_1,
      warn: (line) => warns.push(line),
    });

    assert.equal(result.threshold, 0.3);
    assert.equal(result.finding, 'not-flagged');
    assert.deepEqual(warns, []);
  });

  it('still warns with the observer off, and leaves the day open for a later run', () => {
    const repoDir = makeRepo({ integration: { enabled: false }, observer: { enabled: false } });
    const warns: string[] = [];
    const input = { repoDir, stage: 'coding' as const, model: 'm', usage: lowUsage(), now: DAY_1, warn: (l: string) => warns.push(l) };

    assert.equal(reportPromptCacheHitRate(input).finding, 'skipped');
    assert.equal(warns.length, 1);
    assert.deepEqual(findings(repoDir), []);

    // Observer turned on later the same day: the run still reports once.
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({ integration: { enabled: false } }), 'utf-8');
    clearConfigCache(repoDir);
    assert.equal(reportPromptCacheHitRate(input).finding, 'emitted');
    assert.equal(findings(repoDir).length, 1);
  });

  it('warns without a finding when no repo dir is known', () => {
    const warns: string[] = [];
    const result = reportPromptCacheHitRate({
      repoDir: undefined,
      stage: 'review',
      model: 'm',
      usage: lowUsage(),
      threshold: 0.5,
      warn: (line) => warns.push(line),
    });

    assert.equal(result.finding, 'skipped');
    assert.equal(warns.length, 1);
  });

  it('never throws when the finding cannot be written', () => {
    const repoDir = makeRepo();
    // A file where the .wavemill directory should be makes every write fail.
    writeFileSync(join(repoDir, '.wavemill'), 'not a directory', 'utf-8');
    const result = reportPromptCacheHitRate({
      repoDir,
      stage: 'coding',
      model: 'm',
      usage: lowUsage(),
      now: DAY_1,
      warn: () => {},
    });

    assert.equal(result.finding, 'skipped');
    assert.equal(result.warned, true);
  });
});
