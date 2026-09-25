import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ResolvedNativeAstConfig } from '../../config.ts';
import type { MutationRecorder, MutationAttempt, PatchSnapshot } from '../cleanup.ts';
import {
  AST_TRANSFORM_CONTRACT_VERSION,
  AST_TRANSFORM_PATH_FIELDS,
  astTransformAfterToolCall,
  buildUnifiedDiff,
  createAstTransformTools,
  type AstTransformApplyDetails,
  type AstTransformApplySuccessDetails,
  type AstTransformErrorDetails,
  type AstTransformPreview,
  type AstTransformPreviewDetails,
  type AstTransformPreviewSuccessDetails,
  type CreateAstTransformToolsInput,
} from './ast-transform.ts';
import type { ToolDescriptor, ToolPhase } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ResolvedNativeAstConfig> = {}): ResolvedNativeAstConfig {
  return {
    enabled: true,
    allowedPhases: ['coding'],
    limits: {
      maxFiles: 2000,
      maxBytes: 32 * 1024 * 1024,
      maxSymbols: 20_000,
      maxMatches: 500,
      maxSummaryBytes: 4096,
      ...(overrides.limits ?? {}),
    },
    invalidReasons: [],
    ...overrides,
  };
}

function makeWorktree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ast-transform-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function toolsFor(
  worktree: string,
  extra: Partial<CreateAstTransformToolsInput> = {},
): { preview: ToolDescriptor; apply: ToolDescriptor } {
  const descriptors = createAstTransformTools({
    config: makeConfig(extra.config ? { ...extra.config } : {}),
    worktreePath: worktree,
    ...extra,
  });
  const preview = descriptors.find((d) => d.metadata.name === 'ast_transform_preview');
  const apply = descriptors.find((d) => d.metadata.name === 'ast_transform_apply');
  assert.ok(preview && apply, 'expected both preview and apply descriptors');
  return { preview, apply };
}

async function runPreview(
  tool: ToolDescriptor,
  params: Record<string, unknown>,
): Promise<AstTransformPreviewDetails> {
  const result = await tool.execute('call-preview', params);
  return result.details as AstTransformPreviewDetails;
}

async function runApply(
  tool: ToolDescriptor,
  preview: unknown,
): Promise<AstTransformApplyDetails> {
  const result = await tool.execute('call-apply', { preview });
  return result.details as AstTransformApplyDetails;
}

function expectPreviewOk(details: AstTransformPreviewDetails): AstTransformPreview {
  assert.equal(details.ok, true, `expected preview ok, got: ${JSON.stringify(details)}`);
  return (details as AstTransformPreviewSuccessDetails).preview;
}

function expectApplyOk(details: AstTransformApplyDetails): AstTransformApplySuccessDetails {
  assert.equal(details.ok, true, `expected apply ok, got: ${JSON.stringify(details)}`);
  return details as AstTransformApplySuccessDetails;
}

function expectError(
  details: AstTransformPreviewDetails | AstTransformApplyDetails,
): AstTransformErrorDetails {
  assert.equal(details.ok, false, `expected error, got: ${JSON.stringify(details)}`);
  return details as AstTransformErrorDetails;
}

function collectRecorder(): {
  recorder: MutationRecorder;
  mutations: MutationAttempt[];
  snapshots: PatchSnapshot[][];
} {
  const mutations: MutationAttempt[] = [];
  const snapshots: PatchSnapshot[][] = [];
  return {
    mutations,
    snapshots,
    recorder: {
      recordMutation: (attempt) => mutations.push(attempt),
      recordPatchSnapshots: (snaps) => snapshots.push([...snaps]),
    },
  };
}

