import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  GROUNDED_ORDERING_PROMPT_PATH,
  MAX_PAIRS_PER_LLM_CALL,
  TOUCH_SET_PREDICTION_PROMPT_PATH,
  buildOrderingPrompt,
  packGroundedWaves,
  parseOrderingVerdicts,
  runGroundedPlanning,
  sortByPriority,
  verdictsToEdges,
  type GroundedLlm,
  type GroundedTask,
  type GroundedVerdict,
  type GroundedWavePlan,
} from './grounded-planner.ts';
import type { PairScore } from './conflict-scorer.ts';
import type { RepoProbe } from './touch-set-predictor.ts';

const MONITOR = 'shared/lib/wavemill-monitor.sh';
const FILES = [
  MONITOR,
  'shared/lib/retry-policy.ts',
  'shared/lib/arbiter-scorer.ts',
  'shared/lib/arbiter-report.ts',
  'docs/observer.md',
  'tools/plan-queue.ts',
];

function probe(): RepoProbe {
  return {
    fileExists: (path) => FILES.includes(path),
    findByBasename: (name) => FILES.filter((path) => path.endsWith(`/${name}`)),
    findBySuffix: (suffix) => FILES.filter((path) => path.endsWith(`/${suffix}`)),
    grepFiles: () => [],
  };
}

function task(id: string, title: string, description: string, extra: Partial<GroundedTask> = {}): GroundedTask {
  return { id, title, description, priority: 3, fingerprint: `fp-${id}`, ...extra };
}

/** The 2026-09-30 backlog from HOK-3131. */
const WORKED_EXAMPLE: GroundedTask[] = [
  task('HOK-3103', 'Monitor: reap stale hooks', 'Change the reap loop in `shared/lib/wavemill-monitor.sh`.'),
  task('HOK-3109', 'Monitor: merge-lane BEHIND updates', 'Edit `shared/lib/wavemill-monitor.sh` merge-lane handling.', { priority: 2 }),
  task('HOK-3128', 'Coding dirty handoff relaunch', 'Relaunch once per head in `shared/lib/wavemill-monitor.sh`.', { priority: 1 }),
  task('HOK-3120', 'Retry policy primitive', 'Add `shared/lib/retry-policy.ts`.'),
  task('HOK-3122', 'Use retry policy in planner', 'This builds on HOK-3120: call it from `tools/plan-queue.ts`.'),
  task('HOK-3116', 'Arbiter R6 (3/5): scorer', 'Add `shared/lib/arbiter-scorer.ts`.'),
  task('HOK-3118', 'Arbiter R6 (5/5): report', 'Add `shared/lib/arbiter-report.ts`.'),
  task('HOK-3125', 'Observer docs', 'Document the observer in `docs/observer.md`.', { priority: 4 }),
];

const WORKED_VERDICTS = {
  verdicts: [
    { a: 'HOK-3116', b: 'HOK-3118', verdict: 'should_precede', evidence: 'Tasks are part of a series (3/5 and 5/5)' },
    { a: 'HOK-3120', b: 'HOK-3122', verdict: 'should_precede', evidence: 'HOK-3122 builds on HOK-3120' },
  ],
};

