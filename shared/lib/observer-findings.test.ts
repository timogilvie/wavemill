/**
 * Unit tests for appendObserverFinding (HOK-3102, phase 5 / D7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache } from './config.ts';
import { appendObserverFinding } from './observer-findings.ts';

function makeRepo(overlay: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  writeFileSync(join(dir, '.wavemill-config.json'), JSON.stringify(overlay), 'utf-8');
  clearConfigCache(dir);
  return dir;
}

test('observer off (integration off, observer.enabled=false): no file created', () => {
  const dir = makeRepo({ integration: { enabled: false }, observer: { enabled: false } });
  try {
    const wrote = appendObserverFinding(dir, { title: 'x' });
    assert.equal(wrote, false);
    assert.equal(existsSync(join(dir, '.wavemill', 'observer-findings.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HOK-3094: observer on by default with integration off: finding appended', () => {
  const dir = makeRepo({ integration: { enabled: false } });
  try {
    const wrote = appendObserverFinding(dir, { title: 'x' });
    assert.equal(wrote, true);
    assert.equal(existsSync(join(dir, '.wavemill', 'observer-findings.jsonl')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer off (backstage on, observer.enabled=false): no file created', () => {
  const dir = makeRepo({ integration: { enabled: true, useMillSession: true }, observer: { enabled: false } });
  try {
    const wrote = appendObserverFinding(dir, { title: 'x' });
    assert.equal(wrote, false);
    assert.equal(existsSync(join(dir, '.wavemill', 'observer-findings.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer on: one JSONL line appended', () => {
  const dir = makeRepo({
    integration: { enabled: true, useMillSession: true },
    observer: { enabled: true },
  });
  try {
    const finding = { title: 'hello', body: 'world' };
    const wrote = appendObserverFinding(dir, finding);
    assert.equal(wrote, true);
    const contents = readFileSync(join(dir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
    assert.ok(contents.endsWith('\n'));
    const line = contents.trim();
    const parsed = JSON.parse(line);
    assert.deepEqual(parsed, finding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer on + skipCapabilityCheck: writes without checking', () => {
  const dir = makeRepo({ integration: { enabled: false } });
  try {
    const wrote = appendObserverFinding(dir, { t: 1 }, { skipCapabilityCheck: true });
    assert.equal(wrote, true);
    const contents = readFileSync(join(dir, '.wavemill', 'observer-findings.jsonl'), 'utf-8');
    assert.ok(contents.includes('"t":1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