const SINGLE_FILE = {
  'src/app.ts': [
    'export function calculateTotal(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export const total = calculateTotal(1, 2);',
    'export const other = calculateTotal(3, 4);',
    '',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Descriptor gating + metadata
// ---------------------------------------------------------------------------

describe('createAstTransformTools — gating and metadata', () => {
  it('returns [] when config is null or disabled', () => {
    assert.deepEqual(createAstTransformTools({ config: null, worktreePath: '/tmp' }), []);
    assert.deepEqual(
      createAstTransformTools({ config: makeConfig({ enabled: false }), worktreePath: '/tmp' }),
      [],
    );
  });

  it('exposes coding-only, opt-in, patch-certified ast descriptors', () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const descriptors = createAstTransformTools({ config: makeConfig(), worktreePath: dir });
      assert.equal(descriptors.length, 2);
      for (const d of descriptors) {
        assert.equal(d.metadata.family, 'ast');
        assert.equal(d.metadata.exposure, 'opt-in');
        assert.equal(d.metadata.certificationRequirement, 'patch');
        assert.deepEqual([...d.metadata.allowedPhases], ['coding']);
        assert.equal(d.metadata.executionMode, 'sequential');
      }
      const preview = descriptors.find((d) => d.metadata.name === 'ast_transform_preview')!;
      const apply = descriptors.find((d) => d.metadata.name === 'ast_transform_apply')!;
      assert.equal(preview.metadata.class, 'read-only');
      assert.equal(apply.metadata.class, 'mutation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declares only the preview path field for policy enforcement', () => {
    assert.deepEqual(AST_TRANSFORM_PATH_FIELDS, { ast_transform_preview: ['path'] });
  });
});

// ---------------------------------------------------------------------------
// Preview: zero-write, exact ranges, digest
// ---------------------------------------------------------------------------

describe('ast_transform_preview', () => {
  it('performs zero writes and records exact ranges, revisions, and digest', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const before = readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
      const mtimeBefore = statSync(path.join(dir, 'src/app.ts')).mtimeMs;

      const { preview } = toolsFor(dir);
      const details = await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      });
      const p = expectPreviewOk(details);

      // No writes.
      assert.equal(readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), before);
      assert.equal(statSync(path.join(dir, 'src/app.ts')).mtimeMs, mtimeBefore);

      assert.equal(p.version, AST_TRANSFORM_CONTRACT_VERSION);
      assert.equal(p.transform, 'rename_symbol');
      assert.equal(p.symbol, 'calculateTotal');
      assert.equal(p.replacement, 'sumValues');
      assert.equal(p.language, 'typescript');
      assert.equal(p.engine, 'typescript');
      assert.ok(p.matchCount >= 3, 'definition + 2 call sites');
      // Exact ranges bound to real source text.
      for (const m of p.matches) {
        assert.equal(m.oldText, 'calculateTotal');
        assert.equal(m.newText, 'sumValues');
        assert.ok(m.startLine >= 1 && m.startColumn >= 1);
      }
      // Source revision is captured for the one touched file.
      assert.equal(p.sourceRevisions.length, 1);
      assert.equal(p.sourceRevisions[0]!.path, 'src/app.ts');
      assert.match(p.sourceRevisions[0]!.digest, /^[0-9a-f]{64}$/);
      // Patch is edit-diff (line-scoped, never whole-file).
      assert.equal(p.patch.operations.length, 1);
      assert.equal(p.patch.operations[0]!.op, 'edit-diff');
      assert.match(p.patchDigest, /^[0-9a-f]{64}$/);
      assert.match(p.previewDigest, /^[0-9a-f]{64}$/);
      assert.equal(p.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects zero matches, invalid params, and identical replacement', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview } = toolsFor(dir);
      assert.equal(
        (await runPreview(preview, { transform: 'rename_symbol', symbol: 'doesNotExist', replacement: 'x' }) as AstTransformErrorDetails).error,
        'no_matches',
      );
      assert.equal(
        expectError(await runPreview(preview, { transform: 'bogus', symbol: 'a', replacement: 'b' })).error,
        'unsupported_transform',
      );
      assert.equal(
        expectError(await runPreview(preview, { transform: 'rename_symbol', symbol: 'calculateTotal', replacement: 'calculateTotal' })).error,
        'invalid_params',
      );
      assert.equal(
        expectError(await runPreview(preview, { transform: 'rename_symbol', symbol: 'calculateTotal', replacement: 'not an identifier' })).error,
        'invalid_params',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on unsupported language', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview } = toolsFor(dir);
      const err = expectError(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
        language: 'python',
      }));
      assert.equal(err.error, 'unsupported_language');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies out-of-worktree and traversal path scopes', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview } = toolsFor(dir);
      const err = expectError(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
        path: '../outside.ts',
      }));
      assert.equal(err.error, 'path_denied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous symbols with multiple definitions and disambiguates with a scope', async () => {
    const dir = makeWorktree({
      'src/a.ts': 'export function handler(): number { return 1; }\nexport const ra = handler();\n',
      'src/b.ts': 'export function handler(): number { return 2; }\nexport const rb = handler();\n',
    });
    try {
      const { preview } = toolsFor(dir);
      const ambiguous = expectError(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'handler',
        replacement: 'process',
      }));
      assert.equal(ambiguous.error, 'ambiguous_symbol');

      // Narrowing with a path scope resolves to a single definition.
      const scoped = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'handler',
        replacement: 'process',
        path: 'src/a.ts',
      }));
      assert.equal(scoped.sourceRevisions.length, 1);
      assert.equal(scoped.sourceRevisions[0]!.path, 'src/a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the recorded match set at maxMatches while keeping the patch complete', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => `export const r${i} = calculateTotal(${i}, ${i});`).join('\n');
    const dir = makeWorktree({ 'src/app.ts': `${SINGLE_FILE['src/app.ts']}\n${refs}\n` });
    try {
      const { preview } = toolsFor(dir, { config: makeConfig({ limits: { ...makeConfig().limits, maxMatches: 2 } }) });
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));
      assert.equal(p.matches.length, 2);
      assert.equal(p.truncated, true);
      assert.ok(p.matchCount > 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Apply: happy path, atomicity, drift, tamper, phase
// ---------------------------------------------------------------------------

describe('ast_transform_apply', () => {
  it('requires a preview and rejects an obviously invalid one', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { apply } = toolsFor(dir);
      assert.equal(expectError(await runApply(apply, undefined)).error, 'preview_required');
      assert.equal(expectError(await runApply(apply, { version: 1 })).error, 'invalid_preview');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a single-file rename atomically and produces patch evidence', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { recorder, mutations, snapshots } = collectRecorder();
      const { preview, apply } = toolsFor(dir, { recorder });
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));
      const applied = expectApplyOk(await runApply(apply, p));
      assert.equal(applied.result.atomic, true);
      assert.deepEqual(applied.result.changedFiles, ['src/app.ts']);

      const after = readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
      assert.ok(!after.includes('calculateTotal'));
      assert.ok(after.includes('function sumValues'));
      assert.ok(after.includes('sumValues(1, 2)'));
      assert.ok(after.includes('sumValues(3, 4)'));

      // Recorder wiring mirrors apply_patch.
      assert.ok(mutations.some((m) => m.tool === 'ast_transform_apply' && m.status === 'completed' && m.path === 'src/app.ts'));
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]![0]!.path, 'src/app.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a multi-file rename as one atomic patch', async () => {
    const dir = makeWorktree({
      'src/util.ts': 'export function shared(): number { return 1; }\n',
      'src/consumer.ts': "import { shared } from './util.ts';\nexport const v = shared();\n",
    });
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'shared',
        replacement: 'common',
      }));
      assert.equal(p.sourceRevisions.length, 2);
      assert.equal(p.patch.operations.length, 2);

      const applied = expectApplyOk(await runApply(apply, p));
      assert.deepEqual(applied.result.changedFiles, ['src/consumer.ts', 'src/util.ts']);
      assert.ok(readFileSync(path.join(dir, 'src/util.ts'), 'utf8').includes('function common'));
      assert.ok(readFileSync(path.join(dir, 'src/consumer.ts'), 'utf8').includes('common()'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports rewrite_symbol with arbitrary replacement text', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rewrite_symbol',
        symbol: 'calculateTotal',
        replacement: 'math.sum',
      }));
      const applied = expectApplyOk(await runApply(apply, p));
      assert.deepEqual(applied.result.changedFiles, ['src/app.ts']);
      assert.ok(readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('math.sum(1, 2)'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects source drift (including whitespace-only edits) and leaves the tree unchanged', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));

      // Whitespace-only change to the target after preview.
      const original = readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
      writeFileSync(path.join(dir, 'src/app.ts'), `${original}\n`, 'utf8');
      const drifted = `${original}\n`;

      const err = expectError(await runApply(apply, p));
      assert.equal(err.error, 'source_drift');
      // Tree unchanged by the rejected apply.
      assert.equal(readFileSync(path.join(dir, 'src/app.ts'), 'utf8'), drifted);
      assert.ok(!readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('sumValues'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects index drift when an unrelated indexed file appears', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));

      // Add a new TS file: target content is untouched, but the index revision changes.
      writeFileSync(path.join(dir, 'src/new.ts'), 'export const brandNew = 1;\n', 'utf8');

      const err = expectError(await runApply(apply, p));
      assert.equal(err.error, 'index_drift');
      assert.ok(!readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('sumValues'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a tampered preview digest and a mismatched patch digest without touching files', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));

      // Tamper the replacement without recomputing the digest → preview_tampered.
      const tampered = JSON.parse(JSON.stringify(p)) as AstTransformPreview;
      tampered.replacement = 'evilName';
      assert.equal(expectError(await runApply(apply, tampered)).error, 'preview_tampered');

      // Tamper only the patchDigest but keep previewDigest consistent → patch_digest_mismatch.
      const badPatchDigest = JSON.parse(JSON.stringify(p)) as AstTransformPreview;
      badPatchDigest.patchDigest = 'f'.repeat(64);
      // computePreviewDigest is over all fields incl. patchDigest, so recompute a
      // consistent seal for the tampered value via the exported helper.
      const { computePreviewDigest } = await import('./ast-transform.ts');
      const { previewDigest: _drop, ...rest } = badPatchDigest;
      badPatchDigest.previewDigest = computePreviewDigest(rest);
      assert.equal(expectError(await runApply(apply, badPatchDigest)).error, 'patch_digest_mismatch');

      assert.ok(!readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('sumValues'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a version mismatch', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));
      const bumped = JSON.parse(JSON.stringify(p)) as AstTransformPreview & { version: number };
      bumped.version = 999;
      const err = expectError(await runApply(apply, bumped));
      assert.equal(err.error, 'version_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to apply outside the coding phase', async () => {
    const dir = makeWorktree(SINGLE_FILE);
    try {
      const { preview } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'calculateTotal',
        replacement: 'sumValues',
      }));
      for (const phase of ['planning', 'review'] as ToolPhase[]) {
        const { apply } = toolsFor(dir, { phase });
        const err = expectError(await runApply(apply, p));
        assert.equal(err.error, 'phase_denied');
      }
      assert.ok(!readFileSync(path.join(dir, 'src/app.ts'), 'utf8').includes('sumValues'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves every file untouched when one file in a multi-file transform drifts', async () => {
    const dir = makeWorktree({
      'src/util.ts': 'export function shared(): number { return 1; }\n',
      'src/consumer.ts': "import { shared } from './util.ts';\nexport const v = shared();\n",
    });
    try {
      const { preview, apply } = toolsFor(dir);
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'shared',
        replacement: 'common',
      }));
      const consumerBefore = readFileSync(path.join(dir, 'src/consumer.ts'), 'utf8');
      const utilBefore = readFileSync(path.join(dir, 'src/util.ts'), 'utf8');

      // Drift only consumer.ts.
      writeFileSync(path.join(dir, 'src/consumer.ts'), `${consumerBefore}// touched\n`, 'utf8');

      const err = expectError(await runApply(apply, p));
      assert.equal(err.error, 'source_drift');
      // util.ts (the untouched target) must not have been modified.
      assert.equal(readFileSync(path.join(dir, 'src/util.ts'), 'utf8'), utilBefore);
      assert.ok(!readFileSync(path.join(dir, 'src/util.ts'), 'utf8').includes('common'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Formatter interaction
// ---------------------------------------------------------------------------

describe('ast_transform formatter interaction', () => {
  it('folds formatter output into the same atomic patch', async () => {
    const dir = makeWorktree({
      'src/app.ts': 'export function foo(): number { return 1; }\nexport const bar = foo();\n',
    });
    try {
      // Formatter that appends a normalized trailing marker comment — a
      // deterministic change beyond the raw rename.
      const formatter = (text: string) => `${text}// formatted\n`;
      const { preview, apply } = toolsFor(dir, { formatter, formatterName: 'test-formatter' });
      const p = expectPreviewOk(await runPreview(preview, {
        transform: 'rename_symbol',
        symbol: 'foo',
        replacement: 'baz',
      }));
      assert.equal(p.formatter.applied, true);
      assert.equal(p.formatter.formatter, 'test-formatter');

      const applied = expectApplyOk(await runApply(apply, p));
      assert.deepEqual(applied.result.changedFiles, ['src/app.ts']);
      const after = readFileSync(path.join(dir, 'src/app.ts'), 'utf8');
      // Both the rename and the formatter change landed in one patch application.
      assert.ok(after.includes('function baz(): number'));
      assert.ok(after.includes('const bar = baz();'));
      assert.ok(after.endsWith('// formatted\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('ast_transform redaction', () => {
  it('redacts secrets from the preview content', async () => {
    const dir = makeWorktree({
      'src/app.ts': [
        'const AWS_SECRET = "AKIAIOSFODNN7EXAMPLE";',
        'export function loader() { return AWS_SECRET; }',
        'export const used = loader();',
      ].join('\n') + '\n',
    });
    try {
      const { preview } = toolsFor(dir);
      const result = await preview.execute('call', {
        transform: 'rename_symbol',
        symbol: 'loader',
        replacement: 'reader',
      });
      assert.ok(!result.content[0]!.text.includes('AKIAIOSFODNN7EXAMPLE'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// after-tool-call hook
// ---------------------------------------------------------------------------

describe('astTransformAfterToolCall', () => {
  it('marks failed transforms as errors and passes successes through', async () => {
    assert.equal(await astTransformAfterToolCall({ toolCall: { name: 'other' }, result: { details: { ok: false } } }), undefined);
    assert.deepEqual(
      await astTransformAfterToolCall({ toolCall: { name: 'ast_transform_apply' }, result: { details: { ok: false } } }),
      { isError: true },
    );
    assert.equal(
      await astTransformAfterToolCall({ toolCall: { name: 'ast_transform_preview' }, result: { details: { ok: true } } }),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// buildUnifiedDiff unit behavior
// ---------------------------------------------------------------------------

describe('buildUnifiedDiff', () => {
  it('returns null for identical text and one hunk per changed run', () => {
    assert.equal(buildUnifiedDiff('a\nb\nc\n', 'a\nb\nc\n'), null);
    const diff = buildUnifiedDiff('a\nb\nc\n', 'a\nX\nc\n');
    assert.ok(diff);
    assert.match(diff!, /^@@ -2,1 \+2,1 @@\n-b\n\+X$/);
  });

  it('emits a full-range hunk when line counts differ', () => {
    const diff = buildUnifiedDiff('a\nb', 'a\nb\nc');
    assert.ok(diff);
    assert.match(diff!, /^@@ -1,2 \+1,3 @@/);
  });
});
