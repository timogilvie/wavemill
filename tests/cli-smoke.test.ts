/**
 * CLI smoke tests for the wavemill entry point.
 *
 * Verifies command routing, help/version output, and graceful failure
 * on missing dependencies or unknown commands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAVEMILL = resolve(__dirname, '..', 'wavemill');
const CLI_TIMEOUT_MS = 120_000;

function run(args: string[], env?: Record<string, string>): string {
  return execFileSync(WAVEMILL, args, {
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, ...env },
  });
}

function runExpectFail(
  args: string[],
  env?: Record<string, string>,
  cwd?: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(WAVEMILL, args, {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
      cwd,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('wavemill CLI', () => {
  describe('help and version', () => {
    it('shows help with no arguments', () => {
      const out = run([]);
      assert.match(out, /Usage:/);
      assert.match(out, /Commands:/);
    });

    it('shows help with "help" command', () => {
      const out = run(['help']);
      assert.match(out, /Wavemill/);
      assert.match(out, /mill/);
      assert.match(out, /doctor/);
      assert.match(out, /expand/);
      assert.match(out, /plan/);
      assert.match(out, /review/);
      assert.match(out, /eval/);
      assert.match(out, /route/);
      assert.match(out, /observer/);
      assert.match(out, /hokusai/);
      assert.match(out, /intervention/);
    });

    it('shows help with --help flag', () => {
      const out = run(['--help']);
      assert.match(out, /Usage:/);
    });

    it('shows version with "version" command', () => {
      const out = run(['version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });

    it('shows version with --version flag', () => {
      const out = run(['--version']);
      assert.match(out, /Wavemill v\d+\.\d+\.\d+/);
    });
  });

  describe('unknown commands', () => {
    it('exits 1 for unknown command', () => {
      const result = runExpectFail(['nosuchcommand']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unknown command/);
    });
  });

  describe('intervention command', () => {
    it('fails clearly without a target', () => {
      const result = runExpectFail(['intervention']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /action target is required|Usage: wavemill intervention/);
    });

    it('fails clearly for an unknown action', () => {
      const result = runExpectFail(['intervention', 'bogus-action', 'target']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown intervention action/);
    });
  });

  describe('dependency checks', () => {
    it('mill reports missing tmux when not on PATH', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-cli-smoke-'));
      // Use a minimal PATH that excludes tmux
      try {
        const result = runExpectFail(['mill'], {
          PATH: '/usr/bin:/bin',
          SKIP_CONTEXT_CHECK: 'true',
          SKIP_CONFIG_CHECK: 'true',
          WAVEMILL_MILL_ACTIVE: '',
          HOME: process.env.HOME ?? '',
        }, repoDir);
        assert.notEqual(result.status, 0);
        const output = result.stdout + result.stderr;
        assert.match(output, /tmux|required|not found|mktemp/i);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('route command', () => {
    it('routes inline task text', () => {
      const out = run(['route', 'Create', 'a', 'route', 'CLI', 'command', 'with', 'JSON', 'output']);
      assert.match(out, /Starting Wavemill Route/);
      assert.match(out, /Planner:/);
      assert.match(out, /Coder:/);
      assert.match(out, /Reviewer:/);
      assert.match(out, /Success:/);
    });
  });

  describe('check-routing command', () => {
    it('prints routing health for an isolated repo', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-routing-health-'));
      try {
        mkdirSync(join(repoDir, '.wavemill', 'evals'), { recursive: true });
        writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
          router: {
            enabled: true,
            mode: 'stage-aware',
            minRecords: 1,
            minModels: 1,
            defaultAgent: 'claude',
          },
          eval: {
            pricing: {
              'claude-sonnet-4-5-20250929': { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheWriteCostPerMTok: 3.75, cacheReadCostPerMTok: 0.3 },
            },
          },
        }));
        writeFileSync(join(repoDir, '.wavemill', 'evals', 'evals.jsonl'), `${JSON.stringify({
          id: '1',
          schemaVersion: '1.0.0',
          originalPrompt: 'Fix routing bug',
          modelId: 'claude-sonnet-4-5-20250929',
          modelVersion: 'claude-sonnet-4-5-20250929',
          score: 0.9,
          scoreBand: 'good',
          timeSeconds: 120,
          timestamp: '2026-04-10T00:00:00.000Z',
          interventionRequired: false,
          interventionCount: 0,
          interventionDetails: [],
          rationale: 'ok',
          metadata: {
            stageScores: {
              plan: { score: 0.9, rationale: 'ok' },
              implementation: { score: 0.9, rationale: 'ok' },
              review: { score: 0.9, rationale: 'ok' },
            },
          },
          taskDescriptor: {
            schema_version: '1.0',
            signals: {
              heuristic: {
                task_type: 'bugfix',
                languages: ['typescript'],
                framework_tags: [],
                files_touched: 3,
                repo_size_loc: 5000,
                description_tokens: 120,
                is_greenfield: false,
                has_migration: false,
                has_ui: false,
                has_tests: true,
                cross_service: false,
              },
              learned: {
                complexity: 2,
                domain: 'backend',
                risk_flags: ['workflow'],
              },
            },
            constraints: {
              models_available: [],
              objective: 'balanced',
            },
            stages: {
              planner: { model: 'claude-sonnet-4-5-20250929', cost_usd: 1 },
              coder: { model: 'claude-sonnet-4-5-20250929', cost_usd: 2 },
              reviewer: { model: 'claude-sonnet-4-5-20250929', cost_usd: 1 },
            },
          },
        })}\n`);
        mkdirSync(join(repoDir, 'tools'), { recursive: true });
        writeFileSync(join(repoDir, 'tools', 'route-task.ts'), '// stub\n');

        const out = execFileSync(WAVEMILL, ['check-routing', '--repo-dir', repoDir], {
          encoding: 'utf-8',
          timeout: CLI_TIMEOUT_MS,
          env: { ...process.env },
        });
        assert.match(out, /Starting Wavemill Routing Check/);
        assert.match(out, /Routing health:/);
        assert.match(out, /Sample route:/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('doctor command', () => {
    it('dispatches doctor openrouter to the tool layer', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-openrouter-doctor-cli-'));
      try {
        mkdirSync(join(repoDir, '.wavemill', 'native-agent-certifications', 'z-ai', 'glm-5.2'), { recursive: true });
        writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
          providers: {
            openrouter: {
              enabled: true,
              apiKeyEnv: 'TEST_OPENROUTER_KEY',
            },
          },
          nativeAgent: {
            providers: {
              openrouter: {
                enabled: true,
                apiKeyEnv: 'TEST_OPENROUTER_KEY',
              },
            },
          },
          router: {
            defaultAgent: 'claude',
          },
        }, null, 2));
        writeFileSync(join(repoDir, '.wavemill', 'native-agent-certifications', 'z-ai', 'glm-5.2', 'v1.json'), JSON.stringify({
          schemaVersion: '1.0.0',
          provider: 'z-ai',
          model: 'glm-5.2',
          phase: 'workflow',
          suiteVersion: 'v1',
          certifiedAt: '2026-07-10T00:00:00.000Z',
          scenarios: [{ scenarioId: 's1', passed: true }],
        }));
        const result = runExpectFail(['doctor', 'openrouter', '--json', '--repo-dir', repoDir], {
          TEST_OPENROUTER_KEY: 'sk-test',
        });
        assert.ok(result.status === 0 || result.status === 1);
        assert.match(result.stdout, /"models"/);
        assert.match(result.stdout, /glm-5\.2/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('hokusai command', () => {
    it('shows disabled status by default in an isolated HOME', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        const out = run(['hokusai', 'status', '--repo-dir', repoDir], { HOME: fakeHome });
        assert.match(out, /Hokusai data submission: disabled/);
        assert.match(out, /Submission allowed: no/);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('returns contribution summary in status --json', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        const out = run(['hokusai', 'status', '--json', '--repo-dir', repoDir], { HOME: fakeHome });
        const parsed = JSON.parse(out) as {
          contributions?: {
            consent: string;
            queue: string;
            uploadEndpoint: string;
            mode: string;
            pendingQueueCount: number;
            acceptedSubmissionCount: number;
            acceptedRowCount: number;
            tokenRewards: { awarded: number; pending: number; none: number; unknown: number };
            historyReadOnly: boolean;
          };
        };
        assert.equal(typeof parsed.contributions?.pendingQueueCount, 'number');
        assert.equal(typeof parsed.contributions?.acceptedSubmissionCount, 'number');
        assert.equal(typeof parsed.contributions?.acceptedRowCount, 'number');
        assert.deepEqual(parsed.contributions?.tokenRewards, { awarded: 0, pending: 0, none: 0, unknown: 0 });
        assert.equal(parsed.contributions?.historyReadOnly, true);
        // New structured facets
        assert.ok(['enabled', 'disabled'].includes(parsed.contributions?.consent ?? ''), 'consent should be enabled or disabled');
        assert.ok(['enabled', 'disabled'].includes(parsed.contributions?.queue ?? ''), 'queue should be enabled or disabled');
        assert.ok(['configured', 'missing'].includes(parsed.contributions?.uploadEndpoint ?? ''), 'uploadEndpoint should be configured or missing');
        assert.ok(['uploading', 'export-only', 'disabled'].includes(parsed.contributions?.mode ?? ''), 'mode should be a known value');
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('status shows contribution facets in text output', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        const out = run(['hokusai', 'status', '--repo-dir', repoDir], { HOME: fakeHome });
        assert.match(out, /Consent:/);
        assert.match(out, /Contribution queue:/);
        assert.match(out, /Upload endpoint:/);
        assert.match(out, /Mode:/);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('configure creates .wavemill-config.local.json with upload settings', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        const out = run(['hokusai', 'configure', '--repo-dir', repoDir], { HOME: fakeHome });
        assert.match(out, /Created|Updated|already configured/);
        assert.match(out, /Upload endpoint:/);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('configure --json returns structured result', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        const out = run(['hokusai', 'configure', '--json', '--repo-dir', repoDir], { HOME: fakeHome });
        const parsed = JSON.parse(out) as { action: string; endpoint: string; localConfigPath: string };
        assert.ok(['created', 'updated', 'unchanged'].includes(parsed.action), `unexpected action: ${parsed.action}`);
        assert.ok(parsed.endpoint.startsWith('https://'), `endpoint should be a URL: ${parsed.endpoint}`);
        assert.ok(parsed.localConfigPath.endsWith('.wavemill-config.local.json'));
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('drain reports empty queue when nothing is queued', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-home-'));
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-hokusai-repo-'));
      try {
        // contributions disabled by default, so drain returns disabled
        const out = run(['hokusai', 'drain', '--repo-dir', repoDir], { HOME: fakeHome });
        assert.match(out, /disabled|empty/i);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('quota command', () => {
    it('shows quota status from an isolated repo', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'wavemill-quota-cli-'));
      try {
        const out = execFileSync(WAVEMILL, ['quota', 'status', '--repo-dir', repoDir], {
          encoding: 'utf-8',
          timeout: 10_000,
          env: { ...process.env },
        });
        assert.match(out, /Snapshot:/);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('observer command', () => {
    it('shows observer help', () => {
      const out = run(['observer', '--help']);
      assert.match(out, /Wavemill Observer/);
      assert.match(out, /--loop/);
      assert.match(out, /--file-incidents/);
      assert.doesNotMatch(out, /--file-linear/);
    });

    it('prints the supervisor prompt', () => {
      const out = run(['observer', '--print-prompt']);
      assert.match(out, /You are the Wavemill Observer/);
      assert.match(out, /wavemill observer --json --once/);
    });
  });
});
