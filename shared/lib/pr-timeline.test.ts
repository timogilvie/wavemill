/**
 * HOK-3182 — PR timeline reader. The `gh` runner is injected; no network.
 * All IO under mkdtemp (HOK-3157).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchPrTimeline, parsePrTimelineOutput, type GhRunner } from './pr-timeline.ts';

let tmp: string | undefined;
function tempDir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'pr-timeline-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('pr-timeline', () => {
  it('parses newline-delimited jq output, skipping junk', () => {
    const events = parsePrTimelineOutput(`${lines([
      { event: 'labeled', at: '2026-10-07T15:21:28Z', actor: 'tim', label: 'wm:ready' },
      { event: 'merged', at: '2026-10-07T16:22:51Z', actor: 'tim' },
    ])}not json\n{"event":"labeled"}\n`);
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'merged');
  });

  it('calls gh once per PR and caches only final (merged/closed) timelines', () => {
    const dir = tempDir();
    const calls: string[][] = [];
    const final: GhRunner = (args) => {
      calls.push(args);
      return lines([{ event: 'merged', at: '2026-10-07T16:22:51Z', actor: 'tim' }]);
    };
    const opts = { repoDir: dir, nwo: 'acme/widgets', gh: final, cacheDir: join(dir, 'cache') };
    assert.equal(fetchPrTimeline(1594, opts)?.length, 1);
    assert.equal(fetchPrTimeline(1594, opts)?.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ['api', 'repos/acme/widgets/issues/1594/timeline', '--paginate']);

    const open: GhRunner = () => lines([{ event: 'labeled', at: '2026-10-07T15:21:28Z', label: 'wm:ready' }]);
    fetchPrTimeline(1700, { ...opts, gh: open });
    assert.equal(existsSync(join(dir, 'cache', '1700.json')), false);
  });

  it('returns null when gh fails so the caller can report the gap', () => {
    const dir = tempDir();
    const failing: GhRunner = () => { throw new Error('gh: not authenticated'); };
    assert.equal(fetchPrTimeline(1, { repoDir: dir, nwo: 'acme/widgets', gh: failing, cacheDir: null }), null);
  });
});
