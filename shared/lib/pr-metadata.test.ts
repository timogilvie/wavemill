import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractMetadataBlock,
  parsePrMetadata,
  PR_METADATA_SCHEMA_VERSION,
  PR_ROUTE_METADATA_SCHEMA_VERSION,
  renderPrMetadata,
  stableJsonStringify,
  updatePrMetadata,
  validatePrMetadata,
  validateMetadataFields,
  type ExecutedPrRoute,
  type PrMetadata,
} from './pr-metadata.ts';

const EXECUTED_ROUTE_FIXTURE: ExecutedPrRoute = {
  schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
  issue: 'HOK-2945',
  head_sha: 'abc123',
  planner: {
    status: 'executed',
    requested_selector: 'planner-a',
    resolved_model: 'planner-a',
    adapter: 'claude',
    source: 'artifact',
    pinned: true,
    evidence: { source: 'stage-result', status: 'direct', stage: 'planning', head_sha: 'abc123' },
  },
  coder: {
    status: 'executed',
    requested_selector: 'coder-a',
    resolved_model: 'coder-b',
    adapter: 'codex',
    source: 'artifact',
    pinned: false,
    fallback_reason: 'runtime_fallback',
    evidence: { source: 'stage-result', status: 'direct', stage: 'coding', head_sha: 'abc123' },
  },
  reviewer: {
    status: 'executed',
    evidence: { source: 'native-runtime', status: 'direct', stage: 'review', head_sha: 'abc123' },
    orchestrator: {
      requested_selector: 'claude-haiku-4-5',
      resolved_model: 'claude-haiku-4-5',
      adapter: 'native',
      source: 'artifact',
      pinned: true,
    },
    substantiveAnalysis: {
      requested_selector: 'gemini',
      resolved_model: 'google/gemini-2.5-pro',
      adapter: 'openrouter',
      source: 'derived',
      pinned: false,
    },
  },
};

describe('extractMetadataBlock', () => {
  it('returns the original body when no block is present', () => {
    const body = '## Summary\n\nPlain PR body.';
    assert.deepEqual(extractMetadataBlock(body), {
      block: null,
      bodyWithoutBlock: body,
    });
  });

  it('uses the last metadata block and removes all metadata blocks from the body', () => {
    const body = [
      'Before',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'Middle',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      '-->',
      '',
      'After',
    ].join('\n');

    assert.deepEqual(extractMetadataBlock(body), {
      block: 'task: HOK-2',
      bodyWithoutBlock: ['Before', '', 'Middle', '', 'After'].join('\n'),
    });
  });
});

describe('parsePrMetadata', () => {
  it('returns empty metadata for bodies without a metadata block', () => {
    for (const body of ['', '   ', '## Summary\n\nNo hidden metadata here.']) {
      assert.deepEqual(parsePrMetadata(body), {
        ok: true,
        metadata: {},
        bodyWithoutBlock: body,
      });
    }
  });

  it('round-trips all supported fields', () => {
    const metadata: PrMetadata = {
      'schema-version': PR_METADATA_SCHEMA_VERSION,
      task: 'HOK-1432',
      stack: 'integration',
      depends_on: ['HOK-1431'],
      depends_on_linear: ['LIN-42'],
      requires: ['ci-green', 'approval'],
      risk: 'medium',
      challenge: false,
      challengePairId: 'pair-1',
      route_schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
      executed_route: EXECUTED_ROUTE_FIXTURE,
    };

    const parsed = parsePrMetadata(renderPrMetadata(metadata));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, metadata);
    assert.equal(parsed.bodyWithoutBlock, '');
  });

  it('preserves non-metadata PR body content', () => {
    const body = [
      '# Title',
      '',
      'Summary paragraph.',
      '',
      '<!-- keep-me -->',
      '',
      '```ts',
      'console.log("hello");',
      '```',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1432',
      'risk: low',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, { task: 'HOK-1432', risk: 'low' });
    assert.equal(
      parsed.bodyWithoutBlock,
      [
        '# Title',
        '',
        'Summary paragraph.',
        '',
        '<!-- keep-me -->',
        '',
        '```ts',
        'console.log("hello");',
        '```',
      ].join('\n'),
    );
  });

  it('reports invalid metadata clearly without throwing', () => {
    const body = [
      '<!-- wavemill-meta',
      'task:   ',
      'depends_on: not-json',
      'depends_on_linear: [1]',
      'requires: ["ok", 2]',
      'risk: severe',
      'challenge: maybe',
      'extra: surprise',
      'bad line',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.errors, [
      {
        field: 'task',
        code: 'empty-value',
        message: 'Expected non-empty string for task',
      },
      {
        field: 'depends_on',
        code: 'wrong-type',
        message: 'Invalid JSON for depends_on',
      },
      {
        field: 'depends_on_linear',
        code: 'wrong-type',
        message: 'Expected JSON string array for depends_on_linear',
      },
      {
        field: 'requires',
        code: 'wrong-type',
        message: 'Expected JSON string array for requires',
      },
      {
        field: 'risk',
        code: 'wrong-type',
        message: 'Expected one of low, medium, high for risk',
      },
      {
        field: 'challenge',
        code: 'wrong-type',
        message: 'Expected boolean true/false for challenge',
      },
      {
        field: 'extra',
        code: 'unknown-field',
        message: 'Unknown wavemill-meta field: extra',
      },
      {
        field: '(malformed)',
        code: 'malformed-line',
        message: 'Malformed wavemill-meta line',
      },
    ]);
    assert.equal(parsed.bodyWithoutBlock, '');
  });

  it('parses the last metadata block when multiple exist', () => {
    const body = [
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'Summary',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      'challenge: true',
      '-->',
    ].join('\n');

    const parsed = parsePrMetadata(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, { task: 'HOK-2', challenge: true });
    assert.equal(parsed.bodyWithoutBlock, 'Summary');
  });

  it('accepts the current metadata schema version', () => {
    const parsed = parsePrMetadata([
      '<!-- wavemill-meta',
      `schema-version: ${PR_METADATA_SCHEMA_VERSION}`,
      'task: HOK-1432',
      '-->',
    ].join('\n'));

    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.metadata, {
      'schema-version': PR_METADATA_SCHEMA_VERSION,
      task: 'HOK-1432',
    });
  });

  it('rejects unsupported future metadata schema versions', () => {
    const parsed = parsePrMetadata([
      '<!-- wavemill-meta',
      'schema-version: 999',
      'task: HOK-1432',
      '-->',
    ].join('\n'));

    assert.equal(parsed.ok, false);
    if (parsed.ok) {
      return;
    }

    assert.deepEqual(parsed.errors, [
      {
        field: 'schema-version',
        code: 'unsupported-version',
        message: 'Unsupported wavemill-meta schema-version',
      },
    ]);
  });
});

