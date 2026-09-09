import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkOpenRouterAliasAuditCi,
  formatOpenRouterAliasAuditCi,
} from './check-openrouter-alias-audit-ci.ts';

async function withRepo(workflow: string, fn: (repoDir: string) => void): Promise<void> {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'openrouter-alias-audit-ci-'));
  try {
    mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(repoDir, '.github', 'workflows', 'ci.yml'), workflow);
    fn(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
}

const COMPLIANT_WORKFLOW = `name: CI

on:
  pull_request:
  push:
    branches: [main, auto/integration]
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * *'

jobs:
  openrouter-alias-audit:
    name: OpenRouter Alias Audit
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: check-paths
    if: always()
    env:
      RUN_OPENROUTER_ALIAS_AUDIT: \${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || needs.check-paths.outputs.openrouter_alias_audit == 'true' }}

    steps:
      - name: Fail if change detection did not succeed
        if: (github.event_name == 'pull_request' || github.event_name == 'push') && needs.check-paths.result != 'success'
        run: exit 1

      - name: Report skip
        if: env.RUN_OPENROUTER_ALIAS_AUDIT != 'true'
        run: echo skip

      - name: Audit OpenRouter aliases
        if: env.RUN_OPENROUTER_ALIAS_AUDIT == 'true'
        run: npx tsx tools/audit-openrouter-aliases.ts --json --no-write

  check-paths:
    name: Check Lifecycle Paths
    runs-on: ubuntu-latest
    outputs:
      lifecycle: \${{ steps.filter.outputs.lifecycle == 'true' }}
      openrouter_alias_audit: \${{ steps.filter.outputs.openrouter_alias_audit == 'true' }}

    steps:
      - name: Detect lifecycle-relevant changes
        id: filter
        uses: dorny/paths-filter@6852f92c20ea7fd3b0c25de3b5112db3a98da050 # v3
        with:
          filters: |
            lifecycle:
              - 'shared/lib/wavemill-mill.sh'
            openrouter_alias_audit:
              - 'shared/fixtures/model-registry.v1.json'
              - 'shared/lib/disabled-models.ts'
              - 'tools/audit-openrouter-aliases.ts'
              - 'tools/check-openrouter-alias-audit-ci.ts'
              - 'tools/check-openrouter-alias-audit-ci.test.ts'
              - '.github/workflows/ci.yml'
`;

test('the real repository ci.yml satisfies the OpenRouter alias audit visibility contract', () => {
  const result = checkOpenRouterAliasAuditCi();

  assert.equal(result.ok, true, formatOpenRouterAliasAuditCi(result));
  assert.deepEqual(result.problems, []);
});

test('a compliant fixture workflow passes', async () => {
  await withRepo(COMPLIANT_WORKFLOW, (repoDir) => {
    const result = checkOpenRouterAliasAuditCi(repoDir);

    assert.equal(result.ok, true, formatOpenRouterAliasAuditCi(result));
  });
});

test('fails when the audit job is still gated to schedule and manual dispatch only', async () => {
  const workflow = COMPLIANT_WORKFLOW.replace(
    'if: always()',
    "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
  );

  await withRepo(workflow, (repoDir) => {
    const result = checkOpenRouterAliasAuditCi(repoDir);
    const message = formatOpenRouterAliasAuditCi(result);

    assert.equal(result.ok, false);
    assert.match(message, /not step-gated/);
    assert.match(message, /PR checks may be skipped/);
  });
});

test('fails when registry-adjacent path filters are missing', async () => {
  const workflow = COMPLIANT_WORKFLOW.replace(
    "              - 'shared/fixtures/model-registry.v1.json'\n              - 'shared/lib/disabled-models.ts'\n",
    '',
  );

  await withRepo(workflow, (repoDir) => {
    const result = checkOpenRouterAliasAuditCi(repoDir);
    const message = formatOpenRouterAliasAuditCi(result);

    assert.equal(result.ok, false);
    assert.match(message, /model-registry\.v1\.json/);
    assert.match(message, /disabled-models\.ts/);
  });
});

test('fails when the live audit step is not gated by relevance', async () => {
  const workflow = COMPLIANT_WORKFLOW.replace(
    "        if: env.RUN_OPENROUTER_ALIAS_AUDIT == 'true'\n        run: npx tsx tools/audit-openrouter-aliases.ts --json --no-write",
    '        run: npx tsx tools/audit-openrouter-aliases.ts --json --no-write',
  );

  await withRepo(workflow, (repoDir) => {
    const result = checkOpenRouterAliasAuditCi(repoDir);
    const message = formatOpenRouterAliasAuditCi(result);

    assert.equal(result.ok, false);
    assert.match(message, /live OpenRouter alias audit step is not gated/);
  });
});

test('fails when path detection failures are allowed to go green', async () => {
  const workflow = COMPLIANT_WORKFLOW.replace(
    "        if: (github.event_name == 'pull_request' || github.event_name == 'push') && needs.check-paths.result != 'success'",
    "        if: github.event_name == 'schedule'",
  );

  await withRepo(workflow, (repoDir) => {
    const result = checkOpenRouterAliasAuditCi(repoDir);
    const message = formatOpenRouterAliasAuditCi(result);

    assert.equal(result.ok, false);
    assert.match(message, /fail closed/);
  });
});
