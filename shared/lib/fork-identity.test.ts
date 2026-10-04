import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyForkIdentityFallback, computeForkIdentity, hashFileSet, readForkIdentity } from './fork-identity.ts';
import { foldAttestationsIntoStageAttribution } from './challenge-execution-contract.ts';
import { attachChallengeExecutionMetadata } from './eval-record-builder.ts';
import type { EvalRecord } from './eval-schema.ts';

const FORK_REASON_CODES = new Set([
  'missing_fork_identity',
  'unverified_fork_commit',
  'task_packet_hash_mismatch',
  'plan_hash_mismatch',
  'prompt_hash_mismatch',
  'tool_config_hash_mismatch',
  'divergent_pre_stage_inputs',
]);

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function seedFork() {
  const root = mkdtempSync(join(tmpdir(), 'fork-identity-'));
  const install = join(root, 'install');
  write(join(install, 'tools/prompts/review-general.md'), 'review template');
  write(join(install, 'shared/lib/agent-adapters.sh'), 'build_review_prompt() { :; }');
  write(join(install, 'shared/hooks/claude-status-hook.sh'), 'hook');
  const repo = join(root, 'repo');
  write(join(repo, '.wavemill-config.json'), '{}');
  const primaryWt = join(root, 'wt/foo');
  const challengerWt = join(root, 'wt/foo-challenger');
  const primaryFeature = join(primaryWt, 'features/foo');
  const challengerFeature = join(challengerWt, 'features/foo-challenger');
  for (const dir of [primaryFeature, challengerFeature]) {
    write(join(dir, 'task-packet.md'), 'packet');
    write(join(dir, 'task-packet-header.md'), 'header');
    write(join(dir, 'plan.md'), 'plan');
    write(join(dir, 'selected-task.json'), '{"issue":"HOK-1"}');
  }
  const input = {
    repoDir: repo,
    installDir: install,
    forkStage: 'review' as const,
    forkCommit: 'abc123',
    primaryWorktree: primaryWt,
    challengerWorktree: challengerWt,
    primaryFeatureDir: primaryFeature,
    challengerFeatureDir: challengerFeature,
    challengerInheritedStages: ['plan', 'implementation'] as const as Array<'plan' | 'implementation'>,
    resolveTree: () => 'tree123',
  };
  return { root, input, primaryFeature, challengerFeature, primaryWt, challengerWt, install };
}