function mockLlm(responses: Partial<Record<'touch_set' | 'ordering', string | Error>>, calls: Array<{ purpose: string; prompt: string }> = []): GroundedLlm {
  return async (prompt, purpose) => {
    calls.push({ purpose, prompt });
    const response = responses[purpose];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected ${purpose} call`);
    return { text: response, model: 'mock-model' };
  };
}

const BASE_OPTS = {
  repoDir: '/nonexistent',
  probe: probe(),
  coChange: null,
  orderingTemplate: 'TASKS:\n{{TASKS}}\nPAIRS:\n{{PAIRS}}',
  touchSetTemplate: '{{DIRECTORY_TREE}}\n{{TASKS}}',
  directoryTree: async () => '.',
  keywordHits: async () => '',
  nowMs: Date.parse('2026-10-01T00:00:00Z'),
};

function waveOf(plan: GroundedWavePlan, taskId: string): number {
  const wave = plan.waves.find((candidate) => candidate.taskIds.includes(taskId));
  assert.ok(wave, `${taskId} not placed`);
  return wave.index;
}

function pair(taskA: string, taskB: string, extra: Partial<PairScore> = {}): PairScore {
  return { taskA, taskB, score: 1, signals: ['file_overlap'], overlappingFiles: ['x.ts'], conflictFiles: [], ...extra };
}

describe('runGroundedPlanning — 2026-09-30 worked example', () => {
  it('scores, judges, and packs the backlog into conflict-free ordered waves', async () => {
    const warnings: string[] = [];
    const calls: Array<{ purpose: string; prompt: string }> = [];
    const result = await runGroundedPlanning(WORKED_EXAMPLE, {
      ...BASE_OPTS,
      llm: mockLlm({ ordering: JSON.stringify(WORKED_VERDICTS) }, calls),
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(warnings, []);
    assert.deepEqual(calls.map((call) => call.purpose), ['ordering']);

    // Touch sets come from explicit paths.
    const touch = Object.fromEntries(result.touchSets.map((set) => [set.taskId, set.entries.map((entry) => entry.path)]));
    assert.deepEqual(touch['HOK-3128'], [MONITOR]);
    assert.deepEqual(touch['HOK-3122'], ['tools/plan-queue.ts']);

    // Only connected pairs reach the LLM; the docs task is never mentioned.
    const scored = result.scores.map((score) => `${score.taskA}/${score.taskB}`).sort();
    assert.deepEqual(scored, ['HOK-3103/HOK-3109', 'HOK-3103/HOK-3128', 'HOK-3109/HOK-3128', 'HOK-3116/HOK-3118', 'HOK-3120/HOK-3122']);
    // The three monitor pairs are deterministic conflicts (HOK-3304): only ordering pairs reach the judge.
    assert.equal(result.stats.pairsSentToLlm, 2);
    assert.doesNotMatch(calls[0].prompt, /HOK-3125/);
    assert.doesNotMatch(calls[0].prompt, /HOK-3128/);
    assert.match(calls[0].prompt, /orderingHint: HOK-3116 before HOK-3118 \(series 3\/5 before 5\/5\)/);
    assert.match(calls[0].prompt, /orderingHint: HOK-3120 before HOK-3122/);

    const verdict = (a: string, b: string) => result.verdicts.find((v) => (v.a === a && v.b === b) || (v.a === b && v.b === a));
    // Deterministic conflicts get no verdict the judge could veto.
    assert.equal(verdict('HOK-3128', 'HOK-3109'), undefined);
    assert.deepEqual(result.deterministicConflicts, [
      { a: 'HOK-3103', b: 'HOK-3109', files: [MONITOR] },
      { a: 'HOK-3103', b: 'HOK-3128', files: [MONITOR] },
      { a: 'HOK-3109', b: 'HOK-3128', files: [MONITOR] },
    ]);
    assert.equal(verdict('HOK-3116', 'HOK-3118')?.verdict, 'should_precede');
    assert.equal(verdict('HOK-3120', 'HOK-3122')?.evidence, 'HOK-3122 builds on HOK-3120');

    // REQ-F4: monitor tasks in different waves, ordering respected.
    const monitorWaves = ['HOK-3128', 'HOK-3109', 'HOK-3103'].map((id) => waveOf(result.waves, id));
    assert.equal(new Set(monitorWaves).size, 3);
    assert.deepEqual(monitorWaves, [0, 1, 2], 'priority decides which monitor task goes first');
    assert.ok(waveOf(result.waves, 'HOK-3116') < waveOf(result.waves, 'HOK-3118'));
    assert.ok(waveOf(result.waves, 'HOK-3120') < waveOf(result.waves, 'HOK-3122'));
    assert.equal(waveOf(result.waves, 'HOK-3125'), 0);

    const deferral = result.waves.deferrals.find((d) => d.taskId === 'HOK-3103');
    assert.deepEqual(deferral?.reasons.map((reason) => reason.taskId), ['HOK-3128', 'HOK-3109']);

    // Edges for the existing planner pipeline.
    const edges = result.edges.map((edge) => `${edge.type}:${edge.from}->${edge.to}`).sort();
    assert.deepEqual(edges, [
      'depends_on:HOK-3116->HOK-3118',
      'depends_on:HOK-3120->HOK-3122',
      'shared_surface:HOK-3103->HOK-3109',
      'shared_surface:HOK-3103->HOK-3128',
      'shared_surface:HOK-3109->HOK-3128',
    ]);
    assert.ok(result.edges.every((edge) => edge.source === 'inferred' && edge.reason?.startsWith('grounded:')));

    // REQ-F7: everything is cached by fingerprint (deterministic conflicts are recomputed, not cached).
    assert.deepEqual(Object.keys(result.cache.touchSets).sort(), WORKED_EXAMPLE.map((t) => t.id).sort());
    assert.equal(result.cache.touchSets['HOK-3128'].fingerprint, 'fp-HOK-3128');
    assert.equal(result.cache.groundedVerdicts.length, 2);
    assert.deepEqual(result.llm, { touchSetAttempted: false, orderingAttempted: true, orderingOk: true, model: 'mock-model', error: null });
  });

  it('reuses cached touch sets and verdicts without any LLM call', async () => {
    const first = await runGroundedPlanning(WORKED_EXAMPLE, { ...BASE_OPTS, llm: mockLlm({ ordering: JSON.stringify(WORKED_VERDICTS) }) });
    const failingProbe: RepoProbe = { ...probe(), fileExists: () => { throw new Error('probe must not be used'); } };
    const second = await runGroundedPlanning(WORKED_EXAMPLE, {
      ...BASE_OPTS,
      probe: failingProbe,
      cache: first.cache,
      llm: mockLlm({}),
    });
    assert.equal(second.stats.touchSetCacheHits, WORKED_EXAMPLE.length);
    assert.equal(second.stats.verdictCacheHits, 2);
    assert.equal(second.stats.pairsSentToLlm, 0);
    assert.equal(second.llm.orderingAttempted, false);
    assert.ok(second.verdicts.every((verdict) => verdict.source === 'cache'));
    assert.deepEqual(second.edges, first.edges);
    assert.deepEqual(second.deterministicConflicts, first.deterministicConflicts);
    assert.deepEqual(second.cache, first.cache);
  });

  it('re-judges only pairs whose task fingerprint changed', async () => {
    const first = await runGroundedPlanning(WORKED_EXAMPLE, { ...BASE_OPTS, llm: mockLlm({ ordering: JSON.stringify(WORKED_VERDICTS) }) });
    const changed = WORKED_EXAMPLE.map((t) => (t.id === 'HOK-3118' ? { ...t, fingerprint: 'fp-HOK-3118-v2' } : t));
    const calls: Array<{ purpose: string; prompt: string }> = [];
    const second = await runGroundedPlanning(changed, {
      ...BASE_OPTS,
      cache: first.cache,
      llm: mockLlm({ ordering: JSON.stringify({ verdicts: [WORKED_VERDICTS.verdicts[0]] }) }, calls),
    });
    assert.equal(second.stats.pairsSentToLlm, 1);
    assert.match(calls[0].prompt, /- a: HOK-3116\n  b: HOK-3118/);
    assert.equal(second.stats.verdictCacheHits, 1);
    assert.equal(second.stats.touchSetCacheHits, WORKED_EXAMPLE.length - 1);
  });
});

describe('runGroundedPlanning — failure handling', () => {
  // Judgeable pairs only: the monitor trio is all deterministic conflicts now (HOK-3304).
  const tasks = WORKED_EXAMPLE.slice(3, 6);

  it('malformed LLM output → warning, all pairs independent-order, nothing cached', async () => {
    const warnings: string[] = [];
    const result = await runGroundedPlanning(tasks, { ...BASE_OPTS, llm: mockLlm({ ordering: 'Sure! Here are verdicts.' }), warn: (m) => warnings.push(m) });
    assert.ok(result.verdicts.every((verdict) => verdict.verdict === 'independent-order' && verdict.source === 'default'));
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.cache.groundedVerdicts, []);
    assert.equal(result.llm.orderingOk, false);
    assert.match(result.llm.error ?? '', /not valid JSON/);
    assert.match(warnings.join('\n'), /ordering judge failed/);
    assert.equal(result.waves.waves.length, 1);
  });

  it('LLM transport failure → all pairs independent-order', async () => {
    const result = await runGroundedPlanning(tasks, { ...BASE_OPTS, llm: mockLlm({ ordering: new Error('all models failed') }), warn: () => {} });
    assert.equal(result.llm.orderingOk, false);
    assert.equal(result.llm.error, 'all models failed');
    assert.deepEqual(result.edges, []);
  });

  it('no LLM configured (cooldown) → deterministic scoring only, unjudged pairs independent-order', async () => {
    const result = await runGroundedPlanning(tasks, { ...BASE_OPTS });
    assert.equal(result.stats.pairsScored, 1);
    assert.equal(result.stats.pairsSentToLlm, 0);
    assert.equal(result.llm.orderingAttempted, false);
    assert.equal(result.llm.orderingOk, true);
    assert.ok(result.verdicts.every((verdict) => verdict.source === 'default'));
  });

  it('touch-set prediction failure → empty touch sets, planning continues', async () => {
    const brokenProbe: RepoProbe = { ...probe(), fileExists: () => { throw new Error('disk gone'); } };
    const warnings: string[] = [];
    const result = await runGroundedPlanning(tasks, { ...BASE_OPTS, probe: brokenProbe, warn: (m) => warnings.push(m) });
    assert.ok(result.touchSets.every((set) => set.entries.length === 0));
    assert.match(warnings[0], /disk gone/);
    // Text-only signals still score; the file-overlap pairs are gone with the touch sets.
    assert.deepEqual(result.scores.map((score) => score.signals), [['cross_reference']]);
  });

  it('empty backlog → empty result and no LLM call', async () => {
    const result = await runGroundedPlanning([], { ...BASE_OPTS, llm: mockLlm({}) });
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.waves.waves, []);
    assert.equal(result.llm.orderingAttempted, false);
  });

  it('single task → no pairs and no LLM call', async () => {
    const result = await runGroundedPlanning([WORKED_EXAMPLE[0]], { ...BASE_OPTS, llm: mockLlm({}) });
    assert.equal(result.stats.pairsScored, 0);
    assert.deepEqual(result.waves.waves, [{ index: 0, taskIds: ['HOK-3103'] }]);
  });

  it('predicts touch sets for vague tasks before scoring', async () => {
    const vague = [
      task('HOK-1', 'Improve scheduling', 'Improve the overall task scheduling logic.'),
      task('HOK-2', 'Queue fix', 'Fix `tools/plan-queue.ts`.'),
    ];
    const calls: Array<{ purpose: string; prompt: string }> = [];
    const result = await runGroundedPlanning(vague, {
      ...BASE_OPTS,
      llm: mockLlm({
        touch_set: JSON.stringify({ predictions: [{ id: 'HOK-1', files: ['tools/plan-queue.ts'] }] }),
      }, calls),
    });
    assert.deepEqual(calls.map((call) => call.purpose), ['touch_set'], 'the predicted overlap is decided without the judge');
    assert.deepEqual(result.touchSets[0].entries, [{ path: 'tools/plan-queue.ts', source: 'predicted' }]);
    assert.equal(result.llm.touchSetAttempted, true);
    assert.deepEqual(result.deterministicConflicts, [{ a: 'HOK-1', b: 'HOK-2', files: ['tools/plan-queue.ts'] }]);
    assert.deepEqual(result.verdicts, []);
  });

  it('caps the pairs sent to the LLM and defaults the rest to independent-order', async () => {
    // Every task cross-references every other: 55 scored pairs, no file overlap, all judgeable.
    const many = Array.from({ length: 11 }, (_, index) =>
      task(`HOK-${index + 1}`, `T${index}`, `Edit \`tools/f${index}.ts\`. Coordinates with ${
        Array.from({ length: 11 }, (_, other) => `HOK-${other + 1}`).filter((id) => id !== `HOK-${index + 1}`).join(', ')
      }.`));
    const warnings: string[] = [];
    const result = await runGroundedPlanning(many, { ...BASE_OPTS, llm: mockLlm({ ordering: '{"verdicts":[]}' }), warn: (m) => warnings.push(m) });
    assert.equal(result.stats.pairsScored, 55);
    assert.equal(result.stats.pairsSentToLlm, MAX_PAIRS_PER_LLM_CALL);
    assert.equal(result.cache.groundedVerdicts.length, MAX_PAIRS_PER_LLM_CALL);
    assert.match(warnings.join('\n'), /15 low-score pair\(s\) over the 40-pair cap/);
  });

  it('judges pairs in chunks when more calls are allowed, failing only the broken chunk', async () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      task(`HOK-${index + 1}`, `T${index}`, `Edit \`tools/f${index}.ts\`. Coordinates with ${
        Array.from({ length: 11 }, (_, other) => `HOK-${other + 1}`).filter((id) => id !== `HOK-${index + 1}`).join(', ')
      }.`));
    let call = 0;
    const llm: GroundedLlm = async () => {
      call++;
      if (call === 2) throw new Error('chunk 2 timed out');
      return { text: '{"verdicts":[]}', model: 'mock-model' };
    };
    const result = await runGroundedPlanning(many, { ...BASE_OPTS, llm, maxLlmCalls: 3, warn: () => {} });
    assert.equal(call, 2, '55 pairs need two 40-pair chunks');
    assert.equal(result.stats.pairsSentToLlm, 55);
    assert.equal(result.cache.groundedVerdicts.length, 40, 'only the successful chunk is cached');
    assert.equal(result.llm.orderingOk, false);
    assert.equal(result.llm.error, 'chunk 2 timed out');
  });

  it('pairs already linked in Linear are not sent to the judge', async () => {
    const linked = [
      task('HOK-1', 'A', 'Edit `tools/plan-queue.ts`', { blocks: ['HOK-2'] }),
      task('HOK-2', 'B', 'Edit `tools/plan-queue.ts`', { dependsOn: ['HOK-1'] }),
    ];
    const result = await runGroundedPlanning(linked, {
      ...BASE_OPTS,
      llm: mockLlm({}),
      explicitEdges: [{ type: 'depends_on', from: 'HOK-1', to: 'HOK-2', source: 'explicit' }],
    });
    assert.equal(result.stats.pairsScored, 1);
    assert.equal(result.stats.pairsSentToLlm, 0);
    assert.deepEqual(result.waves.waves, [{ index: 0, taskIds: ['HOK-1'] }, { index: 1, taskIds: ['HOK-2'] }]);
  });
});

