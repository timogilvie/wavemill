import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  assembleNearbyContext,
  buildPartialRefreshPrompt,
  parseQueueAnalysisEdges,
  QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS,
  QUEUE_ANALYSIS_PROMPT_MAX_BYTES,
} from './queue-partial-refresh.ts';

describe('queue-partial-refresh', () => {
  describe('buildPartialRefreshPrompt description budget', () => {
    it('truncates long task descriptions and leaves short ones intact', () => {
      const longDescription = `Top of packet. ${'x'.repeat(QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS * 2)} TAIL-MARKER`;
      const prompt = buildPartialRefreshPrompt({
        changedTaskIds: ['HOK-1'],
        contextTasks: [
          { id: 'HOK-1', title: 'Long', description: longDescription },
          { id: 'HOK-2', title: 'Short', description: 'short description' },
        ],
        template: '{{CONTEXT_TASKS}}',
      });

      assert.match(prompt, /Top of packet\./);
      assert.match(prompt, /…\[truncated]/);
      assert.doesNotMatch(prompt, /TAIL-MARKER/);
      assert.match(prompt, /description: "short description"/);
      // HOK-3179: 400-char cap keeps every per-task slice tight.
      assert.ok(prompt.length < QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS + 600);
      assert.equal(QUEUE_ANALYSIS_DESCRIPTION_MAX_CHARS, 400);
    });

    it('keeps the full prompt under the hard size bound for many fat tasks (HOK-3179)', () => {
      // 20 tasks, each with a 10 KB description, would be ~200 KB raw — the
      // bound forces aggressive per-task trimming instead of a blown budget.
      const tasks = Array.from({ length: 20 }, (_, i) => ({
        id: `HOK-${100 + i}`,
        title: `Task ${i}`,
        description: 'x'.repeat(10_000),
        labels: ['backend'],
        priority: i,
      }));
      const prompt = buildPartialRefreshPrompt({
        changedTaskIds: tasks.slice(0, 5).map((t) => t.id),
        contextTasks: tasks,
        template: 'changed={{CHANGED_TASK_IDS}}\ncontext:\n{{CONTEXT_TASKS}}',
      });

      assert.ok(
        Buffer.byteLength(prompt, 'utf8') <= QUEUE_ANALYSIS_PROMPT_MAX_BYTES,
        `prompt is ${Buffer.byteLength(prompt, 'utf8')} bytes, bound is ${QUEUE_ANALYSIS_PROMPT_MAX_BYTES}`,
      );
    });

    it('does not include dropped fields in the rendered prompt (HOK-3179)', () => {
      const prompt = buildPartialRefreshPrompt({
        changedTaskIds: ['HOK-1'],
        contextTasks: [{
          id: 'HOK-1',
          title: 'Refresh cache',
          description: 'Update partial queue refresh',
          labels: ['backend'],
          priority: 2,
          state: 'Todo',
          dueDate: '2026-10-20',
          projectMilestone: { name: 'M1', targetDate: '2026-10-30' },
          dependsOn: ['HOK-0'],
          blocks: ['HOK-2'],
        }],
        template: '{{CONTEXT_TASKS}}',
      });

      assert.doesNotMatch(prompt, /\bstate:/);
      assert.doesNotMatch(prompt, /\bdueDate:/);
      assert.doesNotMatch(prompt, /\bprojectMilestone:/);
      // Fields we keep must still render.
      assert.match(prompt, /priority: 2/);
      assert.match(prompt, /dependsOn: \["HOK-0"\]/);
    });
  });

  describe('assembleNearbyContext', () => {
    it('includes changed tasks, shared labels, blockers, top priority tasks, and in-flight tasks', () => {
      const ids = assembleNearbyContext({
        changedTaskIds: ['HOK-2'],
        topN: 2,
        allBacklog: [
          { id: 'HOK-1', priority: 1, labels: ['api'], state: 'Todo' },
          { id: 'HOK-2', priority: 4, labels: ['ui'], blocks: ['HOK-4'], dependsOn: ['HOK-5'], state: 'Todo' },
          { id: 'HOK-3', priority: 2, labels: ['ui'], state: 'Todo' },
          { id: 'HOK-4', priority: 5, labels: ['ops'], state: 'Todo' },
          { id: 'HOK-5', priority: 6, labels: ['ops'], state: 'In Progress' },
          { id: 'HOK-6', priority: 7, labels: ['docs'], blocks: ['HOK-2'], state: 'Review' },
        ],
      });

      assert.deepEqual(ids, ['HOK-1', 'HOK-2', 'HOK-3', 'HOK-4', 'HOK-5', 'HOK-6']);
    });

    it('dedupes and sorts IDs deterministically', () => {
      const ids = assembleNearbyContext({
        changedTaskIds: ['HOK-10'],
        topN: 0,
        allBacklog: [
          { id: 'HOK-2', labels: ['shared'], blocks: ['HOK-10'], state: 'Todo' },
          { id: 'HOK-10', labels: ['shared'], state: 'Started' },
        ],
      });

      assert.deepEqual(ids, ['HOK-2', 'HOK-10']);
    });
  });

  it('builds a prompt with changed IDs and formatted context tasks', () => {
    const prompt = buildPartialRefreshPrompt({
      changedTaskIds: ['HOK-2'],
      template: 'changed={{CHANGED_TASK_IDS}}\ncontext:\n{{CONTEXT_TASKS}}',
      contextTasks: [
        {
          id: 'HOK-2',
          title: 'Refresh cache',
          description: 'Update partial queue refresh',
          labels: ['backend'],
          priority: 2,
          dependsOn: ['HOK-1'],
          blocks: ['HOK-3'],
          state: 'Todo',
        },
      ],
    });

    assert.match(prompt, /changed=\["HOK-2"\]/);
    assert.match(prompt, /id: HOK-2/);
    assert.match(prompt, /dependsOn: \["HOK-1"\]/);
    assert.match(prompt, /blocks: \["HOK-3"\]/);
  });

  describe('parseQueueAnalysisEdges', () => {
    it('accepts valid output and maps reasons into cache labels', () => {
      const edges = parseQueueAnalysisEdges(
        JSON.stringify({
          edges: [
            { from: 'HOK-1', to: 'HOK-2', type: 'depends_on', reason: 'builds on schema work' },
            { from: 'HOK-2', to: 'HOK-3', type: 'shared_surface', reason: 'same queue cache' },
          ],
        }),
        new Set(['HOK-2']),
        new Map([
          ['HOK-1', 'fp-1'],
          ['HOK-2', 'fp-2'],
          ['HOK-3', 'fp-3'],
        ]),
      );

      assert.equal(edges.length, 2);
      assert.deepEqual(
        edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, label: edge.label })),
        [
          { from: 'HOK-1', to: 'HOK-2', type: 'depends_on', label: 'builds on schema work' },
          { from: 'HOK-2', to: 'HOK-3', type: 'shared_surface', label: 'same queue cache' },
        ],
      );
      assert.ok(edges.every((edge) => edge.kind === 'inferred'));
    });

    it('warns and drops out-of-scope or fingerprintless edges', () => {
      const warn = mock.method(console, 'warn', () => undefined);

      const edges = parseQueueAnalysisEdges(
        JSON.stringify({
          edges: [
            { from: 'HOK-1', to: 'HOK-3', type: 'depends_on', reason: 'invalid scope' },
            { from: 'HOK-2', to: 'HOK-4', type: 'depends_on', reason: 'missing fingerprint' },
          ],
        }),
        new Set(['HOK-2']),
        new Map([
          ['HOK-1', 'fp-1'],
          ['HOK-2', 'fp-2'],
          ['HOK-3', 'fp-3'],
        ]),
      );

      assert.deepEqual(edges, []);
      assert.equal(warn.mock.callCount(), 2);
    });

    it('rejects malformed output envelopes', () => {
      assert.throws(() => parseQueueAnalysisEdges('{"edges":[],"waves":[]}', new Set(['HOK-1']), new Map()), /exactly: edges/);
    });

    it('unwraps exactly one outer json fence, including the trailing-only shape llm-cli leaves', () => {
      const fingerprints = new Map([['HOK-1', 'fp-1'], ['HOK-2', 'fp-2']]);
      const body = '{"edges":[{"from":"HOK-1","to":"HOK-2","type":"depends_on"}]}';
      for (const raw of ['```json\n' + body + '\n```', '```\n' + body + '\n```', body + '\n```']) {
        const edges = parseQueueAnalysisEdges(raw, new Set(['HOK-2']), fingerprints);
        assert.deepEqual(edges.map((edge) => `${edge.from}->${edge.to}`), ['HOK-1->HOK-2']);
      }
    });

    it('still rejects multiple fences or prose around a fence', () => {
      assert.throws(
        () => parseQueueAnalysisEdges('```json\n{"edges":[]}\n```\n```json\n{"edges":[]}\n```', new Set(['HOK-1']), new Map()),
        /markdown fence/,
      );
      assert.throws(
        () => parseQueueAnalysisEdges('Here you go:\n```json\n{"edges":[]}\n```', new Set(['HOK-1']), new Map()),
        /markdown fence/,
      );
      assert.throws(
        () => parseQueueAnalysisEdges('```json\n{"edges":[]}\n```\nHope this helps', new Set(['HOK-1']), new Map()),
        /markdown fence/,
      );
    });
  });
});