test('computeForkIdentity records every hash when both arms agree', () => {
  const { root, input } = seedFork();
  try {
    const { identity, diagnostics } = computeForkIdentity(input);
    assert.equal(identity.stage, 'review');
    assert.equal(identity.commit, 'abc123');
    assert.equal(identity.tree, 'tree123');
    for (const field of ['taskPacketHash', 'planHash', 'promptHash', 'toolConfigHash'] as const) {
      assert.match(identity[field] ?? '', /^[0-9a-f]{64}$/, field);
      assert.equal(diagnostics[field], 'match', field);
    }
    assert.equal(identity.sharedPrefix, true);
    assert.deepEqual(identity.challengerInheritedStages, ['plan', 'implementation']);
    assert.ok(identity.producer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a computed identity clears every fork-related attribution reason', () => {
  const { root, input } = seedFork();
  try {
    const { identity } = computeForkIdentity(input);
    const attribution = foldAttestationsIntoStageAttribution({
      pairId: 'HOK-1',
      stage: 'review',
      forkIdentity: identity,
    });
    const forkReasons = attribution.reasonCodes.filter((code) => FORK_REASON_CODES.has(code));
    assert.deepEqual(forkReasons, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('divergent plan nulls planHash and surfaces plan_hash_mismatch', () => {
  const { root, input, challengerFeature } = seedFork();
  try {
    writeFileSync(join(challengerFeature, 'plan.md'), 'edited plan');
    const { identity, diagnostics } = computeForkIdentity(input);
    assert.equal(identity.planHash, null);
    assert.equal(diagnostics.planHash, 'divergent');
    const attribution = foldAttestationsIntoStageAttribution({ pairId: 'HOK-1', stage: 'review', forkIdentity: identity });
    assert.ok(attribution.reasonCodes.includes('plan_hash_mismatch'));
    assert.ok(attribution.reasonCodes.includes('divergent_pre_stage_inputs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('required inputs absent from both arms are missing, not matched', () => {
  const { root, input, primaryFeature, challengerFeature } = seedFork();
  try {
    rmSync(join(primaryFeature, 'plan.md'));
    rmSync(join(challengerFeature, 'plan.md'));
    const { identity, diagnostics } = computeForkIdentity(input);
    assert.equal(identity.planHash, null);
    assert.equal(diagnostics.planHash, 'missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('optional overlay must be present on both arms or neither', () => {
  const { root, input, primaryWt, challengerWt } = seedFork();
  try {
    write(join(primaryWt, '.wavemill-config.local.json'), '{"local":true}');
    const oneSided = computeForkIdentity(input);
    assert.equal(oneSided.identity.toolConfigHash, null);
    assert.equal(oneSided.diagnostics.toolConfigHash, 'missing');

    write(join(challengerWt, '.wavemill-config.local.json'), '{"local":true}');
    const bothSides = computeForkIdentity(input);
    assert.equal(bothSides.diagnostics.toolConfigHash, 'match');
    assert.notEqual(bothSides.identity.toolConfigHash, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unresolvable tree is recorded as null without failing', () => {
  const { root, input } = seedFork();
  try {
    const { identity, diagnostics } = computeForkIdentity({ ...input, resolveTree: () => null });
    assert.equal(identity.tree, null);
    assert.equal(diagnostics.tree, 'unresolved');
    assert.equal(identity.commit, 'abc123');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hashFileSet is sensitive to content and file name', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-identity-hash-'));
  try {
    write(join(root, 'a.md'), 'x');
    const first = hashFileSet(root, ['a.md']);
    writeFileSync(join(root, 'a.md'), 'y');
    assert.notEqual(hashFileSet(root, ['a.md']), first);
    write(join(root, 'b.md'), 'y');
    assert.notEqual(hashFileSet(root, ['b.md']), hashFileSet(root, ['a.md']));
    assert.equal(hashFileSet(root, ['absent.md']), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readForkIdentity round-trips a computed identity and rejects garbage', () => {
  const { root, input } = seedFork();
  try {
    const { identity } = computeForkIdentity(input);
    assert.deepEqual(readForkIdentity(JSON.parse(JSON.stringify(identity))), identity);
    assert.equal(readForkIdentity(undefined), undefined);
    assert.equal(readForkIdentity('abc'), undefined);
    assert.equal(readForkIdentity({ stage: 'review' }), undefined);
    assert.equal(readForkIdentity({ stage: 'bogus', commit: 'abc' }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachChallengeExecutionMetadata carries the intent fork identity onto the eval record', () => {
  const { root, input } = seedFork();
  try {
    const { identity } = computeForkIdentity(input);
    const record = {} as EvalRecord;
    attachChallengeExecutionMetadata(record, {
      side: 'challenger',
      intent: { pairId: 'HOK-1', forkStage: 'review', forkCommit: 'abc123', forkIdentity: identity },
    });
    assert.deepEqual(record.forkIdentity, identity);

    const withoutIdentity = {} as EvalRecord;
    attachChallengeExecutionMetadata(withoutIdentity, { side: 'primary', intent: { pairId: 'HOK-1' } });
    assert.equal(withoutIdentity.forkIdentity, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyForkIdentityFallback fills only the descriptor fields the intents left empty', () => {
  const identity = readForkIdentity({
    stage: 'review',
    commit: 'abc123',
    sharedPrefix: true,
    challengerInheritedStages: ['plan', 'implementation'],
  });
  const projected = { forkStage: null, forkCommit: null, sharedPrefix: false, primaryInheritedStages: [], challengerInheritedStages: [] };
  assert.deepEqual(applyForkIdentityFallback(projected, identity), {
    forkStage: 'review',
    forkCommit: 'abc123',
    sharedPrefix: true,
    primaryInheritedStages: [],
    challengerInheritedStages: ['plan', 'implementation'],
  });

  const explicit = { ...projected, forkCommit: 'cli-override' };
  assert.equal(applyForkIdentityFallback(explicit, identity).forkCommit, 'cli-override');
  assert.equal(applyForkIdentityFallback(projected, undefined), projected);
});
