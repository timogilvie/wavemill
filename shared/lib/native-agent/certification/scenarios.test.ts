import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  PHASE_ORDER,
  getDefaultScenarios,
} from './scenarios.ts';
import { checkCertificationEligibility } from './loader.ts';
import { writeCertification } from './store.ts';
import { CERTIFICATION_SCHEMA_VERSION, type NativeCertificationArtifact } from './schema.ts';
import { computeIdentityFingerprint } from '../../model-registry.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CONTEXT = {
  provider: 'openai',
  model: 'gpt-test',
  transport: 'openai-responses',
} as const;

function scenarioById(id: string) {
  const scenario = getDefaultScenarios().find((entry) => entry.id === id);
  assert.ok(scenario, `missing scenario ${id}`);
  assert.equal(scenario.classification, 'deterministic');
  assert.equal(typeof scenario.assertion, 'function');
  return scenario;
}

describe('getDefaultScenarios — catalog integrity', () => {
  const scenarios = getDefaultScenarios();

  it('returns a non-empty array', () => {
    assert.ok(scenarios.length > 0, 'catalog must have at least one scenario');
  });

  it('every scenario has a non-empty id', () => {
    for (const scenario of scenarios) {
      assert.ok(
        typeof scenario.id === 'string' && scenario.id.length > 0,
        `scenario has empty or missing id: ${JSON.stringify(scenario)}`,
      );
    }
  });

  it('no duplicate scenario IDs', () => {
    const seen = new Set<string>();
    for (const scenario of scenarios) {
      assert.ok(
        !seen.has(scenario.id),
        `duplicate scenario ID: "${scenario.id}"`,
      );
      seen.add(scenario.id);
    }
  });

  it('every deterministic scenario has an assertion', () => {
    for (const scenario of scenarios) {
      if (scenario.classification === 'deterministic') {
        assert.ok(
          typeof scenario.assertion === 'function',
          `deterministic scenario "${scenario.id}" must have an assertion function`,
        );
      }
    }
  });

  it('no live-judged scenario has an assertion', () => {
    for (const scenario of scenarios) {
      if (scenario.classification === 'live-judged') {
        assert.equal(
          scenario.assertion,
          undefined,
          `live-judged scenario "${scenario.id}" must not have an assertion function`,
        );
      }
    }
  });

  it('every phase value is in PHASE_ORDER', () => {
    const validPhases = new Set<string>(PHASE_ORDER);
    for (const scenario of scenarios) {
      assert.ok(
        validPhases.has(scenario.phase),
        `scenario "${scenario.id}" has invalid phase "${scenario.phase}"`,
      );
    }
  });

  it('includes at least one workflow-phase scenario', () => {
    assert.ok(
      scenarios.some((scenario) => scenario.phase === 'workflow'),
      'catalog must include at least one workflow scenario',
    );
  });

  it('every category in (tool, usage, transcript, phase) has at least one deterministic scenario', () => {
    const categories = ['tool', 'usage', 'transcript', 'phase'] as const;
    const deterministicByCategory = new Map<string, number>();
    for (const scenario of scenarios) {
      if (scenario.classification === 'deterministic') {
        deterministicByCategory.set(
          scenario.category,
          (deterministicByCategory.get(scenario.category) ?? 0) + 1,
        );
      }
    }
    for (const category of categories) {
      assert.ok(
        (deterministicByCategory.get(category) ?? 0) > 0,
        `category "${category}" has no deterministic scenarios`,
      );
    }
  });

  it('at least one live-judged scenario exists (exercises not-run path)', () => {
    const hasLiveJudged = scenarios.some((s) => s.classification === 'live-judged');
    assert.ok(hasLiveJudged, 'catalog must include at least one live-judged scenario to exercise the not-run path');
  });

  it('has at least one deterministic workflow-phase scenario', () => {
    assert.ok(
      scenarios.some((scenario) => scenario.phase === 'workflow' && scenario.classification === 'deterministic'),
      'catalog must include at least one deterministic workflow-phase scenario',
    );
  });

  it('workflow-phase scenarios cover tool, transcript, usage, and phase categories', () => {
    const workflowCategories = new Set(
      scenarios
        .filter((scenario) => scenario.phase === 'workflow')
        .map((scenario) => scenario.category),
    );
    assert.deepEqual([...workflowCategories].sort(), ['phase', 'tool', 'transcript', 'usage']);
  });

  it('workflow-phase scenarios are all deterministic', () => {
    for (const scenario of scenarios.filter((entry) => entry.phase === 'workflow')) {
      assert.equal(
        scenario.classification,
        'deterministic',
        `workflow scenario "${scenario.id}" must be deterministic`,
      );
    }
  });

  it('getDefaultScenarios returns a new array each call', () => {
    const a = getDefaultScenarios();
    const b = getDefaultScenarios();
    assert.notEqual(a, b, 'getDefaultScenarios must return a fresh array each call');
    assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
  });
});

