/**
 * Smoke tests for tools/run-counterfactual-exploration.ts.
 *
 * The CLI runs under tsx as a subprocess; the goal here is to exercise the
 * gate + orchestration path end-to-end against a small hermetic checkpoint
 * fixture. Live persistence is validated by pointing the tool at a temporary
 * repo directory.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCheckpoint,
  type CreateCheckpointInput,
} from '../shared/lib/native-agent/session-checkpoint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI = resolve(REPO_ROOT, 'tools', 'run-counterfactual-exploration.ts');

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), 'hok2081-cli-'));
}

function baseInput(): CreateCheckpointInput {
  return {
    sessionId: 's-cli',
    decisionId: 'd-cli',
    phase: 'coding',
    events: [{ id: 'evt-1', kind: 'tool_call', payload: {}, tool: 'read_file' }],
    toolResults: [{ callId: 'evt-1', tool: 'read_file', content: 'ok' }],
    workingFiles: [{ path: 'a.ts', content: 'const x=1;\n' }],
    runtimeEnv: {
      whitelistEnv: {},
      network_access: false,
      modelId: 'claude-opus-4-6',
    },
    gitState: { headSha: 'abc', dirty: false },
    entropy: { mathRandomSeed: 1, dateNowSeedMs: 0 },
    toolMenu: { toolNames: ['read_file', 'write_file'], chosenTool: 'read_file' },
  };
}

function runCli(args: string[], repoDir: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', CLI, ...args], {
    cwd: repoDir,
    encoding: 'utf-8',
    env: { ...process.env, WAVEMILL_HOK2080_GATE_PATH: '' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('run-counterfactual-exploration CLI', () => {
  it('--verify-only reports OK on a well-formed checkpoint', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const { code, stdout } = runCli(['--checkpoint-root', handle.root, '--verify-only'], repo);
      assert.equal(code, 0);
      assert.match(stdout, /verify: ok/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses without a Go gate artifact and prints a machine-readable reason', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const { code, stderr } = runCli(['--checkpoint-root', handle.root], repo);
      assert.notEqual(code, 0);
      assert.match(stderr, /gate_(artifact_missing|decision_not_go|artifact_malformed)/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('--dry-run bypasses the gate and writes a report but no eval rows', () => {
    const repo = mkRepo();
    try {
      const handle = createCheckpoint(baseInput(), { repoDir: repo });
      const reportPath = join(repo, 'docs', 'replay-counterfactual-exploration.md');
      const summaryPath = join(repo, 'summary.json');
      const { code, stdout } = runCli(
        [
          '--checkpoint-root', handle.root,
          '--dry-run',
          '--policy', 'enumerate-all',
          '--report-out', reportPath,
          '--summary-json', summaryPath,
        ],
        repo,
      );
      assert.equal(code, 0, `stdout: ${stdout}`);
      assert.ok(existsSync(reportPath), 'report should have been written');
      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      assert.equal(summary.gate, 'bypassed');
      assert.equal(summary.fidelity, 1);
      assert.equal(typeof summary.baselineId, 'string');
      assert.ok(!existsSync(join(repo, '.wavemill', 'evals', 'evals.jsonl')));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
