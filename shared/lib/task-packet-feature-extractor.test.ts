import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CANONICAL_PACKET_SECTIONS,
  extractPacketFeatures,
  TaskPacketNotFoundError,
} from './task-packet-feature-extractor.ts';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const fixture = path.join(repoRoot, 'tests/fixtures/router-signal-corpus/hok-2845-greenfield.md');

describe('task-packet-feature-extractor', () => {
  it('extracts a complete deterministic feature shape from a task packet', async () => {
    const features = await extractPacketFeatures(fixture);
    assert.equal(features.packet_path, fixture);
    assert.ok(['full', 'header'].includes(features.format));
    for (const section of CANONICAL_PACKET_SECTIONS) {
      assert.equal(typeof features.section_lengths[section], 'number');
      assert.ok(features.section_lengths[section] >= 0);
    }
    assert.ok(Number.isInteger(features.file_count));
    assert.ok(features.file_count >= 1);
    assert.ok(Number.isInteger(features.req_tag_count));
    assert.ok(Number.isFinite(features.difficulty));
  });

  it('sets missing section lengths to zero without throwing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packet-features-'));
    try {
      const packet = path.join(dir, 'task-packet.md');
      writeFileSync(packet, '# Task Packet\n\n## Objective\n\nDo a thing.\n\n## Validation\n\n- Run tests.\n', 'utf-8');
      const features = await extractPacketFeatures(packet);
      assert.equal(features.section_lengths.objective > 0, true);
      assert.equal(features.section_lengths.rollback_plan, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a conventional packet from an artifact directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packet-dir-'));
    try {
      const packet = path.join(dir, 'task-packet.md');
      writeFileSync(packet, '# Task Packet\n\n## Objective\n\nDo a thing.\n', 'utf-8');
      const features = await extractPacketFeatures(dir);
      assert.equal(features.packet_path, packet);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws TaskPacketNotFoundError for missing paths', async () => {
    await assert.rejects(
      () => extractPacketFeatures('/tmp/definitely-not-a-task-packet.md'),
      TaskPacketNotFoundError,
    );
  });

  it('returns default zeros for present non-packet content', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'packet-malformed-'));
    try {
      const packet = path.join(dir, 'task-packet.md');
      writeFileSync(packet, 'hello', 'utf-8');
      const features = await extractPacketFeatures(packet);
      assert.equal(features.total_chars, 0);
      assert.equal(features.file_count, 0);
      assert.equal(features.section_lengths.objective, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
