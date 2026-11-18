import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileSchemaValidator } from '../schema-validators.ts';
import {
  buildNativePatchGuidance,
  NATIVE_PATCH_EXAMPLE,
  NATIVE_PATCH_PARAMETERS_SCHEMA,
  NATIVE_PATCH_VERSION,
  normalizePatchPath,
  validateNativePatch,
  type NativePatchValidationError,
} from './patch-contract.ts';

function schemaAccepts(payload: unknown): boolean {
  const validate = compileSchemaValidator(NATIVE_PATCH_PARAMETERS_SCHEMA, { allErrors: true, strict: false });
  return validate(payload) === true;
}

function additionalPropertyErrors(
  errors: NativePatchValidationError[],
  property: string,
): NativePatchValidationError[] {
  return errors.filter(
    (error) => error.keyword === 'additionalProperties' && error.params?.additionalProperty === property,
  );
}

function missingPropertyErrors(
  errors: NativePatchValidationError[],
  property: string,
): NativePatchValidationError[] {
  return errors.filter(
    (error) => error.keyword === 'required' && error.params?.missingProperty === property,
  );
}

describe('patch-contract', () => {
  it('keeps the documented NativePatch example valid and parseable', () => {
    const exampleResult = validateNativePatch(NATIVE_PATCH_EXAMPLE);
    assert.equal(exampleResult.ok, true);

    const guidance = buildNativePatchGuidance();
    assert.match(guidance, /version/);
    assert.match(guidance, /atomic/);
    assert.match(guidance, /operations/);
    assert.match(guidance, /edit-diff/);
    assert.match(guidance, /\bedit\b/);

    const jsonMatch = guidance.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(jsonMatch);
    const parsed = JSON.parse(jsonMatch[1]!);
    const parsedResult = validateNativePatch(parsed);
    assert.equal(parsedResult.ok, true);
  });

  describe('normalizePatchPath', () => {
    it('normalizes repo-relative POSIX paths', () => {
      assert.equal(normalizePatchPath('./src//native-agent/../native-agent/patch.ts'), null);
      assert.equal(normalizePatchPath('./src//native-agent/patch.ts'), 'src/native-agent/patch.ts');
    });

    it('rejects absolute, traversal, and windows-style paths', () => {
      assert.equal(normalizePatchPath('/tmp/file.ts'), null);
      assert.equal(normalizePatchPath('../file.ts'), null);
      assert.equal(normalizePatchPath('src\\file.ts'), null);
    });
  });

  it('accepts a valid edit envelope', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 0.8,
        maxMatchCandidates: 2,
        maxContextLines: 4,
        ignoreWhitespace: true,
      },
      operations: [
        {
          op: 'edit',
          path: './shared/lib/stage-result.ts',
          oldText: 'before',
          newText: 'after',
          anchorBefore: 'leading context',
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      version: 1,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 0.8,
        maxMatchCandidates: 2,
        maxContextLines: 4,
        ignoreWhitespace: true,
      },
      operations: [
        {
          op: 'edit',
          path: 'shared/lib/stage-result.ts',
          oldText: 'before',
          newText: 'after',
          anchorBefore: 'leading context',
        },
      ],
    });
  });

  it('accepts a valid edit-diff envelope', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit-diff',
          path: 'shared/lib/native-agent/patch-contract.ts',
          diff: '@@ -1 +1 @@\n-before\n+after',
          anchorAfter: 'trailing context',
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.operations[0]?.op, 'edit-diff');
  });

  it('rejects non-object payloads', () => {
    const result = validateNativePatch(null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]?.code, 'invalid_type');
  });

  describe('schema parity', () => {
    const validFixtures = [
      NATIVE_PATCH_EXAMPLE,
      {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [{ op: 'edit', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
      {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [{ op: 'edit-diff', path: 'a.ts', diff: '@@ -1 +1 @@\n-x\n+y' }],
      },
      {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [{ op: 'edit', path: 'a.ts', oldText: 'x', newText: 'y', expectedOccurrences: 2 }],
      },
      {
        version: NATIVE_PATCH_VERSION,
        atomic: true,
        operations: [{ op: 'edit', path: 'a.ts', oldText: 'x', newText: 'y' }],
        fuzzyMatch: {
          minSimilarity: 0.5,
          maxMatchCandidates: 3,
          maxContextLines: 2,
          ignoreWhitespace: true,
          requireAnchorOverlap: false,
        },
      },
    ];

    for (const fixture of validFixtures) {
      const label = JSON.stringify(fixture).slice(0, 80);
      it(`agrees with the advertised schema for: ${label}`, () => {
        assert.equal(schemaAccepts(fixture), true);
        const result = validateNativePatch(fixture);
        assert.equal(result.ok, true);
      });
    }
  });

  it('rejects HOK-3493 attempt-2 corrupted keys by name', () => {
    const payload: Record<string, unknown> = {
      version: 1,
      atomicity: true,
    };
    payload['operations '] = [{ op: 'edit', path: 'src/app.ts', oldText: 'a', newText: 'b' }];
    const result = validateNativePatch(payload);

    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.ok(additionalPropertyErrors(result.errors, 'atomicity').length > 0, 'names atomicity');
    assert.ok(
      additionalPropertyErrors(result.errors, 'operations ').length > 0,
      'names operations (trailing space)',
    );
    assert.ok(missingPropertyErrors(result.errors, 'atomic').length > 0, 'names missing atomic');
    assert.ok(missingPropertyErrors(result.errors, 'operations').length > 0, 'names missing operations');
  });

  it('rejects HOK-3493 attempt-1-style corrupted operations key by name', () => {
    const result = validateNativePatch({
      version: 1,
      atomic: true,
      operationsploader: [{ op: 'edit', path: 'src/app.ts', oldText: 'a', newText: 'b' }],
    } as unknown);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(additionalPropertyErrors(result.errors, 'operationsploader').length > 0);
    assert.ok(missingPropertyErrors(result.errors, 'operations').length > 0);
  });

  it('rejects unknown operation keys by name', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: 'file.ts', oldText: 'a', newText: 'b', edits: 'x' },
      ],
    } as unknown);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(additionalPropertyErrors(result.errors, 'edits').length > 0);
    const operationError = result.errors.find((error) => error.path === '$.operations[0]');
    assert.ok(operationError);
  });

  it('rejects missing required operation fields by name', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: 'file.ts', newText: 'b' },
      ],
    } as unknown);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(missingPropertyErrors(result.errors, 'oldText').length > 0);
  });

  it('rejects invalid path normalization inputs', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: '../file.ts', oldText: 'a', newText: 'b' },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.errors, [
      {
        code: 'invalid_path',
        path: '$.operations[0].path',
        message: 'NativePatch operation path must be a repo-relative POSIX path without traversal.',
        operationIndex: 0,
      },
    ]);
  });

  it('rejects invalid context and fuzzy settings', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      fuzzyMatch: {
        minSimilarity: 1.1,
        maxMatchCandidates: 0,
        ignoreWhitespace: 'yes',
      },
      operations: [
        {
          op: 'edit',
          path: 'file.ts',
          oldText: 'a',
          newText: 'b',
          anchorBefore: '',
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    const paths = new Set(result.errors.map((error) => error.path));
    assert.ok(paths.has('$.fuzzyMatch.minSimilarity'));
    assert.ok(paths.has('$.fuzzyMatch.maxMatchCandidates'));
    assert.ok(paths.has('$.fuzzyMatch.ignoreWhitespace'));
    assert.ok(paths.has('$.operations[0].anchorBefore'));
  });

  it('rejects edit operations whose oldText equals newText', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'edit', path: 'src/a.ts', oldText: 'x', newText: 'x' },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(
      result.errors.map((error) => ({ code: error.code, operationIndex: error.operationIndex })),
      [{ code: 'identical_old_new', operationIndex: 0 }],
    );
  });

  it('accepts and validates expectedOccurrences', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src/a.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 3,
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.operations[0]?.expectedOccurrences, 3);
  });

  it('rejects negative or non-integer expectedOccurrences', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        {
          op: 'edit',
          path: 'src/a.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 0,
        },
        {
          op: 'edit',
          path: 'src/b.ts',
          oldText: 'foo',
          newText: 'bar',
          expectedOccurrences: 1.5,
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    const paths = new Set(result.errors.map((error) => error.path));
    assert.ok(paths.has('$.operations[0].expectedOccurrences'));
    assert.ok(paths.has('$.operations[1].expectedOccurrences'));
  });

  it('rejects an unsupported operation variant', () => {
    const result = validateNativePatch({
      version: NATIVE_PATCH_VERSION,
      atomic: true,
      operations: [
        { op: 'rename', path: 'src/a.ts' },
      ],
    } as unknown);

    assert.equal(result.ok, false);
    if (result.ok) return;
    const enumError = result.errors.find(
      (error) => error.path === '$.operations[0].op' && error.keyword === 'enum',
    );
    assert.ok(enumError, 'expected an enum error at the operation op');
  });
});
