import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkGuardSource, formatGuardResult, runSourceGuard } from '../../tools/lib/source-guard.ts';
import { PROVIDER_IDENTITY_GUARD } from './provider-identity-guard.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const patternsOf = (file: string, source: string) =>
  checkGuardSource(PROVIDER_IDENTITY_GUARD, file, source).map((finding) => finding.pattern);

describe('provider-identity guard — forbidden shapes', () => {
  it('flags executedModel taken from a requested model in TS', () => {
    assert.deepEqual(patternsOf('a.ts', '  executedModel: input.model,\n'), ['executed-model-from-request']);
    assert.deepEqual(patternsOf('a.ts', 'const executedModel = options.requestedModel;\n'), ['executed-model-from-request']);
    assert.deepEqual(patternsOf('a.ts', 'result.executedModel = route?.intendedModel;\n'), ['executed-model-from-request']);
    assert.deepEqual(patternsOf('a.ts', '{ executedModel: wireModel }\n'), ['executed-model-from-request']);
  });

  it('flags the requested model passed as executedModel in shell/jq', () => {
    assert.deepEqual(patternsOf('a.sh', '  --arg executedModel "$model" \\\n'), ['sh-executed-model-from-request']);
    assert.deepEqual(patternsOf('a.sh', '  --arg executedModel "$requested_model" \\\n'), ['sh-executed-model-from-request']);
    assert.deepEqual(patternsOf('a.sh', "  '{ executedModel: $model }'\n"), ['sh-executed-model-from-request']);
  });
});

describe('provider-identity guard — clean shapes', () => {
  it('ignores provider-reported and resolver-forwarded values, types, and nulls', () => {
    const source = [
      '  executedModel: string | null;',
      '  executedModel: attribution.executedModel,',
      '  executedModel: summary.executedModel ?? summary.providerReportedModel,',
      '  executedModel: err.reportedModel,',
      '  executedModel: null,',
      '  executedModel: resolveModel(),',
      "  if (result.executedModel === input.model) {}",
      '',
    ].join('\n');
    assert.deepEqual(patternsOf('a.ts', source), []);
    assert.deepEqual(patternsOf('a.sh', '  --arg executedModel "$resolved_executed_model" \\\n'), []);
  });

  it('honours the allow-provider-identity suppression', () => {
    assert.deepEqual(patternsOf('a.ts', '// allow-provider-identity: scripted fallback\nconst executedModel = input.model;\n'), []);
  });
});

describe('provider-identity guard — repository', () => {
  it('passes at HEAD', () => {
    const result = runSourceGuard(PROVIDER_IDENTITY_GUARD, repoRoot);
    assert.deepEqual(result.findings, [], formatGuardResult(PROVIDER_IDENTITY_GUARD, result));
  });
});