describe('renderPrMetadata', () => {
  it('renders fields in deterministic order', () => {
    const rendered = renderPrMetadata({
      'schema-version': PR_METADATA_SCHEMA_VERSION,
      challenge: true,
      challengePairId: 'pair-9',
      route_schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
      executed_route: EXECUTED_ROUTE_FIXTURE,
      risk: 'high',
      requires: ['qa'],
      task: 'HOK-1432',
      depends_on_linear: ['LIN-9'],
      stack: 'integration',
      depends_on: ['HOK-1431'],
    });

    assert.equal(
      rendered,
      [
        '<!-- wavemill-meta',
        `schema-version: ${PR_METADATA_SCHEMA_VERSION}`,
        'task: HOK-1432',
        'stack: integration',
        'depends_on: ["HOK-1431"]',
        'depends_on_linear: ["LIN-9"]',
        'requires: ["qa"]',
        'risk: high',
        'challenge: true',
        'challengePairId: pair-9',
        'route_schema: 1',
        `executed_route: ${stableJsonStringify(EXECUTED_ROUTE_FIXTURE)}`,
        '-->',
      ].join('\n'),
    );
  });

  it('rejects route metadata without the paired schema fields', () => {
    assert.throws(
      () => renderPrMetadata({ task: 'HOK-2945', executed_route: EXECUTED_ROUTE_FIXTURE }),
      /executed_route requires route_schema/,
    );

    const parsed = parsePrMetadata([
      '<!-- wavemill-meta',
      'task: HOK-2945',
      'route_schema: 1',
      '-->',
    ].join('\n'));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.errors[0].message, 'route_schema requires executed_route');
    }
  });

  it('rejects derived identities that are falsely pinned', () => {
    const route: ExecutedPrRoute = {
      ...EXECUTED_ROUTE_FIXTURE,
      reviewer: {
        ...EXECUTED_ROUTE_FIXTURE.reviewer,
        substantiveAnalysis: {
          ...EXECUTED_ROUTE_FIXTURE.reviewer.substantiveAnalysis,
          pinned: true,
        },
      },
    };

    assert.throws(
      () => renderPrMetadata({
        route_schema: PR_ROUTE_METADATA_SCHEMA_VERSION,
        executed_route: route,
      }),
      /Derived identity cannot be pinned/,
    );
  });

  it('renders an empty block when no fields are set', () => {
    assert.equal(renderPrMetadata({}), '<!-- wavemill-meta\n\n-->');
  });

  it('fails closed when a writer attempts an unknown metadata field', () => {
    assert.throws(
      () => renderPrMetadata({
        task: 'HOK-1',
        'review-infrastructure-note': 'native-context-window-exceeded',
      } as PrMetadata & Record<string, string>),
      /Unknown wavemill-meta field: review-infrastructure-note/,
    );
  });
});

