import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const toolPath = path.join(repoRoot, 'tools', 'check-ci-verification.ts');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'check-ci-verification-'));
  tempDirs.push(repoDir);
  return repoDir;
}

function runTool(repoDir: string, args: string[]) {
  const env = { ...process.env };
  delete env.npm_config_verify_deps_before_run;
  delete env.npm_config__jsr_registry;
  delete env.npm_config_prefix;

  return spawnSync(process.execPath, [toolPath, '--repo', repoDir, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env,
  });
}

function writeWorkflow(repoDir: string, content: string) {
  const workflowDir = path.join(repoDir, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, 'ci.yml'), content);
}

function writeConfig(repoDir: string, prePrVerification: Record<string, unknown>) {
  writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({ prePrVerification }));
}

function baseExplicitConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    source: 'explicit',
    requiredChecks: ['Unit Tests', 'Custom Harness Tests'],
    recipe: {
      commands: ['npm run test:unit', 'npm run test:custom'],
    },
    mappingAcknowledgements: {
      checks: {
        'Unit Tests': 'npm run test:unit',
        'Custom Harness Tests': 'npm run test:custom',
      },
    },
    driftValidation: {
      enabled: true,
      blockOnUnmapped: true,
      warnOnDrift: true,
    },
    ...overrides,
  };
}

describe('check-ci-verification tool', () => {
  it('passes with explicit checks, mapped recipe commands, and covered workflow jobs', () => {
    const repoDir = makeRepo();
    writeConfig(repoDir, baseExplicitConfig());
    writeWorkflow(repoDir, `
name: CI
on: pull_request
jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:unit
  custom:
    name: Custom Harness Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:custom
`);

    const result = runTool(repoDir, ['--json']);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.report.githubChecks.length, 2);
    assert.equal(parsed.report.localRecipe.length, 2);
  });

  it('fails when a workflow job is missing from explicit verification config', () => {
    const repoDir = makeRepo();
    writeConfig(repoDir, baseExplicitConfig());
    writeWorkflow(repoDir, `
name: CI
on: pull_request
jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:unit
  custom:
    name: Custom Harness Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:custom
  new-job:
    name: New Job Nobody Mapped
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:new
`);

    const result = runTool(repoDir, ['--json']);

    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.passed, false);
    assert.ok(parsed.report.findings.some((finding: { type: string; checkName: string }) => (
      finding.type === 'workflow-uncovered' &&
      finding.checkName === 'New Job Nobody Mapped'
    )));
  });

  it('fails when a mapped local command is removed from the recipe', () => {
    const repoDir = makeRepo();
    writeConfig(repoDir, baseExplicitConfig({
      recipe: {
        commands: ['npm run test:unit'],
      },
    }));
    writeWorkflow(repoDir, `
name: CI
on: pull_request
jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:unit
  custom:
    name: Custom Harness Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:custom
`);

    const result = runTool(repoDir, ['--json']);

    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.report.findings.some((finding: { type: string; checkName: string }) => (
      finding.type === 'recipe-missing' &&
      finding.checkName === 'Custom Harness Tests'
    )));
  });

  it('does not flag workflow jobs listed in nonEnforcedJobs', () => {
    const repoDir = makeRepo();
    writeConfig(repoDir, baseExplicitConfig({
      nonEnforcedJobs: ['Shell and Unit Tests'],
    }));
    writeWorkflow(repoDir, `
name: CI
on: pull_request
jobs:
  unit:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:unit
  custom:
    name: Custom Harness Tests
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:custom
  aggregate:
    name: Shell and Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);

    const result = runTool(repoDir, ['--json']);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(!parsed.report.findings.some((finding: { type: string }) => (
      finding.type === 'workflow-uncovered'
    )));
  });

  it('prints actionable unmapped check diagnostics from fixture metadata', () => {
    const repoDir = makeRepo();
    writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: ['Lint Check'],
        recipe: {
          commands: ['npm run lint'],
        },
      },
    }));
    writeFileSync(path.join(repoDir, 'discovery.json'), JSON.stringify({
      checks: ['Lint Check', 'Security Scan'],
      source: 'ruleset',
      timestamp: '2026-08-04T12:00:00Z',
      workflows: [
        {
          name: 'Lint Check',
          path: '.github/workflows/ci.yml',
          triggers: ['pull_request'],
        },
      ],
    }));

    const result = runTool(repoDir, ['--discovery-fixture', 'discovery.json', '--propose-mapping']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Verification Contract Drift Report/);
    assert.match(result.stdout, /Security Scan: unmapped-check/);
    assert.match(result.stdout, /Action required/);
    assert.match(result.stdout, /"Lint Check": "npm run lint"/);
  });

  it('returns JSON with metadata-unavailable finding for permission fixtures', () => {
    const repoDir = makeRepo();
    writeFileSync(path.join(repoDir, '.wavemill-config.json'), JSON.stringify({
      prePrVerification: {
        enabled: true,
        source: 'github-enforced',
        requiredChecks: ['Lint Check'],
        recipe: {
          commands: ['npm run lint'],
        },
      },
    }));
    writeFileSync(path.join(repoDir, 'permission.json'), JSON.stringify({
      error: 'GitHub API permission denied',
    }));

    const result = runTool(repoDir, ['--discovery-fixture', 'permission.json', '--json']);

    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.passed, false);
    assert.equal(parsed.report.findings[0].type, 'metadata-unavailable');
  });
});
