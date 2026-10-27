import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { COST_OWNERSHIP_GUARD } from './cost-ownership-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(COST_OWNERSHIP_GUARD, file, source).map((finding) => finding.pattern);

describe('cost-ownership guard — forbidden shapes', () => {
  it('flags the retired legacy engine wherever it reappears', () => {
    for (const name of [
      'computeWorkflowCost',
      'computeWorkflowCostWithExactPricing',
      'recalculateWorkflowCost',
      'computeNativeWorkflowCost',
      'resolveAuthoritativeWorkflowCost',
    ]) {
      assert.deepEqual(patternsOf('shared/lib/a.ts', `const outcome = ${name}(opts);\n`), ['retired-cost-engine'], name);
    }
    assert.deepEqual(
      patternsOf('shared/lib/a.ts', "import { computeWorkflowCost } from './cost-engine.ts';\n"),
      ['retired-cost-engine'],
    );
  });

  it('flags the retired cost-metering switches in TS and shell', () => {
    assert.deepEqual(patternsOf('a.ts', "if (process.env.WAVEMILL_COST_METERING_LEGACY === '1') legacy();\n"), ['retired-cost-switch']);
    assert.deepEqual(patternsOf('a.ts', "const shadow = env.WAVEMILL_SDK_COST_METERING_SHADOW;\n"), ['retired-cost-switch']);
    assert.deepEqual(patternsOf('a.sh', 'export WAVEMILL_DISABLE_OPENROUTER_COST=1\n'), ['retired-cost-switch']);
  });

  it('flags a private per-token price formula', () => {
    assert.deepEqual(
      patternsOf('a.ts', 'const cost = (usage.inputTokens * pricing.inputCostPerMTok) / 1_000_000;\n'),
      ['per-token-arithmetic'],
    );
    assert.deepEqual(
      patternsOf('a.ts', 'const cost = tokens / 1000000 * rates.outputCostPerMTok;\n'),
      ['per-token-arithmetic'],
    );
  });

  it('flags primitive imports (static, multi-line tail, and dynamic)', () => {
    assert.deepEqual(patternsOf('a.ts', "import { computeModelCost } from './pricing/model-pricing.ts';\n"), ['pricing-primitive-import']);
    assert.deepEqual(patternsOf('a.ts', "  type PricingTable,\n} from '../shared/lib/pricing/model-pricing.ts';\n"), ['pricing-primitive-import']);
    assert.deepEqual(patternsOf('a.ts', "const m = await import('../pricing/model-pricing.ts');\n"), ['pricing-primitive-import']);
    assert.deepEqual(patternsOf('a.ts', "import { resolveProjectsDirs } from './wavemill-session-paths.ts';\n"), ['session-path-import']);
    assert.deepEqual(
      patternsOf('a.ts', "import { fetchGenerationCostsBatched } from './openrouter-generation-api.ts';\n"),
      ['openrouter-generation-import'],
    );
  });
});

describe('cost-ownership guard — clean shapes', () => {
  it('allows the SDK bridge surface and the persisted record shape', () => {
    const source = [
      "import { meterWorkflowCost } from './sdk-task-cost/meter.ts';",
      "import { recomputeRecordWorkflowCost } from './sdk-task-cost/recompute.ts';",
      "import { reportableWorkflowCostUsd, type WorkflowCostOutcome } from './workflow-cost.ts';",
      "const usd = reportableWorkflowCostUsd(outcome);",
      // allow-template-curly: source text under test, a display label (not arithmetic)
      "const label = `$${pricing.inputCostPerMTok}/MTok`;",
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('shared/lib/a.ts', source), []);
  });

  it('skips whole-line comments and honours the allow-cost-ownership suppression', () => {
    assert.deepEqual(patternsOf('a.ts', '// computeWorkflowCost was retired in HOK-3077\n'), []);
    assert.deepEqual(patternsOf('a.ts', ' * WAVEMILL_COST_METERING_LEGACY is gone\n'), []);
    assert.deepEqual(
      patternsOf('a.ts', "import { computeModelCost } from './pricing/model-pricing.ts'; // allow-cost-ownership: test seam\n"),
      [],
    );
  });

  it('never scans the primitives themselves', () => {
    for (const invariant of COST_OWNERSHIP_GUARD.invariantPaths) {
      assert.ok(invariant.startsWith('shared/lib/'), invariant);
    }
    assert.ok(COST_OWNERSHIP_GUARD.invariantPaths.includes('shared/lib/pricing/model-pricing.ts'));
  });
});

describe('cost-ownership guard — allowlist semantics', () => {
  function withRepo(files: Record<string, string>, allowlist: string, fn: (repo: string) => void): void {
    const repo = mkdtempSync(join(tmpdir(), 'cost-ownership-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      for (const [file, contents] of Object.entries({ ...files, [COST_OWNERSHIP_GUARD.allowlistFile]: allowlist })) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), contents);
      }
      execFileSync('git', ['add', '-A'], { cwd: repo });
      fn(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
  const importLine = "import { computeModelCost } from './pricing/model-pricing.ts';\n";

  it('fails an unlisted primitive consumer and passes a listed one', () => {
    withRepo({ 'shared/lib/router.ts': importLine }, '', (repo) => {
      const result = runSourceGuard(COST_OWNERSHIP_GUARD, repo);
      assert.deepEqual(result.findings.map((finding) => finding.pattern), ['pricing-primitive-import']);
    });
    withRepo({ 'shared/lib/router.ts': importLine }, 'shared/lib/router.ts 1  # pricing_policy: test\n', (repo) => {
      assert.equal(runSourceGuard(COST_OWNERSHIP_GUARD, repo).ok, true);
    });
  });

  it('a listed file that also reintroduces the engine exceeds its count', () => {
    withRepo(
      { 'shared/lib/router.ts': `${importLine}const outcome = computeWorkflowCost(opts);\n` },
      'shared/lib/router.ts 1  # pricing_policy: test\n',
      (repo) => {
        const patterns = runSourceGuard(COST_OWNERSHIP_GUARD, repo).findings.map((finding) => finding.pattern);
        assert.ok(patterns.includes('allowlist-count-exceeded'));
        assert.ok(patterns.includes('retired-cost-engine'));
      },
    );
  });

  it('ratchets: an entry that no longer imports a primitive is stale', () => {
    withRepo({ 'shared/lib/router.ts': 'export const x = 1;\n' }, 'shared/lib/router.ts 1  # pricing_policy: test\n', (repo) => {
      const result = runSourceGuard(COST_OWNERSHIP_GUARD, repo);
      assert.deepEqual(result.findings.map((finding) => finding.pattern), ['allowlist-stale']);
    });
  });
});

describe('cost-ownership guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(COST_OWNERSHIP_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(COST_OWNERSHIP_GUARD, result));
  });
});
