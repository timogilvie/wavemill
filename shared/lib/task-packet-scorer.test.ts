import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractPacketFeatures } from './task-packet-feature-extractor.ts';
import { scoreTaskPacket } from './task-packet-scorer.ts';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const fixture = path.join(repoRoot, 'tests/fixtures/router-signal-corpus/hok-2845-greenfield.md');

describe('task-packet-scorer', () => {
  it('returns a valid bounded decision object', async () => {
    const features = await extractPacketFeatures(fixture);
    const result = scoreTaskPacket(features);
    assert.ok(['run', 'expand', 'split', 'return'].includes(result.decision));
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(result.explanation.length > 0);
    assert.ok(result.model_version.length > 0);
  });

  it('is deterministic for identical input features', async () => {
    const features = await extractPacketFeatures(fixture);
    assert.deepEqual(scoreTaskPacket(features), scoreTaskPacket(features));
  });

  it('does not recommend run for low-information packets', () => {
    const result = scoreTaskPacket({
      packet_path: '/tmp/empty.md',
      format: 'unknown',
      section_lengths: {
        objective: 0,
        technical_context: 0,
        implementation_approach: 0,
        success_criteria: 0,
        implementation_constraints: 0,
        validation_steps: 0,
        definition_of_done: 0,
        rollback_plan: 0,
        release_readiness: 0,
      },
      file_count: 0,
      req_tag_count: 0,
      validation_scenario_count: 0,
      total_chars: 0,
      vague_phrase_density: 0,
      difficulty: 1,
    });
    assert.notEqual(result.decision, 'run');
  });
});