describe('updatePrMetadata', () => {
  it('is idempotent across representative bodies', () => {
    const metadata: PrMetadata = {
      task: 'HOK-1432',
      depends_on: ['HOK-1431'],
      risk: 'medium',
      challenge: false,
    };

    for (const body of [
      '',
      '   ',
      'Summary',
      'Summary\n',
      ['# Title', '', 'Body', '', '<!-- wavemill-meta', 'task: OLD', '-->'].join('\n'),
    ]) {
      const once = updatePrMetadata(body, metadata);
      const twice = updatePrMetadata(once, metadata);
      assert.equal(twice, once);
    }
  });

  it('appends the rendered block after preserved body content', () => {
    const body = [
      '# Summary',
      '',
      '- [x] tests',
      '',
      '<!-- keep -->',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
    ].join('\n');

    assert.equal(
      updatePrMetadata(body, { task: 'HOK-1432', stack: 'integration' }),
      [
        '# Summary',
        '',
        '- [x] tests',
        '',
        '<!-- keep -->',
        '',
        '<!-- wavemill-meta',
        'task: HOK-1432',
        'stack: integration',
        '-->',
      ].join('\n'),
    );
  });

  it('returns only the metadata block for empty bodies', () => {
    assert.equal(
      updatePrMetadata('', { task: 'HOK-1432' }),
      ['<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n'),
    );
  });

  it('collapses multiple metadata blocks to one on update', () => {
    const body = [
      'Intro',
      '',
      '<!-- wavemill-meta',
      'task: HOK-1',
      '-->',
      '',
      'More',
      '',
      '<!-- wavemill-meta',
      'task: HOK-2',
      '-->',
    ].join('\n');

    assert.equal(
      updatePrMetadata(body, { task: 'HOK-1432' }),
      ['Intro', '', 'More', '', '<!-- wavemill-meta', 'task: HOK-1432', '-->'].join('\n'),
    );
  });
});

describe('validatePrMetadata', () => {
  it('returns absent when no block is present', () => {
    assert.deepEqual(validatePrMetadata('No metadata here.'), { status: 'absent' });
  });

  it('returns valid with parsed metadata for a good block', () => {
    const body = ['<!-- wavemill-meta', 'task: HOK-1432', 'risk: low', '-->'].join('\n');
    const result = validatePrMetadata(body);
    assert.equal(result.status, 'valid');
    if (result.status === 'valid') {
      assert.deepEqual(result.metadata, { task: 'HOK-1432', risk: 'low' });
    }
  });

  it('returns invalid with errors for unknown fields (#1324 fixture)', () => {
    const body = [
      '<!-- wavemill-meta',
      'task: HOK-2929',
      'review-infrastructure-note: native-context-window-exceeded',
      '-->',
    ].join('\n');
    const result = validatePrMetadata(body);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].code, 'unknown-field');
    }
  });

  it('returns invalid for malformed lines', () => {
    const body = ['<!-- wavemill-meta', 'not a valid line', '-->'].join('\n');
    const result = validatePrMetadata(body);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.errors[0].code, 'malformed-line');
    }
  });

  it('returns invalid for wrong-type fields', () => {
    const body = ['<!-- wavemill-meta', 'risk: severe', '-->'].join('\n');
    const result = validatePrMetadata(body);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.errors[0].code, 'wrong-type');
      assert.equal(result.errors[0].field, 'risk');
    }
  });

  it('returns invalid for unsupported future schema versions', () => {
    const body = ['<!-- wavemill-meta', 'schema-version: 999', '-->'].join('\n');
    const result = validatePrMetadata(body);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.errors[0].code, 'unsupported-version');
      assert.equal(result.errors[0].field, 'schema-version');
    }
  });
});

describe('validateMetadataFields', () => {
  it('returns no errors for known fields', () => {
    assert.deepEqual(validateMetadataFields({
      'schema-version': PR_METADATA_SCHEMA_VERSION,
      task: 'HOK-1',
      risk: 'low',
    }), []);
  });

  it('rejects unknown fields at write time', () => {
    const errors = validateMetadataFields({ task: 'HOK-1', unknownField: 'value' } as PrMetadata & Record<string, string>);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'unknown-field');
    assert.equal(errors[0].field, 'unknownField');
  });

  it('rejects unsupported schema versions at write time', () => {
    const errors = validateMetadataFields({ 'schema-version': '999' } as PrMetadata);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'unsupported-version');
    assert.equal(errors[0].field, 'schema-version');
  });
});
