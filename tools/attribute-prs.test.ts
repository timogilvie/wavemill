import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { Fetcher } from '../shared/lib/merged-pr-fetcher.ts';
import { PR_ATTRIBUTION_SCHEMA_VERSION } from '../shared/lib/pr-attribution.ts';
import { runAttributePrsCommand, type AttributePrsReport } from './attribute-prs.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'attribute-prs-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FixturePr {
  number: number;
  authorLogin?: string;
  authorType?: string;
  headRef?: string;
  headSha?: string;
  labels?: string[];
  body?: string;
  commitMessages?: string[];
}

/**
 * Injectable fetcher serving canned GitHub REST responses for any number of
 * repositories, so CLI runs never touch the network.
 */
function makeFetcher(reposToPrs: Record<string, FixturePr[]>): Fetcher {
  return {
    async gh(args: string[]): Promise<string> {
      if (args[0] === 'auth') {
        return 'Logged in';
      }
      const endpoint = args[1] ?? '';
      const commitsMatch = endpoint.match(/^repos\/(.+)\/pulls\/(\d+)\/commits$/);
      if (commitsMatch) {
        const prs = reposToPrs[commitsMatch[1]] ?? [];
        const pr = prs.find((entry) => entry.number === Number(commitsMatch[2]));
        const messages = pr?.commitMessages ?? ['Default commit'];
        return JSON.stringify(messages.map((message) => ({ commit: { message } })));
      }
      const pullsMatch = endpoint.match(/^repos\/(.+)\/pulls$/);
      if (pullsMatch) {
        // Single-page fixtures: only page 1 carries data.
        const isFirstPage = args.some((arg) => arg === 'page=1');
        const prs = isFirstPage ? (reposToPrs[pullsMatch[1]] ?? []) : [];
        return JSON.stringify(
          prs.map((pr) => ({
            number: pr.number,
            user: { login: pr.authorLogin ?? 'octocat', type: pr.authorType ?? 'User' },
            head: { ref: pr.headRef ?? 'feature/change', sha: pr.headSha ?? 'aaa111' },
            labels: (pr.labels ?? []).map((name) => ({ name })),
            merged_at: '2026-09-01T00:00:00Z',
            body: pr.body ?? null,
          })),
        );
      }
      throw new Error(`Unexpected gh invocation: gh ${args.join(' ')}`);
    },
  };
}

function copilotPrs(count: number, startAt = 1): FixturePr[] {
  return Array.from({ length: count }, (_, i) => ({
    number: startAt + i,
    authorLogin: 'copilot-swe-agent[bot]',
    authorType: 'Bot',
    headRef: `copilot/change-${startAt + i}`,
  }));
}

function unattributedPrs(count: number, startAt = 100): FixturePr[] {
  return Array.from({ length: count }, (_, i) => ({ number: startAt + i }));
}

const FIXED_NOW = () => new Date('2026-09-06T12:00:00Z');

