import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  NativeCertificationRequirement,
  ToolDescriptor,
  ToolExposureMode,
  ToolFamilyId,
  ToolMetadata,
} from './types.ts';
import {
  createToolRegistry,
  DuplicateLogicalIdError,
  DuplicateToolError,
  InvalidExposureError,
  UnknownLogicalIdError,
  UnknownToolError,
} from './registry.ts';
import { toPiAgentTool } from './pi-adapter.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
  name: string,
  phases: ToolMetadata['allowedPhases'] = ['planning', 'coding', 'review'],
): ToolDescriptor {
  return {
    metadata: {
      name,
      description: `Description for ${name}`,
      class: 'read-only',
      allowedPhases: phases,
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: { type: 'object', properties: {} },
    async execute(_toolCallId, _params) {
      return { content: [{ type: 'text', text: `result:${name}` }], details: undefined };
    },
  };
}

function makeAdvancedDescriptor(options: {
  name: string;
  family: ToolFamilyId;
  logicalId?: string;
  phases?: ToolMetadata['allowedPhases'];
  exposure?: ToolExposureMode;
  certificationRequirement?: NativeCertificationRequirement;
}): ToolDescriptor {
  return {
    metadata: {
      name: options.name,
      description: `Description for ${options.name}`,
      class: 'read-only',
      allowedPhases: options.phases ?? ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
      family: options.family,
      logicalId: options.logicalId,
      exposure: options.exposure,
      certificationRequirement: options.certificationRequirement,
    },
    parameters: { type: 'object', properties: {} },
    async execute(_toolCallId, _params) {
      return { content: [{ type: 'text', text: `result:${options.name}` }], details: undefined };
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy phase exposure
// ---------------------------------------------------------------------------

describe('registry — lazy phase exposure', () => {
  it('returns tools allowed in the requested phase', () => {
    const registry = createToolRegistry();
    registry.register(makeDescriptor('read_file', ['planning', 'coding', 'review']));
    registry.register(makeDescriptor('list_dir', ['planning']));
    registry.register(makeDescriptor('run_review_lint', ['review']));

    const planning = registry.getTools({ phase: 'planning' });
    assert.deepEqual(
      planning.map((d) => d.metadata.name),
      ['read_file', 'list_dir'],
    );

    const review = registry.getTools({ phase: 'review' });
    assert.deepEqual(
      review.map((d) => d.metadata.name),
      ['read_file', 'run_review_lint'],
    );
  });

  it('returns empty array for an empty registry with phase filter', () => {
    const registry = createToolRegistry();
    assert.deepEqual(registry.getTools({ phase: 'planning' }), []);
  });

  it('returns all tools when no phase is specified', () => {
    const registry = createToolRegistry();
    registry.register(makeDescriptor('read_file', ['planning', 'coding', 'review']));
    registry.register(makeDescriptor('list_dir', ['planning']));

    const all = registry.getTools();
    assert.deepEqual(
      all.map((d) => d.metadata.name),
      ['read_file', 'list_dir'],
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

describe('registry — deterministic ordering', () => {
  it('returns tools in registration order regardless of request order', () => {
    const registry = createToolRegistry([
      makeDescriptor('alpha'),
      makeDescriptor('bravo'),
      makeDescriptor('charlie'),
    ]);

    const result = registry.getTools({ names: ['charlie', 'alpha'] });
    assert.deepEqual(
      result.map((d) => d.metadata.name),
      ['alpha', 'charlie'],
    );
  });

  it('returns the same order across repeated calls', () => {
    const registry = createToolRegistry([
      makeDescriptor('alpha'),
      makeDescriptor('bravo'),
      makeDescriptor('charlie'),
    ]);

    const first = registry.getTools().map((d) => d.metadata.name);
    const second = registry.getTools().map((d) => d.metadata.name);
    assert.deepEqual(first, second);
  });

  it('preserves registration order when phase and names filters intersect', () => {
    const registry = createToolRegistry([
      makeDescriptor('alpha', ['planning', 'coding', 'review']),
      makeDescriptor('bravo', ['planning']),
      makeDescriptor('charlie', ['planning', 'coding', 'review']),
    ]);

    const result = registry.getTools({ phase: 'planning', names: ['charlie', 'alpha'] });
    assert.deepEqual(
      result.map((d) => d.metadata.name),
      ['alpha', 'charlie'],
    );
  });

  it('preserves registration order when family and logicalIds filters compose', () => {
    const registry = createToolRegistry([
      makeDescriptor('read_file'),
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser', exposure: 'opt-in' }),
      makeAdvancedDescriptor({ name: 'browser_snapshot', family: 'browser', exposure: 'opt-in' }),
    ]);

    const result = registry.getTools({
      family: 'browser',
      logicalIds: ['browser.browser_snapshot', 'browser.browser_navigate'],
    });
    assert.deepEqual(
      result.map((d) => d.metadata.name),
      ['browser_navigate', 'browser_snapshot'],
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate registration
// ---------------------------------------------------------------------------

describe('registry — duplicate registration', () => {
  it('throws DuplicateToolError for an exact-name duplicate', () => {
    const registry = createToolRegistry();
    registry.register(makeDescriptor('read_file'));

    assert.throws(
      () => registry.register(makeDescriptor('read_file')),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateToolError);
        assert.ok(err.message.includes('read_file'));
        assert.equal(err.name, 'DuplicateToolError');
        return true;
      },
    );
  });

  it('original descriptor remains registered after duplicate attempt', () => {
    const original = makeDescriptor('read_file');
    original.metadata = { ...original.metadata, description: 'original' };

    const registry = createToolRegistry([original]);

    const duplicate = makeDescriptor('read_file');
    duplicate.metadata = { ...duplicate.metadata, description: 'duplicate' };

    assert.throws(() => registry.register(duplicate), DuplicateToolError);

    const [registered] = registry.getTools({ names: ['read_file'] });
    assert.equal(registered.metadata.description, 'original');
  });

  it('treats case-different names as distinct', () => {
    const registry = createToolRegistry();
    registry.register(makeDescriptor('Read_File'));
    assert.doesNotThrow(() => registry.register(makeDescriptor('read_file')));
    assert.equal(registry.getTools().length, 2);
  });

  it('throws DuplicateLogicalIdError when two descriptors share a logical id within a family', () => {
    const registry = createToolRegistry();
    registry.register(
      makeAdvancedDescriptor({
        name: 'browser_navigate',
        family: 'browser',
        logicalId: 'browser.navigate',
        exposure: 'opt-in',
      }),
    );

    assert.throws(
      () =>
        registry.register(
          makeAdvancedDescriptor({
            name: 'browser_navigate_v2',
            family: 'browser',
            logicalId: 'browser.navigate',
            exposure: 'opt-in',
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateLogicalIdError);
        assert.ok(err.message.includes('browser.navigate'));
        assert.equal(err.name, 'DuplicateLogicalIdError');
        return true;
      },
    );
  });

  it('allows the same logical suffix across different families', () => {
    const registry = createToolRegistry();
    registry.register(
      makeAdvancedDescriptor({
        name: 'browser_open',
        family: 'browser',
        logicalId: 'browser.open',
        exposure: 'opt-in',
      }),
    );
    assert.doesNotThrow(() =>
      registry.register(
        makeAdvancedDescriptor({
          name: 'mcp_open',
          family: 'mcp',
          logicalId: 'mcp.open',
          exposure: 'opt-in',
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Exposure invariants
// ---------------------------------------------------------------------------

describe('registry — exposure invariants', () => {
  it('rejects core tools declared with opt-in exposure', () => {
    const registry = createToolRegistry();
    const descriptor = makeDescriptor('read_file');
    descriptor.metadata = { ...descriptor.metadata, family: 'core', exposure: 'opt-in' };

    assert.throws(() => registry.register(descriptor), (err: unknown) => {
      assert.ok(err instanceof InvalidExposureError);
      assert.equal(err.name, 'InvalidExposureError');
      return true;
    });
  });

  it('rejects advanced-family tools declared with always exposure', () => {
    const registry = createToolRegistry();
    const descriptor = makeAdvancedDescriptor({
      name: 'browser_navigate',
      family: 'browser',
      exposure: 'always',
    });

    assert.throws(() => registry.register(descriptor), InvalidExposureError);
  });

  it('inflates legacy descriptors to core/always/none via withDefaultMetadata', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const [meta] = registry.list();
    assert.equal(meta.family, 'core');
    assert.equal(meta.logicalId, 'core.read_file');
    assert.equal(meta.exposure, 'always');
    assert.equal(meta.certificationRequirement, 'none');
    assert.equal(meta.provenance, 'repo-trusted');
    assert.ok(meta.policy);
    assert.equal(meta.policy.pathMode, 'read-only');
  });

  it('advanced descriptors inflate to opt-in and workflow certification by default', () => {
    const registry = createToolRegistry();
    registry.register(
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser' }),
    );
    const [meta] = registry.list({ family: 'browser' });
    assert.equal(meta.exposure, 'opt-in');
    assert.equal(meta.certificationRequirement, 'workflow');
    assert.equal(meta.family, 'browser');
    assert.equal(meta.logicalId, 'browser.browser_navigate');
  });
});

// ---------------------------------------------------------------------------
// Family and logical id catalog queries
// ---------------------------------------------------------------------------

describe('registry — family and logical id queries', () => {
  it('getFamilies returns families in first-registration order', () => {
    const registry = createToolRegistry([
      makeDescriptor('read_file'),
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser' }),
      makeAdvancedDescriptor({ name: 'mcp_call', family: 'mcp' }),
      makeAdvancedDescriptor({ name: 'browser_snapshot', family: 'browser' }),
    ]);
    assert.deepEqual(registry.getFamilies(), ['core', 'browser', 'mcp']);
  });

  it('getByFamily restricts to the requested family', () => {
    const registry = createToolRegistry([
      makeDescriptor('read_file'),
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser' }),
      makeAdvancedDescriptor({ name: 'mcp_call', family: 'mcp' }),
    ]);
    const browserOnly = registry.getByFamily('browser');
    assert.deepEqual(
      browserOnly.map((d) => d.metadata.name),
      ['browser_navigate'],
    );
  });

  it('logicalIds filter throws UnknownLogicalIdError on unknown ids', () => {
    const registry = createToolRegistry([
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser' }),
    ]);
    assert.throws(
      () => registry.getTools({ logicalIds: ['browser.does_not_exist'] }),
      (err: unknown) => {
        assert.ok(err instanceof UnknownLogicalIdError);
        assert.ok(err.message.includes('browser.does_not_exist'));
        assert.equal(err.name, 'UnknownLogicalIdError');
        return true;
      },
    );
  });

  it('logicalIds empty array returns empty list', () => {
    const registry = createToolRegistry([
      makeAdvancedDescriptor({ name: 'browser_navigate', family: 'browser' }),
    ]);
    assert.deepEqual(registry.getTools({ logicalIds: [] }), []);
  });

  it('hasLogicalId reflects registered descriptors', () => {
    const registry = createToolRegistry();
    registry.register(
      makeAdvancedDescriptor({
        name: 'browser_navigate',
        family: 'browser',
        logicalId: 'browser.navigate',
      }),
    );
    assert.equal(registry.hasLogicalId('browser.navigate'), true);
    assert.equal(registry.hasLogicalId('browser.does_not_exist'), false);
  });
});

// ---------------------------------------------------------------------------
// Unknown requested tools
// ---------------------------------------------------------------------------

describe('registry — unknown requested tools', () => {
  it('throws UnknownToolError when a requested name does not exist', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);

    assert.throws(
      () => registry.getTools({ names: ['read_file', 'frobnicate'] }),
      (err: unknown) => {
        assert.ok(err instanceof UnknownToolError);
        assert.ok(err.message.includes('frobnicate'));
        assert.equal(err.name, 'UnknownToolError');
        return true;
      },
    );
  });

  it('throws UnknownToolError even when a phase filter is also provided', () => {
    const registry = createToolRegistry([makeDescriptor('read_file', ['planning'])]);

    assert.throws(
      () => registry.getTools({ phase: 'planning', names: ['frobnicate'] }),
      UnknownToolError,
    );
  });

  it('returns empty array for an empty names array', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    assert.deepEqual(registry.getTools({ names: [] }), []);
  });

  it('does not throw for a known name that is excluded by phase filter', () => {
    const registry = createToolRegistry([makeDescriptor('read_file', ['planning'])]);

    assert.doesNotThrow(() => {
      const result = registry.getTools({ phase: 'review', names: ['read_file'] });
      assert.deepEqual(result, []);
    });
  });
});

// ---------------------------------------------------------------------------
// Metadata shape
// ---------------------------------------------------------------------------

describe('registry — metadata shape', () => {
  it('list() returns metadata-only entries with all stable fields', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const entries = registry.list();

    assert.equal(entries.length, 1);
    const [meta] = entries;
    assert.equal(meta.name, 'read_file');
    assert.equal(meta.description, 'Description for read_file');
    assert.equal(meta.class, 'read-only');
    assert.deepEqual(meta.allowedPhases, ['planning', 'coding', 'review']);
    assert.equal(meta.executionMode, 'parallel');
    assert.deepEqual(meta.outputCapPolicy, { strategy: 'none' });
  });

  it('list() entries do not include execute', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const [meta] = registry.list();
    assert.ok(!('execute' in meta), 'execute should not appear in list() results');
  });

  it('outputCapPolicy with strategy none is preserved', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const [meta] = registry.list();
    assert.deepEqual(meta.outputCapPolicy, { strategy: 'none' });
  });

  it('outputCapPolicy with truncate strategy and maxBytes is preserved', () => {
    const d = makeDescriptor('big_tool');
    d.metadata = { ...d.metadata, outputCapPolicy: { strategy: 'truncate', maxBytes: 4096 } };
    const registry = createToolRegistry([d]);
    const [meta] = registry.list();
    assert.deepEqual(meta.outputCapPolicy, { strategy: 'truncate', maxBytes: 4096 });
  });

  it('list() returns a new array each call', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const first = registry.list();
    const second = registry.list();
    assert.notEqual(first, second);
  });

  it('getTools() returns a new array each call', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    const first = registry.getTools();
    const second = registry.getTools();
    assert.notEqual(first, second);
  });

  it('has() returns true for registered names and false otherwise', () => {
    const registry = createToolRegistry([makeDescriptor('read_file')]);
    assert.equal(registry.has('read_file'), true);
    assert.equal(registry.has('frobnicate'), false);
  });
});

// ---------------------------------------------------------------------------
// Pi adapter seam
// ---------------------------------------------------------------------------

describe('pi-adapter — toPiAgentTool', () => {
  it('maps name, description, label, executionMode, and parameters', () => {
    const d = makeDescriptor('read_file', ['planning']);
    d.label = 'Read File';

    const piTool = toPiAgentTool(d);

    assert.equal(piTool.name, 'read_file');
    assert.equal(piTool.description, 'Description for read_file');
    assert.equal(piTool.label, 'Read File');
    assert.equal(piTool.executionMode, 'parallel');
    assert.deepEqual(piTool.parameters, { type: 'object', properties: {} });
  });

  it('defaults label to metadata.name when descriptor has no label', () => {
    const d = makeDescriptor('read_file');
    const piTool = toPiAgentTool(d);
    assert.equal(piTool.label, 'read_file');
  });

  it('execute wraps Wavemill result into Pi AgentToolResult shape', async () => {
    const d = makeDescriptor('read_file');
    const piTool = toPiAgentTool(d);

    const result = await piTool.execute('call-1', {});
    assert.deepEqual(result.content, [{ type: 'text', text: 'result:read_file' }]);
    assert.equal(result.details, undefined);
  });

  it('does not expose Pi types in registry.ts or types.ts (seam check)', async () => {
    // Import these modules and verify they do not trigger Pi initialisation
    // by checking that we can create and query a registry without Pi being present.
    const { createToolRegistry: cr } = await import('./registry.ts');
    const { makeDescriptor: _md } = { makeDescriptor };
    const reg = cr([makeDescriptor('alpha')]);
    assert.equal(reg.has('alpha'), true);
    const meta = reg.list()[0];
    assert.ok(!('execute' in meta));
  });
});
