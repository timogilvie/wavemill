import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserSession, type BrowserAdapter } from '../browser-session.ts';
import { buildBaselinePng, buildChangedPng } from '../fixtures/images.ts';
import { loadImageArtifact, storeImageArtifact } from '../image-artifacts.ts';
import { createScreenshotTools } from './screenshot.ts';

function makeRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'screenshot-tools-'));
  writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
    nativeAgent: { advanced: { screenshot: { enabled: true, allowedPhases: ['review'] } } },
  }));
  return repoDir;
}

function fixtureAdapter(image = buildBaselinePng()): BrowserAdapter {
  return {
    async navigate() { return { finalUrl: 'https://example.test/page', status: 200, title: 'Fixture', loadTimeMs: 1 }; },
    async snapshotDom() { return ''; }, async snapshotAccessibility() { return []; },
    async drainConsole() { return []; }, async drainRequests() { return []; }, async close() {},
    async screenshot() { return { data: image, mediaType: 'image/png', viewport: { width: 100, height: 100 }, browserName: 'fixture', browserVersion: '1' }; },
  };
}

function fixtureSession(): BrowserSession {
  return new BrowserSession({ limits: {
    allowedOrigins: ['https://example.test'], maxSessionLifetimeMs: 60_000, maxCallsPerSession: 10,
    navigateTimeoutMs: 1_000, maxDomBytes: 100, maxAxNodes: 10, maxConsoleMessages: 10, maxRequestSummaries: 10,
  }, adapter: fixtureAdapter() });
}

test('screenshot tools remain hidden unless explicitly enabled', () => {
  assert.equal(createScreenshotTools().descriptors.length, 0);
});

test('browser_screenshot stores a protected artifact and returns bounded metadata', async () => {
  const repoDir = makeRepo();
  try {
    const browser = fixtureSession();
    await browser.navigate('https://example.test/page');
    const tool = createScreenshotTools(async () => browser, repoDir).descriptors[0];
    const result = await tool.execute('capture', {});
    const details = result.details as { ref: string; url: string; origin: string; byteSize: number };
    assert.match(details.ref, /^artifact:\/\/[a-f0-9]{64}$/);
    assert.equal(details.url, 'https://example.test/page');
    assert.equal(details.origin, 'https://example.test');
    assert.ok(details.byteSize > 0);
    assert.doesNotMatch(result.content[0].text, /iVBORw0KGgo/);
    const stored = loadImageArtifact(details.ref, repoDir);
    assert.ok(!('code' in stored));
    assert.equal(stored.meta?.browser?.name, 'fixture');
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test('browser_screenshot reports browser_disabled before a browser session exists', async () => {
  const repoDir = makeRepo();
  try {
    const tool = createScreenshotTools(async () => null, repoDir).descriptors[0];
    const result = await tool.execute('capture', {});
    assert.deepEqual(result.details, { error: 'browser_disabled', message: 'browser session not available' });
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test('screenshot_compare accepts only artifact refs and returns bounded diff metadata', async () => {
  const repoDir = makeRepo();
  try {
    const baseline = buildBaselinePng();
    const changed = buildChangedPng();
    const put = (bytes: Buffer) => storeImageArtifact(bytes, { mediaType: 'image/png', width: 100, height: 100, kind: 'screenshot', digest: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }, repoDir);
    const base = put(baseline);
    const current = put(changed);
    const tool = createScreenshotTools(undefined, repoDir).descriptors[1];
    const result = await tool.execute('compare', { baselineRef: base.ref, currentRef: current.ref });
    const details = result.details as { comparable: boolean; diffPixels: number; diffRef?: string };
    assert.equal(details.comparable, true);
    assert.ok(details.diffPixels > 0);
    assert.match(details.diffRef ?? '', /^artifact:\/\/[a-f0-9]{64}$/);
    const rejected = await tool.execute('compare', { baselineRef: '/tmp/nope', currentRef: current.ref });
    assert.equal((rejected.details as { reason: string }).reason, 'invalid_ref');
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});