describe('attribute-prs command', () => {
  let logLines: string[] = [];

  before(() => {
    mock.method(console, 'log', (...parts: unknown[]) => {
      logLines.push(parts.join(' '));
    });
  });

  afterEach(() => {
    logLines = [];
  });

  function readReport(path: string): AttributePrsReport {
    return JSON.parse(readFileSync(path, 'utf-8')) as AttributePrsReport;
  }

  it('produces a stable versioned JSON report end-to-end via an injected fetcher', async () => {
    const dir = makeTempDir();
    const output = join(dir, 'report.json');
    const fetcher = makeFetcher({
      'acme/widgets': [...copilotPrs(15), ...unattributedPrs(10)],
    });

    const code = await runAttributePrsCommand(
      { repo: ['acme/widgets'], limit: '50', output, 'audit-seed': '1' },
      fetcher,
      FIXED_NOW,
    );
    assert.equal(code, 0);

    const report = readReport(output);
    assert.equal(report.schemaVersion, PR_ATTRIBUTION_SCHEMA_VERSION);
    assert.equal(report.generatedAt, '2026-09-06T12:00:00.000Z');
    assert.equal(report.repositories.length, 1);

    const repo = report.repositories[0];
    assert.equal(repo.repo, 'acme/widgets');
    assert.equal(repo.sampledMergedPrs, 25);
    assert.equal(repo.eligibleForFeasibilityGate, true);
    // Score-all rule: every sampled PR carries a record, attributed or not.
    assert.equal(repo.pullRequests.length, 25);
    assert.equal(repo.unattributedCount, 10);
    assert.equal(repo.dimensions.agent.coveragePercent, 60);
    assert.equal(repo.dimensions.harness.coveragePercent, 60);
    assert.equal(repo.dimensions.model.coveragePercent, 0);
    // Harness at the floor renders; exact-model at 0% suppresses with a reason.
    assert.equal(report.gates.survivalByHarness.render, true);
    assert.equal(report.gates.survivalByModel.render, false);
    assert.match(report.gates.survivalByModel.reason ?? '', /below the 60% floor/);
    // The human rendering surfaces both gate verdicts.
    const humanOutput = logLines.join('\n');
    assert.match(humanOutput, /survival-by-harness: RENDER/);
    assert.match(humanOutput, /survival-by-model: SUPPRESS/);
  });

  it('exits 0 for a 0%-coverage repo: low coverage is a result, not an error', async () => {
    const dir = makeTempDir();
    const output = join(dir, 'report.json');
    const fetcher = makeFetcher({ 'acme/quiet': unattributedPrs(5) });

    const code = await runAttributePrsCommand(
      { repo: ['acme/quiet'], limit: '50', output, 'audit-seed': '1' },
      fetcher,
      FIXED_NOW,
    );
    assert.equal(code, 0);

    const report = readReport(output);
    assert.equal(report.repositories[0].unionCoveragePercent, 0);
    assert.equal(report.repositories[0].eligibleForFeasibilityGate, false);
    assert.equal(report.gates.survivalByModel.render, false);
  });

  it('aggregates macro and micro coverage across multiple repos', async () => {
    const dir = makeTempDir();
    const output = join(dir, 'report.json');
    const fetcher = makeFetcher({
      'acme/small': copilotPrs(10),
      'acme/large': unattributedPrs(90),
    });

    const code = await runAttributePrsCommand(
      { repo: ['acme/small', 'acme/large'], limit: '100', output, 'audit-seed': '1' },
      fetcher,
      FIXED_NOW,
    );
    assert.equal(code, 0);

    const report = readReport(output);
    assert.equal(report.aggregate.repoCount, 2);
    assert.equal(report.aggregate.totalPrs, 100);
    assert.equal(report.aggregate.dimensionCoverage.agent.macroPercent, 50);
    assert.equal(report.aggregate.dimensionCoverage.agent.microPercent, 10);
    // Only acme/large (90 PRs) is feasibility-eligible.
    assert.equal(report.aggregate.eligibleRepoCount, 1);
  });

  it('applies per-repo config overrides from a standalone config file', async () => {
    const dir = makeTempDir();
    const output = join(dir, 'report.json');
    const configPath = join(dir, 'attribution.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {
          'acme/widgets': { extraBotLogins: ['inhouse-agent[bot]'] },
        },
      }),
    );
    const inhousePr: FixturePr = {
      number: 1,
      authorLogin: 'inhouse-agent[bot]',
      authorType: 'Bot',
    };
    const fetcher = makeFetcher({
      'acme/widgets': [inhousePr],
      'acme/gears': [{ ...inhousePr }],
    });

    const code = await runAttributePrsCommand(
      {
        repo: ['acme/widgets', 'acme/gears'],
        limit: '50',
        config: configPath,
        output,
        'audit-seed': '1',
      },
      fetcher,
      FIXED_NOW,
    );
    assert.equal(code, 0);

    const report = readReport(output);
    const [widgets, gears] = report.repositories;
    assert.equal(widgets.pullRequests[0].agent.status, 'agent');
    assert.equal(gears.pullRequests[0].agent.status, 'unknown');
  });

  it('rejects a malformed config file with a typed error naming the field', async () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'attribution.json');
    writeFileSync(configPath, JSON.stringify({ coverageFloorPercent: 'sixty' }));
    const fetcher = makeFetcher({ 'acme/widgets': [] });

    await assert.rejects(
      runAttributePrsCommand(
        { repo: ['acme/widgets'], limit: '50', config: configPath, 'audit-seed': '1' },
        fetcher,
        FIXED_NOW,
      ),
      /coverageFloorPercent/,
    );
  });

  it('produces a deterministic audit sample for a fixed seed', async () => {
    const fixtures = { 'acme/widgets': [...copilotPrs(20), ...unattributedPrs(10)] };
    const dir = makeTempDir();
    const firstPath = join(dir, 'first.json');
    const secondPath = join(dir, 'second.json');

    for (const output of [firstPath, secondPath]) {
      const code = await runAttributePrsCommand(
        {
          repo: ['acme/widgets'],
          limit: '50',
          output,
          'audit-sample': '5',
          'audit-seed': '7',
        },
        makeFetcher(fixtures),
        FIXED_NOW,
      );
      assert.equal(code, 0);
    }

    const first = readReport(firstPath);
    const second = readReport(secondPath);
    assert.ok(first.auditSamples);
    assert.equal(first.auditSamples[0].prNumbers.length, 5);
    assert.deepEqual(first.auditSamples, second.auditSamples);
    // Only attributed PRs (numbers 1-20 in the fixture) are sampled.
    assert.ok(first.auditSamples[0].prNumbers.every((n) => n >= 1 && n <= 20));
  });

  it('fails with an actionable message when gh auth is unavailable', async () => {
    const failing: Fetcher = {
      async gh(args: string[]): Promise<string> {
        throw new Error(`gh ${args.join(' ')} failed: not logged in`);
      },
    };
    await assert.rejects(
      runAttributePrsCommand(
        { repo: ['acme/widgets'], limit: '50', 'audit-seed': '1' },
        failing,
        FIXED_NOW,
      ),
      /auth status.*not logged in/,
    );
  });

  it('requires at least one repository', async () => {
    await assert.rejects(
      runAttributePrsCommand({ limit: '50', 'audit-seed': '1' }, makeFetcher({}), FIXED_NOW),
      /at least one --repo or --repos-file/,
    );
  });

  it('rejects out-of-range --limit values', async () => {
    await assert.rejects(
      runAttributePrsCommand(
        { repo: ['acme/widgets'], limit: '0', 'audit-seed': '1' },
        makeFetcher({}),
        FIXED_NOW,
      ),
      /Invalid --limit/,
    );
    await assert.rejects(
      runAttributePrsCommand(
        { repo: ['acme/widgets'], limit: '201', 'audit-seed': '1' },
        makeFetcher({}),
        FIXED_NOW,
      ),
      /Invalid --limit/,
    );
  });

  it('accepts a repos file with comments and deduplicates against --repo', async () => {
    const dir = makeTempDir();
    const reposPath = join(dir, 'repos.txt');
    writeFileSync(reposPath, '# fixtures\nacme/widgets\nacme/gears # trailing comment\n');
    const output = join(dir, 'report.json');
    const fetcher = makeFetcher({ 'acme/widgets': [], 'acme/gears': [] });

    const code = await runAttributePrsCommand(
      {
        repo: ['acme/widgets'],
        'repos-file': reposPath,
        limit: '50',
        output,
        'audit-seed': '1',
      },
      fetcher,
      FIXED_NOW,
    );
    assert.equal(code, 0);
    const report = readReport(output);
    assert.deepEqual(
      report.repositories.map((repo) => repo.repo),
      ['acme/widgets', 'acme/gears'],
    );
  });
});

describe('attribute-prs cli surface', () => {
  it('prints help without invoking gh', () => {
    const result = spawnSync(process.execPath, ['tools/attribute-prs.ts', '--help'], {
      encoding: 'utf-8',
      cwd: join(import.meta.dirname, '..'),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /attribute-prs/);
    assert.match(result.stdout, /--audit-sample/);
  });
});
