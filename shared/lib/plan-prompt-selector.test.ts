import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import {
  pickInitiativePrompt,
  planPromptSelectorDeps,
} from './plan-prompt-selector.ts';

let repoDir: string;

function writeQuotaState(status: 'healthy' | 'degrading' | 'exhausted'): void {
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  writeFileSync(join(repoDir, '.wavemill', 'quota-state.json'), JSON.stringify({
    version: 1,
    updatedAt: '2026-04-18T12:00:00.000Z',
    models: {
      'claude-fable-5': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'claude-opus-5-5': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'gpt-6-sol': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'gpt-6-luna': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'claude-opus-4-8': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'claude-opus-4-7': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'claude-opus-4-6': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'gpt-5.5': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
      'gpt-5.4': {
        status,
        remainingEstimate: null,
        resetAt: null,
        confidence: 1,
        lastLimitErrorAt: null,
        lastSuccessAt: null,
        lastReason: null,
        consecutiveLimitErrors: status === 'healthy' ? 0 : 1,
      },
    },
  }, null, 2), 'utf-8');
}

describe('plan-prompt-selector', () => {
  beforeEach(() => {
    repoDir = join(
      tmpdir(),
      `plan-prompt-selector-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    mock.restoreAll();
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('loads the standard prompt in normal mode', async () => {
    const logs: string[] = [];
    mock.method(planPromptSelectorDeps, 'log', (message: string) => {
      logs.push(message);
    });

    const selection = await pickInitiativePrompt(repoDir);
    const expected = readFileSync(join(REPO_ROOT, 'tools', 'prompts', 'initiative-planner.md'), 'utf-8');

    assert.equal(selection.mode, 'normal');
    assert.equal(selection.templateName, 'initiative-planner.md');
    assert.equal(selection.content, expected);
    assert.match(selection.content, /STEP 1 -- Understand and Scope/);
    assert.deepEqual(logs, ['plan-decomposer: mode=normal template=initiative-planner.md']);
  });

  it('loads the compressed prompt in constrained mode', async () => {
    writeQuotaState('degrading');

    const logs: string[] = [];
    mock.method(planPromptSelectorDeps, 'log', (message: string) => {
      logs.push(message);
    });

    const selection = await pickInitiativePrompt(repoDir);

    assert.equal(selection.mode, 'constrained');
    assert.equal(selection.templateName, 'initiative-planner-compressed.md');
    assert.match(selection.content, /Return ONLY raw JSON/);
    assert.deepEqual(logs, ['plan-decomposer: mode=constrained template=initiative-planner-compressed.md']);
  });

  it('loads the compressed prompt in survival mode', async () => {
    writeQuotaState('exhausted');

    const logs: string[] = [];
    mock.method(planPromptSelectorDeps, 'log', (message: string) => {
      logs.push(message);
    });

    const selection = await pickInitiativePrompt(repoDir);

    assert.equal(selection.mode, 'survival');
    assert.equal(selection.templateName, 'initiative-planner-compressed.md');
    assert.match(selection.content, /Produce 1-2 milestones/);
    assert.deepEqual(logs, ['plan-decomposer: mode=survival template=initiative-planner-compressed.md']);
  });

  it('defaults to normal when operating mode lookup throws', async () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    mock.method(planPromptSelectorDeps, 'getCurrentOperatingMode', () => {
      throw new Error('boom');
    });
    mock.method(planPromptSelectorDeps, 'warn', (message: string) => {
      warnings.push(message);
    });
    mock.method(planPromptSelectorDeps, 'log', (message: string) => {
      logs.push(message);
    });

    const selection = await pickInitiativePrompt(repoDir);

    assert.equal(selection.mode, 'normal');
    assert.deepEqual(warnings, ['plan-decomposer: operating-mode lookup failed, defaulting to normal']);
    assert.deepEqual(logs, ['plan-decomposer: mode=normal template=initiative-planner.md']);
  });

  it('defaults to normal when operating mode lookup returns an unknown value', async () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    mock.method(planPromptSelectorDeps, 'getCurrentOperatingMode', () => 'mystery' as never);
    mock.method(planPromptSelectorDeps, 'warn', (message: string) => {
      warnings.push(message);
    });
    mock.method(planPromptSelectorDeps, 'log', (message: string) => {
      logs.push(message);
    });

    const selection = await pickInitiativePrompt(repoDir);

    assert.equal(selection.mode, 'normal');
    assert.deepEqual(warnings, ['plan-decomposer: operating-mode lookup returned unknown mode, defaulting to normal']);
    assert.deepEqual(logs, ['plan-decomposer: mode=normal template=initiative-planner.md']);
  });

  it('keeps the compressed template at least 30 percent shorter than the standard template', () => {
    const standard = readFileSync(join(REPO_ROOT, 'tools', 'prompts', 'initiative-planner.md'), 'utf-8');
    const compressed = readFileSync(join(REPO_ROOT, 'tools', 'prompts', 'initiative-planner-compressed.md'), 'utf-8');

    assert.ok(
      compressed.length <= standard.length * 0.7,
      `Expected compressed prompt length ${compressed.length} to be <= ${Math.floor(standard.length * 0.7)}`,
    );
  });
});
