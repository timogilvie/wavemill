import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scoreTaskPacket, type TaskScorerResult } from './task-packet-scorer.ts';
import { extractPacketFeatures, TaskPacketNotFoundError, type PacketFeatures, CANONICAL_SECTIONS } from './task-packet-feature-extractor.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const FIXTURE = join(REPO_ROOT, 'tests/fixtures/router-signal-corpus/hok-2845-greenfield.md');

function makeMinimalFeatures(overrides?: Partial<PacketFeatures>): PacketFeatures {
  const section_lengths = {} as Record<typeof CANONICAL_SECTIONS[number], number>;
  for (const s of CANONICAL_SECTIONS) section_lengths[s] = 0;
  return {
    section_lengths,
    total_chars: 0,
    file_count: 0,
    req_tag_count: 0,
    validation_scenario_count: 0,
    vague_phrase_count: 0,
    difficulty: 1,
    ...overrides,
  };
}

describe('task-packet-scorer', () => {
  it('returns a valid result for the fixture', async () => {
    const features = await extractPacketFeatures(FIXTURE);
    const result = scoreTaskPacket(features);

    assert.ok(
      ['run', 'expand', 'split', 'return'].includes(result.decision),
      `Invalid decision: ${result.decision}`,
    );
    assert.ok(result.confidence >= 0 && result.confidence <= 1, 'Confidence must be [0,1]');
    assert.ok(result.explanation.length > 0, 'Explanation must be non-empty');
    assert.ok(result.model_version.length > 0, 'model_version must be non-empty');
  });

  it('returns low confidence for an empty packet', () => {
    const features = makeMinimalFeatures();
    const result = scoreTaskPacket(features);

    assert.ok(result.confidence < 0.5, 'Empty packet should have low confidence');
    assert.notStrictEqual(result.decision, 'run', 'Empty packet should not be run');
  });

  it('returns higher confidence for a well-structured packet', () => {
    const section_lengths = {} as Record<typeof CANONICAL_SECTIONS[number], number>;
    for (const s of CANONICAL_SECTIONS) section_lengths[s] = 500;

    const features = makeMinimalFeatures({
      section_lengths,
      total_chars: 5000,
      file_count: 5,
      req_tag_count: 3,
      validation_scenario_count: 5,
      vague_phrase_count: 0,
      difficulty: 3,
    });

    const result = scoreTaskPacket(features);
    assert.ok(result.confidence > 0.5, 'Well-structured packet should have higher confidence');
  });

  it('is deterministic', async () => {
    const features = await extractPacketFeatures(FIXTURE);
    const a = scoreTaskPacket(features);
    const b = scoreTaskPacket(features);
    assert.strictEqual(a.decision, b.decision);
    assert.strictEqual(a.confidence, b.confidence);
  });

  it('model_version follows expected format', async () => {
    const features = await extractPacketFeatures(FIXTURE);
    const result = scoreTaskPacket(features);
    assert.match(result.model_version, /^v\d+/, 'model_version should start with v');
  });

  it('all result fields are present', () => {
    const features = makeMinimalFeatures({ total_chars: 1000, file_count: 2 });
    const result = scoreTaskPacket(features);
    assert.equal(typeof result.decision, 'string');
    assert.ok(['run', 'expand', 'split', 'return'].includes(result.decision));
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.explanation, 'string');
    assert.ok(result.explanation.length > 0);
    assert.equal(typeof result.model_version, 'string');
  });

  it('difficulty adjustment nudges borderline expand toward run', () => {
    const section_lengths = {} as Record<typeof CANONICAL_SECTIONS[number], number>;
    for (const s of CANONICAL_SECTIONS) section_lengths[s] = 0;
    section_lengths.objective = 150;
    section_lengths.implementation_approach = 200;
    section_lengths.success_criteria = 100;

    const features = makeMinimalFeatures({
      section_lengths,
      total_chars: 600,
      file_count: 2,
      req_tag_count: 0,
      validation_scenario_count: 0,
      vague_phrase_count: 0,
      difficulty: 4,
    });
    const result = scoreTaskPacket(features);
    assert.equal(result.decision, 'run');
  });
});

describe('extractPacketFeatures', () => {
  it('returns all canonical section keys', async () => {
    const features = await extractPacketFeatures(FIXTURE);
    for (const section of CANONICAL_SECTIONS) {
      assert.ok(section in features.section_lengths, `missing section key: ${section}`);
      assert.ok(features.section_lengths[section] >= 0, `non-negative: ${section}`);
    }
  });

  it('resolves task-packet.md from an artifact directory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'scorer-test-'));
    await writeFile(join(tmpDir, 'task-packet.md'), '## 1. Objective\n\nDo something.\n');
    try {
      const features = await extractPacketFeatures(tmpDir);
      assert.ok(features.total_chars > 0);
      assert.ok(features.section_lengths.objective > 0);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('throws TaskPacketNotFoundError for missing path', async () => {
    await assert.rejects(
      extractPacketFeatures('/nonexistent/path/to/nothing'),
      (err: unknown) => err instanceof TaskPacketNotFoundError,
    );
  });

  it('produces deterministic output', async () => {
    const a = await extractPacketFeatures(FIXTURE);
    const b = await extractPacketFeatures(FIXTURE);
    assert.deepStrictEqual(a, b);
  });
});