describe('runGroundedPlanning — deterministic conflicts bypass the judge (HOK-3304)', () => {
  it('emits the shared_surface edge even when the judge would answer independent-order', async () => {
    // protects: the LLM judge cannot clear a direct file overlap
    const calls: Array<{ purpose: string; prompt: string }> = [];
    const result = await runGroundedPlanning(
      [
        task('HOK-A', 'A', 'Edit `shared/lib/arbiter-scorer.ts`.'),
        task('HOK-B', 'B', 'Also edit `shared/lib/arbiter-scorer.ts` for a separate reason.'),
      ],
      {
        ...BASE_OPTS,
        // Any judge call would throw (no canned response): the pair must never reach the LLM.
        llm: mockLlm({}, calls),
      },
    );
    assert.deepEqual(calls, [], 'the deterministic pair is never judged');
    assert.equal(result.stats.pairsSentToLlm, 0);
    assert.equal(result.llm.orderingAttempted, false);
    assert.ok(result.edges.some((edge) => edge.type === 'shared_surface' && edge.from === 'HOK-A' && edge.to === 'HOK-B'));
    assert.deepEqual(result.deterministicConflicts, [{ a: 'HOK-A', b: 'HOK-B', files: ['shared/lib/arbiter-scorer.ts'] }]);
    assert.deepEqual(result.verdicts, []);
    assert.equal(waveOf(result.waves, 'HOK-A'), 0);
    assert.equal(waveOf(result.waves, 'HOK-B'), 1, 'deterministic conflicts split waves without any verdict');
  });

  it('a must_precede verdict on a non-overlapping pair becomes a depends_on edge', async () => {
    // protects: narrowing the judge to ordering preserves depends_on edges for builds-on signals
    const result = await runGroundedPlanning(
      [
        task('HOK-1', 'Retry policy primitive', 'Add `shared/lib/retry-policy.ts`.'),
        task('HOK-2', 'Use retry policy in planner', 'This builds on HOK-1: call it from `tools/plan-queue.ts`.'),
      ],
      {
        ...BASE_OPTS,
        llm: mockLlm({ ordering: JSON.stringify({ verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'must_precede', evidence: 'HOK-2 consumes the retry policy HOK-1 adds' }] }) }),
      },
    );
    assert.equal(result.stats.pairsSentToLlm, 1);
    assert.deepEqual(result.deterministicConflicts, []);
    assert.ok(result.edges.some((edge) => edge.type === 'depends_on' && edge.from === 'HOK-1' && edge.to === 'HOK-2'));
    assert.ok(!result.edges.some((edge) => edge.type === 'shared_surface'), 'ordering-only pairs never produce shared_surface edges');
  });
});