describe('workflow certification scenarios', () => {
  const workflowScenarioIds = [
    'workflow.tools.contract-shape-stable',
    'workflow.tools.mutation-policy-allows-in-phase',
    'workflow.tools.mutation-policy-denies-out-of-phase',
    'workflow.transcript.approval-lifecycle-jsonl-shape',
    'workflow.provenance.untrusted-input-detects-phase-override',
    'workflow.usage.multi-turn-token-accounting',
    'workflow.cleanup.tracker-roundtrip-and-summary-event',
    'workflow.phase.workflow-persistence-roundtrip',
    'workflow.phase.native-openrouter-launch-matrix',
    'mcp.tools.success',
    'mcp.tools.denial',
    'mcp.tools.timeout',
    'mcp.transcript.redaction',
    'mcp.cleanup.lifecycle',
  ];

  for (const id of workflowScenarioIds) {
    it(`${id} passes in the deterministic harness`, async () => {
      const scenario = scenarioById(id);
      const result = await scenario.assertion!(DEFAULT_CONTEXT);
      assert.deepEqual(result, { kind: 'pass' });
    });
  }

  it('workflow-phase persistence requires workflow for planner eligibility when the artifact is only read-only', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'workflow-phase-insufficient-'));
    try {
      const artifact: NativeCertificationArtifact = {
        schemaVersion: CERTIFICATION_SCHEMA_VERSION,
        subject: {
          registryKey: 'gpt-test',
          nativeProvider: 'openai',
          providerId: 'openai',
          providerModelId: 'gpt-test',
          providerNativeId: 'gpt-test',
          identityRevision: 1,
          identityFingerprint: computeIdentityFingerprint({
            alias: 'gpt-test',
            providerNativeId: 'gpt-test',
            provider: 'openai',
            revision: 1,
          }),
          catalogHash: 'registry',
        },
        provider: 'openai',
        model: 'gpt-test',
        phase: 'read-only',
        suiteVersion: DEFAULT_CERTIFICATION_SUITE_VERSION,
        certifiedAt: new Date().toISOString(),
        scenarios: [{ scenarioId: 'synthetic.pass', passed: true }],
      };

      writeCertification(repoDir, artifact);
      const eligibility = checkCertificationEligibility(
        repoDir,
        artifact.provider,
        artifact.model,
        artifact.suiteVersion,
        'workflow',
        new Date(),
      );

      assert.deepEqual(eligibility, {
        eligible: false,
        reason: 'phase-insufficient',
        artifact,
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('patch certification scenarios', () => {
  const patchScenarioIds = [
    'patch.runtime.native-patch-application',
    'patch.paths.boundaries-and-generated-artifacts',
    'patch.phase.dirty-tree-gate',
    'patch.usage.intended-file-tracking',
    'patch.tools.command-and-format-safety',
    'patch.cleanup.abort-restores-worktree',
    'patch.cleanup.timeout-restores-worktree',
    'patch.transcript.command-redaction',
    'patch.phase.ready-remediation-fixtures',
  ];

  for (const id of patchScenarioIds) {
    it(`${id} passes in the deterministic harness`, async () => {
      const scenario = scenarioById(id);
      const result = await scenario.assertion!(DEFAULT_CONTEXT);
      assert.deepEqual(result, { kind: 'pass' });
    });
  }

  it('patch-phase scenarios cover tool, transcript, usage, and phase categories', () => {
    const patchCategories = new Set(
      getDefaultScenarios()
        .filter((scenario) => scenario.phase === 'patch')
        .map((scenario) => scenario.category),
    );
    assert.deepEqual([...patchCategories].sort(), ['phase', 'tool', 'transcript', 'usage']);
  });

  it('patch-phase scenarios are all deterministic', () => {
    for (const scenario of getDefaultScenarios().filter((entry) => entry.phase === 'patch')) {
      assert.equal(
        scenario.classification,
        'deterministic',
        `patch scenario "${scenario.id}" must be deterministic`,
      );
    }
  });
});
