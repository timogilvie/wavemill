/**
 * HOK-3142: a typed coder launch refusal re-routes only the coder, accumulates
 * exclusions across refusals, and reports `no-eligible` (with the certify
 * command) when nothing launchable remains — never a silent retry.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CODER_LAUNCH_EXCLUSIONS_FILE,
  readCoderLaunchExclusions,
  readRoutingPrompt,
  rerouteRefusedCoder,
  ROUTE_SUBSTITUTIONS_LOG,
  type RouteFn,
} from './coder-launch-reroute.ts';
import { DEFAULT_CERTIFICATION_SUITE_VERSION } from './native-agent/certification/index.ts';
import { makeOpenRouterReadyRepo, writeCertArtifact } from './workflow-router-test-helpers.ts';
import type { WorkflowRouteDecision } from './workflow-router.ts';

const REFUSAL = {
  reason: 'uncertified',
  certification: 'missing_live_canary',
  certifyCommand: 'npx tsx tools/native-agent-certify.ts --provider openrouter --model qwen-3-coder --phase patch --live-coding-canary',
};

function withFeature(fn: (ctx: { repoDir: string; featureDir: string }) => Promise<void>): Promise<void> {
  const { repoDir, cleanup } = makeOpenRouterReadyRepo();
  const featureDir = join(repoDir, 'features', 'hok-3142-fixture');
  mkdirSync(featureDir, { recursive: true });
  writeCertArtifact(repoDir, 'qwen', 'qwen3-coder', DEFAULT_CERTIFICATION_SUITE_VERSION, {
    phase: 'workflow',
    liveCanary: undefined,
  });
  writeFileSync(join(featureDir, 'task-packet.md'), '# Fix a small router bug\n\nAdd a unit test.\n');
  writeFileSync(join(featureDir, '.phase-config.json'), JSON.stringify({
    planning: { model: 'claude-opus-4-7', agent: 'claude', depth: 'medium', provider: 'anthropic' },
    coding: { model: 'qwen-3-coder', agent: 'native-openrouter', depth: 'deep', provider: 'native-openrouter' },
    review: { model: 'claude-opus-4-7', agent: 'claude', mode: 'llm', provider: 'anthropic' },
    forceModel: null,
  }));
  writeFileSync(join(featureDir, '.routing-complete'), JSON.stringify({
    planner: 'claude-opus-4-7',
    coder: 'qwen-3-coder',
    reviewer: 'claude-opus-4-7',
  }));
  return fn({ repoDir, featureDir }).finally(cleanup);
}

/** A route stub that returns a fixed coder and records the options it saw. */
function stubRoute(coder: string, seen: Array<string[] | undefined> = []): RouteFn {
  return async (_prompt, options) => {
    seen.push(options.excludeModels);
    return { coder, planner: 'claude-opus-4-7', reviewer: 'claude-opus-4-7' } as WorkflowRouteDecision;
  };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('rerouteRefusedCoder', () => {
  it('replaces only the coder in the approved route and records the substitution', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      const seen: Array<string[] | undefined> = [];
      const result = await rerouteRefusedCoder({
        repoDir,
        featureDir,
        issue: 'HOK-3142',
        refusedModels: ['qwen-3-coder'],
        refusal: REFUSAL,
        route: stubRoute('claude-sonnet-4-5-20250929', seen),
      });

      assert.equal(result.status, 'rerouted');
      assert.equal(result.status === 'rerouted' && result.to, 'claude-sonnet-4-5-20250929');
      assert.equal(result.status === 'rerouted' && result.source, 'router');
      assert.deepEqual(seen, [['qwen-3-coder']], 'routing ran with the refused coder excluded');

      const phaseConfig = readJson(join(featureDir, '.phase-config.json'));
      assert.equal(phaseConfig.coding.model, 'claude-sonnet-4-5-20250929');
      assert.equal(phaseConfig.coding.agent, 'claude');
      assert.equal(phaseConfig.coding.provider, 'anthropic');
      assert.equal(phaseConfig.coding.depth, 'deep', 'approved depth is preserved');
      assert.equal(phaseConfig.coding.launchSubstitution.from, 'qwen-3-coder');
      assert.equal(phaseConfig.planning.model, 'claude-opus-4-7', 'planner untouched');
      assert.equal(phaseConfig.review.model, 'claude-opus-4-7', 'reviewer untouched');

      const routing = readJson(join(featureDir, '.routing-complete'));
      assert.equal(routing.coder, 'claude-sonnet-4-5-20250929');
      assert.equal(routing.coderLaunchSubstitutions[0].certification, 'missing_live_canary');

      const audit = readFileSync(join(featureDir, ROUTE_SUBSTITUTIONS_LOG), 'utf-8').trim().split('\n');
      assert.equal(audit.length, 1);
      assert.equal(JSON.parse(audit[0]).to, 'claude-sonnet-4-5-20250929');
    });
  });

  it('accumulates exclusions so a refused substitute is excluded alongside the original', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142', refusedModels: ['qwen-3-coder'], refusal: REFUSAL,
        route: stubRoute('claude-sonnet-4-5-20250929'),
      });
      const seen: Array<string[] | undefined> = [];
      const second = await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142', refusedModels: ['claude-sonnet-4-5-20250929'], refusal: REFUSAL,
        route: stubRoute('claude-haiku-4-5-20251001', seen),
      });

      assert.equal(second.status, 'rerouted');
      assert.deepEqual(seen[0], ['qwen-3-coder', 'claude-sonnet-4-5-20250929']);
      assert.deepEqual(
        readCoderLaunchExclusions(featureDir).models.map((entry) => entry.model),
        ['qwen-3-coder', 'claude-sonnet-4-5-20250929'],
      );
    });
  });

  it('excludes both the routed model and its alias-resolved launch model', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      const result = await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142',
        refusedModels: ['qwen-3-coder', 'qwen-3-coder-alias'],
        refusal: REFUSAL,
        route: stubRoute('claude-sonnet-4-5-20250929'),
      });
      assert.equal(result.from, 'qwen-3-coder');
      assert.deepEqual(result.excluded, ['qwen-3-coder', 'qwen-3-coder-alias']);
    });
  });

  it('falls back to the deterministic substitution order when routing fails or re-picks a refused coder', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      const failing: RouteFn = async () => { throw new Error('hokusai unavailable'); };
      const viaFailure = await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142', refusedModels: ['qwen-3-coder'], refusal: REFUSAL, route: failing,
      });
      assert.equal(viaFailure.status, 'rerouted');
      assert.equal(viaFailure.status === 'rerouted' && viaFailure.source, 'deterministic');
      assert.notEqual(viaFailure.status === 'rerouted' && viaFailure.to, 'qwen-3-coder');

      const viaRepick = await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142', refusedModels: ['qwen-3-coder'], refusal: REFUSAL,
        route: stubRoute('qwen-3-coder'),
      });
      assert.equal(viaRepick.status, 'rerouted');
      assert.equal(viaRepick.status === 'rerouted' && viaRepick.source, 'deterministic');
    });
  });

  it('reports no-eligible with the certify command when no launchable coder remains', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      const result = await rerouteRefusedCoder({
        repoDir, featureDir, issue: 'HOK-3142', refusedModels: ['qwen-3-coder'], refusal: REFUSAL,
        route: stubRoute('qwen-3-coder'),
        // Only the refused native coder is in the routing pool.
        routeOptions: { modelsAvailable: ['qwen-3-coder'] },
      });
      assert.equal(result.status, 'no-eligible');
      assert.equal(result.status === 'no-eligible' && result.certifyCommand, REFUSAL.certifyCommand);
      assert.equal(result.certification, 'missing_live_canary');
      assert.equal(readJson(join(featureDir, '.phase-config.json')).coding.model, 'qwen-3-coder', 'route untouched');
      assert.equal(existsSync(join(featureDir, ROUTE_SUBSTITUTIONS_LOG)), false);
      assert.ok(existsSync(join(featureDir, CODER_LAUNCH_EXCLUSIONS_FILE)), 'exclusion still recorded');
    });
  });

  it('rejects an empty refusal', async () => {
    await withFeature(async ({ repoDir, featureDir }) => {
      await assert.rejects(
        rerouteRefusedCoder({ repoDir, featureDir, issue: 'HOK-3142', refusedModels: [' '], refusal: REFUSAL }),
        /at least one refused model/,
      );
    });
  });
});

describe('readRoutingPrompt', () => {
  it('prefers the task packet and falls back to the selected task', async () => {
    await withFeature(async ({ featureDir }) => {
      assert.match(readRoutingPrompt(featureDir), /Fix a small router bug/);
      writeFileSync(join(featureDir, 'task-packet.md'), '');
      writeFileSync(join(featureDir, 'selected-task.json'), JSON.stringify({ title: 'Title', description: 'Body' }));
      assert.equal(readRoutingPrompt(featureDir), 'Title\n\nBody');
    });
  });
});