describe('parseOrderingVerdicts', () => {
  const asked = [pair('HOK-1', 'HOK-2'), pair('HOK-3', 'HOK-4'), pair('HOK-5', 'HOK-6')];

  it('accepts reversed pairs and fenced JSON, and fills omitted pairs with independent-order', () => {
    const raw = '```json\n{"verdicts":[{"a":"HOK-2","b":"HOK-1","verdict":"must_precede","evidence":"HOK-1 uses the schema HOK-2 adds"}]}\n```';
    const verdicts = parseOrderingVerdicts(raw, asked, () => {});
    assert.deepEqual(verdicts, [
      { a: 'HOK-2', b: 'HOK-1', verdict: 'must_precede', evidence: 'HOK-1 uses the schema HOK-2 adds', source: 'llm' },
      { a: 'HOK-3', b: 'HOK-4', verdict: 'independent-order', source: 'llm' },
      { a: 'HOK-5', b: 'HOK-6', verdict: 'independent-order', source: 'llm' },
    ]);
  });

  it('downgrades missing/vague evidence and unknown verdicts to independent-order with warnings', () => {
    const warnings: string[] = [];
    const raw = JSON.stringify({
      verdicts: [
        { a: 'HOK-1', b: 'HOK-2', verdict: 'conflict' },
        { a: 'HOK-3', b: 'HOK-4', verdict: 'should_precede', evidence: 'related' },
        { a: 'HOK-5', b: 'HOK-6', verdict: 'blocks', evidence: 'HOK-5 blocks HOK-6 for sure' },
      ],
    });
    const verdicts = parseOrderingVerdicts(raw, asked, (message) => warnings.push(message));
    assert.ok(verdicts.every((verdict) => verdict.verdict === 'independent-order'));
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /unknown verdict "conflict"/);
    assert.match(warnings[2], /unknown verdict "blocks"/);
  });

  it('defangs stale `conflict` verdicts from old caches or prompts', () => {
    // protects: a stale cache or an LLM ignoring the new prompt cannot resurrect the retired conflict kind
    const warnings: string[] = [];
    const raw = JSON.stringify({
      verdicts: [{ a: 'HOK-1', b: 'HOK-2', verdict: 'conflict', evidence: 'Both modify shared/lib/x.ts' }],
    });
    const verdicts = parseOrderingVerdicts(raw, [pair('HOK-1', 'HOK-2')], (message) => warnings.push(message));
    assert.deepEqual(verdicts, [{ a: 'HOK-1', b: 'HOK-2', verdict: 'independent-order', source: 'llm' }]);
    assert.match(warnings[0], /unknown verdict "conflict"/);
  });

  it('ignores unasked pairs and duplicates (first wins), and drops evidence on independent-order', () => {
    const warnings: string[] = [];
    const raw = JSON.stringify({
      verdicts: [
        { a: 'HOK-1', b: 'HOK-9', verdict: 'must_precede', evidence: 'Both modify shared/lib/x.ts' },
        { a: 'HOK-1', b: 'HOK-2', verdict: 'must_precede', evidence: 'Both modify shared/lib/x.ts' },
        { a: 'HOK-2', b: 'HOK-1', verdict: 'independent-order' },
        { a: 'HOK-3', b: 'HOK-4', verdict: 'independent-order', evidence: 'nothing shared at all' },
        'garbage',
      ],
    });
    const verdicts = parseOrderingVerdicts(raw, asked, (message) => warnings.push(message));
    assert.equal(verdicts[0].verdict, 'must_precede');
    assert.equal(verdicts[1].evidence, undefined);
    assert.match(warnings[0], /unasked pair HOK-1\/HOK-9/);
  });

  it('throws on non-JSON or wrong shape', () => {
    assert.throws(() => parseOrderingVerdicts('nope', asked), /not valid JSON/);
    assert.throws(() => parseOrderingVerdicts('{"edges":[]}', asked), /verdicts array/);
  });
});

