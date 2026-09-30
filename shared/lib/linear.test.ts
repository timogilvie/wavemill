import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createComment,
  createInitiativeDocument,
  getInitiativeDocuments,
  listOpenIssuesByIdentifierPrefix,
  setIssueState,
  setIssuesState,
  updateComment,
  updateDocument,
  updateIssue,
} from './linear.ts';

type GraphQLPayload = {
  query: string;
  variables?: Record<string, unknown>;
};

function installFetchMock(handler: (payload: GraphQLPayload) => unknown | Promise<unknown>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = (init?.body || '{}').toString();
    const payload = JSON.parse(body) as GraphQLPayload;
    const data = await handler(payload);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('setIssueState caches team workflow states across calls', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const teamId = 'team-cache-1';
  let teamQueryCount = 0;
  let updateCount = 0;

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(filter: { number: { eq:')) {
      const number = payload.query.includes('eq: 101') ? 'HOK-101' : 'HOK-102';
      return { issues: { nodes: [{ id: `issue-${number}`, identifier: number, team: { id: teamId } }] } };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      teamQueryCount += 1;
      return { team: { states: { nodes: [{ id: 'state-in-progress', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      updateCount += 1;
      return { issueUpdate: { success: true, issue: { id: 'x', identifier: 'HOK-1', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    await setIssueState('HOK-101', 'In Progress');
    await setIssueState('HOK-102', 'In Progress');
    assert.equal(teamQueryCount, 1);
    assert.equal(updateCount, 2);
  } finally {
    restore();
  }
});

test('setIssuesState with empty identifiers returns without API calls', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let called = false;
  const restore = installFetchMock(() => {
    called = true;
    return {};
  });

  try {
    const result = await setIssuesState([], 'In Progress');
    assert.deepEqual(result, { updated: [], failed: [] });
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('setIssuesState batches issue lookup, team state lookup, and updates', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const teamFetches = new Set<string>();
  const lookupTeamKeys: string[] = [];
  let issueLookupCount = 0;
  let mutationCount = 0;

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(') && payload.query.includes('number: { in: [')) {
      issueLookupCount += 1;
      const teamKey = String(payload.variables?.teamKey || '');
      lookupTeamKeys.push(teamKey);
      if (teamKey === 'HOK') {
        return {
          issues: {
            nodes: [
              { id: 'i1', identifier: 'HOK-201', team: { id: 't1' } },
              { id: 'i2', identifier: 'HOK-202', team: { id: 't1' } },
            ],
          },
        };
      }
      if (teamKey === 'ABC') {
        return {
          issues: {
            nodes: [
              { id: 'i3', identifier: 'ABC-301', team: { id: 't2' } },
              { id: 'i4', identifier: 'ABC-302', team: { id: 't2' } },
            ],
          },
        };
      }
      throw new Error(`Unexpected team key: ${teamKey}`);
    }
    if (payload.query.includes('query($teamId: String!)')) {
      const teamId = String(payload.variables?.teamId || '');
      teamFetches.add(teamId);
      return { team: { states: { nodes: [{ id: `state-${teamId}`, name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      mutationCount += 1;
      return { issueUpdate: { success: true, issue: { id: 'x', identifier: 'x', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-201', 'HOK-202', 'ABC-301', 'ABC-302'], 'In Progress');
    assert.equal(issueLookupCount, 2);
    assert.deepEqual(lookupTeamKeys.sort(), ['ABC', 'HOK']);
    assert.equal(teamFetches.size, 2);
    assert.equal(mutationCount, 4);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.updated.sort(), ['ABC-301', 'ABC-302', 'HOK-201', 'HOK-202']);
  } finally {
    restore();
  }
});

test('setIssuesState returns failed entries on mutation errors without throwing', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(') && payload.query.includes('number: { in: [')) {
      return {
        issues: {
          nodes: [
            { id: 'ok-id', identifier: 'HOK-401', team: { id: 't3' } },
            { id: 'bad-id', identifier: 'HOK-402', team: { id: 't3' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t3', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      if (payload.variables?.issueId === 'bad-id') {
        return { issueUpdate: { success: false, issue: { id: 'bad-id', identifier: 'HOK-402', url: 'u' } } };
      }
      return { issueUpdate: { success: true, issue: { id: 'ok-id', identifier: 'HOK-401', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-401', 'HOK-402'], 'In Progress');
    assert.deepEqual(result.updated, ['HOK-401']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-402');
    assert.equal(result.failed[0].error, 'Failed to update issue state');
  } finally {
    restore();
  }
});

test('setIssuesState reports a generic error when Linear returns success false', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(') && payload.query.includes('number: { in: [')) {
      return {
        issues: {
          nodes: [
            { id: 'bad-id', identifier: 'HOK-502', team: { id: 't5' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t5', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return {
        issueUpdate: {
          success: false,
          issue: null,
        },
      };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-502'], 'In Progress');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-502');
    assert.equal(result.failed[0].error, 'Failed to update issue state');
  } finally {
    restore();
  }
});

test('setIssuesState reports malformed mutation responses per issue', async () => {
  process.env.LINEAR_API_KEY = 'test';

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(') && payload.query.includes('number: { in: [')) {
      return {
        issues: {
          nodes: [
            { id: 'bad-id', identifier: 'HOK-503', team: { id: 't5' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t5', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      return {};
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['HOK-503'], 'In Progress');
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'HOK-503');
    assert.equal(result.failed[0].error, 'Linear API response missing issueUpdate result');
    assert.equal(result.failed[0].category, 'graphql');
  } finally {
    restore();
  }
});

test('setIssuesState reports invalid identifiers without issuing a lookup for them', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const lookupTeamKeys: string[] = [];
  let mutationCount = 0;

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('issues(') && payload.query.includes('number: { in: [')) {
      const teamKey = String(payload.variables?.teamKey || '');
      lookupTeamKeys.push(teamKey);
      return {
        issues: {
          nodes: [
            { id: 'ok-id', identifier: 'HOK-801', team: { id: 't8' } },
          ],
        },
      };
    }
    if (payload.query.includes('query($teamId: String!)')) {
      return { team: { states: { nodes: [{ id: 'state-t8', name: 'In Progress' }] } } };
    }
    if (payload.query.includes('mutation($issueId: String!, $input: IssueUpdateInput!)')) {
      mutationCount += 1;
      return { issueUpdate: { success: true, issue: { id: 'ok-id', identifier: 'HOK-801', url: 'u' } } };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const result = await setIssuesState(['bad-id', 'HOK-801'], 'In Progress');
    assert.deepEqual(lookupTeamKeys, ['HOK']);
    assert.equal(mutationCount, 1);
    assert.deepEqual(result.updated, ['HOK-801']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].issueId, 'bad-id');
    assert.equal(result.failed[0].category, 'client');
    assert.equal(result.failed[0].isRetryable, false);
    assert.match(result.failed[0].error, /Invalid issue identifier: bad-id/);
  } finally {
    restore();
  }
});

test('updateIssue mutation does not request userErrors', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let capturedQuery = '';

  const restore = installFetchMock((payload) => {
    capturedQuery = payload.query;
    return {
      issueUpdate: {
        success: true,
        issue: { id: 'issue-1', identifier: 'HOK-601', url: 'u' },
      },
    };
  });

  try {
    const result = await updateIssue('issue-1', { stateId: 'state-1' });
    assert.equal(result.success, true);
    assert.match(capturedQuery, /success/);
    assert.doesNotMatch(capturedQuery, /userErrors/);
  } finally {
    restore();
  }
});

test('listOpenIssuesByIdentifierPrefix returns only open primary/challenger issues', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let receivedIdentifiers: unknown[] = [];

  const restore = installFetchMock((payload) => {
    if (payload.query.includes('searchIssues(')) {
      receivedIdentifiers = [payload.variables?.term, `${payload.variables?.term}_c`];
      return {
        searchIssues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'HOK-701',
              title: 'Primary',
              state: { name: 'In Progress' },
              completedAt: null,
              canceledAt: null,
            },
            {
              id: 'issue-2',
              identifier: 'HOK-701_c',
              title: 'Challenger',
              state: { name: 'Backlog' },
              completedAt: null,
              canceledAt: null,
            },
            {
              id: 'issue-3',
              identifier: 'HOK-701_c',
              title: 'Closed challenger',
              state: { name: 'Done' },
              completedAt: '2026-05-01T00:00:00Z',
              canceledAt: null,
            },
          ],
        },
      };
    }
    throw new Error(`Unhandled query: ${payload.query}`);
  });

  try {
    const issues = await listOpenIssuesByIdentifierPrefix('HOK-701');
    assert.deepEqual(receivedIdentifiers, ['HOK-701', 'HOK-701_c']);
    assert.deepEqual(issues.map((issue) => issue.identifier), ['HOK-701', 'HOK-701_c']);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// createComment / updateComment (HOK-2356)
// ---------------------------------------------------------------------------

test('createComment sends commentCreate GraphQL mutation with correct shape', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let capturedPayload: { query: string; variables?: Record<string, unknown> } | null = null;

  const restore = installFetchMock((payload) => {
    capturedPayload = payload;
    return {
      commentCreate: {
        success: true,
        comment: { id: 'cmt-abc', url: 'https://linear.app/c/cmt-abc' },
      },
    };
  });

  try {
    const result = await createComment('issue-uuid-1', 'Hello from test');
    assert.ok(capturedPayload, 'fetch must have been called');
    assert.ok(capturedPayload!.query.includes('commentCreate'), 'query should include commentCreate');
    assert.ok(capturedPayload!.query.includes('CommentCreateInput'), 'query should reference CommentCreateInput');
    assert.deepEqual(capturedPayload!.variables, { input: { issueId: 'issue-uuid-1', body: 'Hello from test' } });
    assert.equal(result.id, 'cmt-abc');
    assert.equal(result.url, 'https://linear.app/c/cmt-abc');
  } finally {
    restore();
  }
});

test('createComment throws LinearApiError when API returns success:false', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const restore = installFetchMock(() => ({
    commentCreate: { success: false, comment: null },
  }));
  try {
    await assert.rejects(
      () => createComment('issue-uuid-1', 'body'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('commentCreate'));
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('updateComment sends commentUpdate GraphQL mutation with correct shape', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let capturedPayload: { query: string; variables?: Record<string, unknown> } | null = null;

  const restore = installFetchMock((payload) => {
    capturedPayload = payload;
    return {
      commentUpdate: {
        success: true,
        comment: { id: 'cmt-abc', url: 'https://linear.app/c/cmt-abc' },
      },
    };
  });

  try {
    const result = await updateComment('cmt-abc', 'Updated body');
    assert.ok(capturedPayload, 'fetch must have been called');
    assert.ok(capturedPayload!.query.includes('commentUpdate'), 'query should include commentUpdate');
    assert.ok(capturedPayload!.query.includes('CommentUpdateInput'), 'query should reference CommentUpdateInput');
    assert.deepEqual(capturedPayload!.variables, { id: 'cmt-abc', input: { body: 'Updated body' } });
    assert.equal(result.id, 'cmt-abc');
    assert.equal(result.url, 'https://linear.app/c/cmt-abc');
  } finally {
    restore();
  }
});

test('updateComment throws LinearApiError when API returns success:false', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const restore = installFetchMock(() => ({
    commentUpdate: { success: false, comment: null },
  }));
  try {
    await assert.rejects(
      () => updateComment('cmt-abc', 'body'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('commentUpdate'));
        return true;
      },
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Initiative document helpers (HOK-3123)
// ---------------------------------------------------------------------------

test('getInitiativeDocuments returns document nodes attached to the initiative', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let captured: GraphQLPayload | null = null;
  const restore = installFetchMock((payload) => {
    captured = payload;
    return {
      initiative: {
        documents: {
          nodes: [
            { id: 'doc-1', title: 'I-27 tool-choice gate progress', content: 'body', updatedAt: '2026-09-29T00:00:00Z', url: 'https://linear.app/d/doc-1' },
            { id: 'doc-2', title: 'something else' },
          ],
        },
      },
    };
  });
  try {
    const docs = await getInitiativeDocuments('init-uuid');
    assert.ok(captured, 'fetch must have been called');
    assert.ok(captured!.query.includes('initiative(id: $id)'));
    assert.ok(captured!.query.includes('documents'));
    assert.deepEqual(captured!.variables, { id: 'init-uuid' });
    assert.equal(docs.length, 2);
    assert.equal(docs[0].id, 'doc-1');
    assert.equal(docs[0].title, 'I-27 tool-choice gate progress');
  } finally {
    restore();
  }
});

test('getInitiativeDocuments returns an empty array when initiative has no documents', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const restore = installFetchMock(() => ({ initiative: { documents: { nodes: [] } } }));
  try {
    const docs = await getInitiativeDocuments('init-uuid');
    assert.deepEqual(docs, []);
  } finally {
    restore();
  }
});

test('createInitiativeDocument sends DocumentCreateInput with initiativeId, title, content', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let captured: GraphQLPayload | null = null;
  const restore = installFetchMock((payload) => {
    captured = payload;
    return {
      documentCreate: {
        success: true,
        document: { id: 'doc-new', url: 'https://linear.app/d/doc-new' },
      },
    };
  });
  try {
    const result = await createInitiativeDocument('init-uuid', {
      title: 'I-27 tool-choice gate progress',
      content: 'body markdown',
    });
    assert.ok(captured, 'fetch must have been called');
    assert.ok(captured!.query.includes('documentCreate'));
    assert.deepEqual(captured!.variables, {
      input: {
        initiativeId: 'init-uuid',
        title: 'I-27 tool-choice gate progress',
        content: 'body markdown',
      },
    });
    assert.equal(result.id, 'doc-new');
    assert.equal(result.url, 'https://linear.app/d/doc-new');
  } finally {
    restore();
  }
});

test('createInitiativeDocument throws LinearApiError when API returns success:false', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const restore = installFetchMock(() => ({
    documentCreate: { success: false, document: null },
  }));
  try {
    await assert.rejects(
      () => createInitiativeDocument('init-uuid', { title: 't', content: 'c' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('documentCreate'));
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('updateDocument omits unset fields from the input', async () => {
  process.env.LINEAR_API_KEY = 'test';
  let captured: GraphQLPayload | null = null;
  const restore = installFetchMock((payload) => {
    captured = payload;
    return {
      documentUpdate: {
        success: true,
        document: { id: 'doc-1', url: 'https://linear.app/d/doc-1' },
      },
    };
  });
  try {
    await updateDocument('doc-1', { content: 'new body' });
    assert.ok(captured, 'fetch must have been called');
    assert.ok(captured!.query.includes('documentUpdate'));
    // Title omitted; content passed through.
    assert.deepEqual(captured!.variables, { id: 'doc-1', input: { content: 'new body' } });
  } finally {
    restore();
  }
});

test('updateDocument throws LinearApiError when API returns success:false', async () => {
  process.env.LINEAR_API_KEY = 'test';
  const restore = installFetchMock(() => ({
    documentUpdate: { success: false, document: null },
  }));
  try {
    await assert.rejects(
      () => updateDocument('doc-1', { content: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('documentUpdate'));
        return true;
      },
    );
  } finally {
    restore();
  }
});
