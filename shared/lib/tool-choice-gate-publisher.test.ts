/**
 * Unit tests for `publishToolChoiceGate` (HOK-3123).
 *
 * The Linear client seams are injected via `deps`, so nothing touches the
 * real API. Every case exercises a single decision the publisher must make:
 * initiative lookup, document identity, ambiguity refusal, timestamp
 * rewriting, explicit-id override.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  publishToolChoiceGate,
  TOOL_CHOICE_GATE_DOCUMENT_TITLE,
  type PublishToolChoiceGateDeps,
} from './tool-choice-gate-publisher.ts';
import type { LinearInitiative } from './linear.ts';

function initiative(id: string, name: string): LinearInitiative {
  return {
    id,
    name,
    status: 'InProgress',
    slugId: id,
    projects: { nodes: [] },
  };
}

function stubDeps(overrides: Partial<PublishToolChoiceGateDeps> = {}): PublishToolChoiceGateDeps {
  return {
    getInitiatives: async () => [initiative('init-i27', 'I-27 Tool-Menu Decision Model')],
    getInitiative: async (id: string) => initiative(id, `initiative-${id}`),
    getInitiativeDocuments: async () => [],
    createInitiativeDocument: async (initiativeId, input) => ({
      id: 'doc-created',
      url: `https://linear.app/d/doc-created?init=${initiativeId}&title=${encodeURIComponent(input.title)}`,
    }),
    updateDocument: async (documentId) => ({
      id: documentId,
      url: `https://linear.app/d/${documentId}`,
    }),
    ...overrides,
  };
}

describe('publishToolChoiceGate', () => {
  it('creates the document on the first run', async () => {
    let createCalls = 0;
    let updateCalls = 0;
    const deps = stubDeps({
      createInitiativeDocument: async (initiativeId, input) => {
        createCalls += 1;
        assert.equal(initiativeId, 'init-i27');
        assert.equal(input.title, TOOL_CHOICE_GATE_DOCUMENT_TITLE);
        assert.ok(input.content.startsWith('Last updated: 2026-09-29T00:00:00.000Z'));
        return { id: 'doc-new', url: 'https://linear.app/d/doc-new' };
      },
      updateDocument: async () => {
        updateCalls += 1;
        throw new Error('should not be called');
      },
    });
    const result = await publishToolChoiceGate({
      markdown: '# Report\n\nBody',
      now: '2026-09-29T00:00:00.000Z',
      deps,
    });
    assert.equal(createCalls, 1);
    assert.equal(updateCalls, 0);
    assert.equal(result.action, 'created');
    assert.equal(result.documentId, 'doc-new');
    assert.equal(result.initiativeId, 'init-i27');
  });

  it('updates the existing document on a repeat run and does not create a duplicate', async () => {
    let updateCalls = 0;
    let createCalls = 0;
    const existing = {
      id: 'doc-existing',
      title: TOOL_CHOICE_GATE_DOCUMENT_TITLE,
      content: 'old',
    };
    const deps = stubDeps({
      getInitiativeDocuments: async () => [existing],
      updateDocument: async (documentId, input) => {
        updateCalls += 1;
        assert.equal(documentId, 'doc-existing');
        assert.ok(input.content?.startsWith('Last updated: 2026-09-29T00:00:00.000Z'));
        return { id: documentId, url: 'https://linear.app/d/doc-existing' };
      },
      createInitiativeDocument: async () => {
        createCalls += 1;
        throw new Error('should not be called');
      },
    });
    const result = await publishToolChoiceGate({
      markdown: '# Report\n\nBody',
      now: '2026-09-29T00:00:00.000Z',
      deps,
    });
    assert.equal(updateCalls, 1);
    assert.equal(createCalls, 0);
    assert.equal(result.action, 'updated');
    assert.equal(result.documentId, 'doc-existing');
  });

  it('rewrites an existing Last updated: line so there is a single canonical timestamp', async () => {
    let publishedContent = '';
    const deps = stubDeps({
      getInitiativeDocuments: async () => [
        { id: 'doc-1', title: TOOL_CHOICE_GATE_DOCUMENT_TITLE },
      ],
      updateDocument: async (documentId, input) => {
        publishedContent = input.content ?? '';
        return { id: documentId };
      },
    });
    await publishToolChoiceGate({
      markdown: '# Progress\n\nLast updated: 2000-01-01T00:00:00Z\n\nbody',
      now: '2026-09-29T00:00:00.000Z',
      deps,
    });
    assert.match(publishedContent, /Last updated: 2026-09-29T00:00:00\.000Z/);
    assert.ok(!publishedContent.includes('2000-01-01T00:00:00Z'));
  });

  it('refuses when multiple initiatives match the I-27 predicate', async () => {
    const deps = stubDeps({
      getInitiatives: async () => [
        initiative('init-1', 'I-27 first'),
        initiative('init-2', 'I-27 second'),
      ],
    });
    await assert.rejects(
      () =>
        publishToolChoiceGate({
          markdown: '# x',
          now: '2026-09-29T00:00:00.000Z',
          deps,
        }),
      /ambiguous initiative match/,
    );
  });

  it('refuses when no initiative matches the predicate', async () => {
    const deps = stubDeps({
      getInitiatives: async () => [initiative('init-x', 'I-30 something else')],
    });
    await assert.rejects(
      () =>
        publishToolChoiceGate({
          markdown: '# x',
          now: '2026-09-29T00:00:00.000Z',
          deps,
        }),
      /no initiative matched/,
    );
  });

  it('refuses when the initiative has two documents with the exact title', async () => {
    const deps = stubDeps({
      getInitiativeDocuments: async () => [
        { id: 'doc-a', title: TOOL_CHOICE_GATE_DOCUMENT_TITLE },
        { id: 'doc-b', title: TOOL_CHOICE_GATE_DOCUMENT_TITLE },
      ],
    });
    await assert.rejects(
      () =>
        publishToolChoiceGate({
          markdown: '# x',
          now: '2026-09-29T00:00:00.000Z',
          deps,
        }),
      /multiple documents/,
    );
  });

  it('uses initiativeId override without scanning by name', async () => {
    let getInitiativesCalls = 0;
    let getInitiativeCalls = 0;
    const deps = stubDeps({
      getInitiatives: async () => {
        getInitiativesCalls += 1;
        return [];
      },
      getInitiative: async (id) => {
        getInitiativeCalls += 1;
        return initiative(id, 'Forced');
      },
    });
    const result = await publishToolChoiceGate({
      markdown: '# x',
      now: '2026-09-29T00:00:00.000Z',
      initiativeId: 'init-forced',
      deps,
    });
    assert.equal(getInitiativesCalls, 0);
    assert.equal(getInitiativeCalls, 1);
    assert.equal(result.initiativeId, 'init-forced');
  });
});