describe('packGroundedWaves', () => {
  const v = (a: string, b: string, verdict: GroundedVerdict['verdict'], evidence = 'evidence text'): GroundedVerdict =>
    ({ a, b, verdict, evidence, source: 'llm' });

  it('places deterministically conflicting tasks in different waves (greedy colouring)', () => {
    const plan = packGroundedWaves(['A', 'B', 'C', 'D'], [], {
      conflictEdges: [
        { a: 'A', b: 'B', files: ['x.ts'] },
        { a: 'B', b: 'C', files: ['x.ts'] },
        { a: 'A', b: 'C', files: ['x.ts'] },
      ],
    });
    assert.deepEqual(plan.waves, [
      { index: 0, taskIds: ['A', 'D'] },
      { index: 1, taskIds: ['B'] },
      { index: 2, taskIds: ['C'] },
    ]);
    assert.deepEqual(plan.deferrals.find((d) => d.taskId === 'C')?.reasons.map((r) => [r.kind, r.taskId]), [['conflict', 'A'], ['conflict', 'B']]);
  });

  it('reuses an earlier wave when only non-adjacent tasks conflict', () => {
    const plan = packGroundedWaves(['A', 'B', 'C'], [], {
      conflictEdges: [{ a: 'A', b: 'B', files: ['x.ts'] }, { a: 'B', b: 'C', files: ['x.ts'] }],
    });
    assert.deepEqual(plan.waves, [{ index: 0, taskIds: ['A', 'C'] }, { index: 1, taskIds: ['B'] }]);
  });

  it('respects ordering regardless of priority order', () => {
    const plan = packGroundedWaves(['B', 'A'], [v('A', 'B', 'must_precede')]);
    assert.deepEqual(plan.waves, [{ index: 0, taskIds: ['A'] }, { index: 1, taskIds: ['B'] }]);
    assert.deepEqual(plan.deferrals, [{ taskId: 'B', wave: 1, reasons: [{ kind: 'after', taskId: 'A', verdict: 'must_precede', evidence: 'evidence text' }] }]);
  });

  it('drops the soft edge of a cycle first, then hard cycle edges', () => {
    const plan = packGroundedWaves(['A', 'B', 'C'], [v('A', 'B', 'must_precede'), v('B', 'C', 'must_precede'), v('C', 'A', 'should_precede')]);
    assert.deepEqual(plan.dropped.map((d) => [d.verdict.a, d.verdict.b, d.reason]), [['C', 'A', 'cycle']]);
    assert.deepEqual(plan.waves.map((wave) => wave.taskIds), [['A'], ['B'], ['C']]);
    assert.equal(plan.keptOrdering.length, 2);
  });

  it('honors explicit edges first and drops verdicts that contradict them', () => {
    const plan = packGroundedWaves(['A', 'B'], [v('B', 'A', 'must_precede')], {
      fixedEdges: [{ type: 'depends_on', from: 'A', to: 'B', source: 'explicit' }],
    });
    assert.equal(plan.dropped[0].reason, 'cycle');
    assert.deepEqual(plan.deferrals[0].reasons[0], { kind: 'after', taskId: 'A', verdict: 'explicit' });
  });

  it('drops verdicts for unknown tasks and ignores independent-order verdicts', () => {
    const plan = packGroundedWaves(['A', 'B'], [v('A', 'Z', 'must_precede'), v('A', 'B', 'independent-order')]);
    assert.equal(plan.dropped[0].reason, 'unknown_task');
    assert.deepEqual(plan.waves, [{ index: 0, taskIds: ['A', 'B'] }]);
  });

  it('caps wave size when requested', () => {
    const plan = packGroundedWaves(['A', 'B', 'C'], [], { maxWaveSize: 2 });
    assert.deepEqual(plan.waves.map((wave) => wave.taskIds), [['A', 'B'], ['C']]);
  });

  it('is deterministic', () => {
    const verdicts = [v('C', 'D', 'should_precede')];
    const conflictEdges = [{ a: 'A', b: 'B', files: ['x.ts'] }, { a: 'B', b: 'D', files: ['x.ts'] }];
    assert.deepEqual(
      packGroundedWaves(['A', 'B', 'C', 'D'], verdicts, { conflictEdges }),
      packGroundedWaves(['A', 'B', 'C', 'D'], [...verdicts].reverse(), { conflictEdges: [...conflictEdges].reverse() }),
    );
  });
});

describe('helpers', () => {
  it('verdictsToEdges maps ordering verdicts to depends_on and skips independent-order', () => {
    // protects: retired conflict verdicts must not become edges here; shared_surface comes from the scorer
    assert.deepEqual(
      verdictsToEdges([
        { a: 'HOK-3', b: 'HOK-4', verdict: 'should_precede', evidence: 'series', source: 'llm' },
        { a: 'HOK-5', b: 'HOK-6', verdict: 'independent-order', source: 'llm' },
        { a: 'HOK-7', b: 'HOK-8', verdict: 'must_precede', evidence: 'HOK-8 consumes the schema HOK-7 adds', source: 'llm' },
      ]),
      [
        { type: 'depends_on', from: 'HOK-3', to: 'HOK-4', source: 'inferred', reason: 'grounded:should_precede: series' },
        { type: 'depends_on', from: 'HOK-7', to: 'HOK-8', source: 'inferred', reason: 'grounded:must_precede: HOK-8 consumes the schema HOK-7 adds' },
      ],
    );
  });

  it('sortByPriority puts urgent first and no-priority last', () => {
    const sorted = sortByPriority([
      { id: 'HOK-1', priority: 0 },
      { id: 'HOK-2', priority: 4 },
      { id: 'HOK-3', priority: 1 },
      { id: 'HOK-4', priority: null },
      { id: 'HOK-5', priority: 1 },
    ]);
    assert.deepEqual(sorted.map((t) => t.id), ['HOK-3', 'HOK-5', 'HOK-2', 'HOK-1', 'HOK-4']);
  });

  it('buildOrderingPrompt lists only involved tasks with touch sets and pair signals', () => {
    const prompt = buildOrderingPrompt(
      readFileSync(GROUNDED_ORDERING_PROMPT_PATH, 'utf8'),
      [pair('HOK-1', 'HOK-2', { signals: ['file_overlap', 'hot_file'], overlappingFiles: [MONITOR], hint: { before: 'HOK-1', after: 'HOK-2', reason: 'series 1/2 before 2/2' } })],
      [task('HOK-1', 'One', 'd1'), task('HOK-2', 'Two', 'd2'), task('HOK-3', 'Three', 'd3')],
      [{ taskId: 'HOK-1', entries: [{ path: MONITOR, source: 'resolved', symbols: ['poll_loop'] }] }, { taskId: 'HOK-2', entries: [] }],
    );
    assert.doesNotMatch(prompt, /\{\{(TASKS|PAIRS)\}\}/);
    assert.doesNotMatch(prompt, /- id: HOK-3/);
    assert.match(prompt, /- shared\/lib\/wavemill-monitor\.sh \(resolved; symbols: poll_loop\)/);
    assert.match(prompt, /touchSet: \[\]/);
    assert.match(prompt, /signals: \["file_overlap","hot_file"\]/);
    assert.match(prompt, /You MUST give an `evidence` string/);
  });

  it('both prompt templates exist with their placeholders', () => {
    const ordering = readFileSync(GROUNDED_ORDERING_PROMPT_PATH, 'utf8');
    assert.match(ordering, /\{\{TASKS\}\}[\s\S]*\{\{PAIRS\}\}/);
    assert.match(ordering, /independent-order/);
    assert.doesNotMatch(ordering, /- `conflict`:/, 'the judge no longer offers a conflict verdict');
    assert.match(readFileSync(TOUCH_SET_PREDICTION_PROMPT_PATH, 'utf8'), /\{\{DIRECTORY_TREE\}\}[\s\S]*\{\{TASKS\}\}/);
  });
});
