import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WavemillConfig } from '../../config.ts';
import {
  certificationSatisfies,
  computeEligibility,
  type EligibilityDenial,
  type NativeCertificationSnapshot,
} from './exposure.ts';
import { createToolRegistry } from './registry.ts';
import type {
  ToolDescriptor,
  ToolFamilyId,
  ToolMetadata,
  ToolPhase,
} from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function core(name: string, phases: readonly ToolPhase[] = ['planning', 'coding', 'review']): ToolDescriptor {
  return {
    metadata: {
      name,
      description: name,
      class: 'read-only',
      allowedPhases: phases,
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: name }], details: undefined };
    },
  };
}

function advanced(options: {
  name: string;
  family: ToolFamilyId;
  logicalId?: string;
  phases?: readonly ToolPhase[];
  cls?: ToolMetadata['class'];
}): ToolDescriptor {
  return {
    metadata: {
      name: options.name,
      description: options.name,
      class: options.cls ?? 'read-only',
      allowedPhases: options.phases ?? ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
      family: options.family,
      logicalId: options.logicalId,
    },
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: options.name }], details: undefined };
    },
  };
}

function makeRegistry() {
  const registry = createToolRegistry([
    core('read_file'),
    core('list_files'),
    core('run_tests', ['coding']),
    advanced({ name: 'browser_navigate', family: 'browser', logicalId: 'browser.navigate' }),
    advanced({ name: 'browser_snapshot', family: 'browser', logicalId: 'browser.snapshot' }),
    advanced({ name: 'mcp_call', family: 'mcp', logicalId: 'mcp.call' }),
  ]);
  return registry;
}

function snapshot(maxCertifiedPhase: NativeCertificationSnapshot['maxCertifiedPhase'] = 'workflow'): NativeCertificationSnapshot {
  return { maxCertifiedPhase };
}

function findDenial(
  denials: readonly EligibilityDenial[],
  predicate: (denial: EligibilityDenial) => boolean,
): EligibilityDenial | undefined {
  return denials.find(predicate);
}

// ---------------------------------------------------------------------------
// Default-off behavior
// ---------------------------------------------------------------------------

describe('exposure — default-off behavior', () => {
  it('empty config yields only core tools for the phase; every advanced descriptor is denied', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {};

    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });

    assert.deepEqual([...result.eligibleNames], ['read_file', 'list_files', 'run_tests']);
    assert.deepEqual([...result.eligibleFamilies], ['core']);

    const advancedNames = ['browser_navigate', 'browser_snapshot', 'mcp_call'];
    for (const name of advancedNames) {
      const denial = findDenial(
        result.denials,
        (d) => 'toolName' in d && d.toolName === name,
      );
      assert.ok(denial, `expected denial for ${name}`);
      assert.equal(denial.reason, 'family_not_enabled');
    }
  });

  it('registry-only fixture (no config) — advanced descriptors remain hidden even with certification', () => {
    const registry = makeRegistry();
    const result = computeEligibility({
      phase: 'coding',
      config: {},
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.equal(result.eligibleNames.includes('browser_navigate'), false);
    assert.equal(result.eligibleNames.includes('mcp_call'), false);
  });
});

// ---------------------------------------------------------------------------
// Family opt-in
// ---------------------------------------------------------------------------

describe('exposure — family opt-in', () => {
  it('enabling one family for one phase exposes exactly its tools in that phase', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: { enabled: true, allowedPhases: ['coding'] },
        },
      },
    };

    const coding = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.ok(coding.eligibleNames.includes('browser_navigate'));
    assert.ok(coding.eligibleNames.includes('browser_snapshot'));
    assert.ok(!coding.eligibleNames.includes('mcp_call'));

    const review = computeEligibility({
      phase: 'review',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.ok(!review.eligibleNames.includes('browser_navigate'));
    const denial = findDenial(
      review.denials,
      (d) => 'toolName' in d && d.toolName === 'browser_navigate',
    );
    assert.ok(denial);
    assert.equal(denial.reason, 'phase_not_allowed');
  });

  it('enabled with empty allowedPhases denies with phase_not_allowed', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: { enabled: true, allowedPhases: [] },
        },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.equal(result.eligibleNames.includes('browser_navigate'), false);
    const denial = findDenial(
      result.denials,
      (d) => 'toolName' in d && d.toolName === 'browser_navigate',
    );
    assert.ok(denial);
    assert.equal(denial.reason, 'phase_not_allowed');
  });

  it('intersection: descriptor allowedPhases and config allowedPhases must both include the phase', () => {
    const registry = createToolRegistry([
      advanced({
        name: 'browser_navigate',
        family: 'browser',
        phases: ['review'],
      }),
    ]);
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: { browser: { enabled: true, allowedPhases: ['coding'] } },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.equal(result.eligibleNames.length, 0);
    const denial = result.denials.find((d) => 'toolName' in d && d.toolName === 'browser_navigate');
    assert.ok(denial);
    assert.equal(denial.reason, 'phase_not_allowed');
  });
});

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

describe('exposure — certification requirement', () => {
  it('certification below workflow hides advanced family even when config enables it', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: { browser: { enabled: true, allowedPhases: ['coding'] } },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('patch'),
      registry: registry.list(),
    });
    assert.equal(result.eligibleNames.includes('browser_navigate'), false);
    const denial = result.denials.find(
      (d) => d.reason === 'certification_missing' && 'toolName' in d && d.toolName === 'browser_navigate',
    );
    assert.ok(denial);
    assert.equal(denial.reason, 'certification_missing');
  });

  it('certification at workflow satisfies workflow requirement', () => {
    assert.equal(certificationSatisfies('workflow', 'workflow'), true);
    assert.equal(certificationSatisfies('workflow', 'patch'), true);
    assert.equal(certificationSatisfies('read-only', 'workflow'), false);
    assert.equal(certificationSatisfies('none', 'none'), true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics on invalid config
// ---------------------------------------------------------------------------

describe('exposure — invalid config diagnostics', () => {
  it('unknown family in config yields unknown_family denial without affecting known families', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          // Cast to any: schema disallows this at load time, but the engine must
          // still refuse gracefully for callers building configs by hand.
          browser: { enabled: true, allowedPhases: ['coding'] },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...({ unknown_family: { enabled: true, allowedPhases: ['coding'] } } as any),
        },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });

    const unknown = result.denials.find((d) => d.reason === 'unknown_family');
    assert.ok(unknown);

    // browser tools remain eligible despite the unknown family
    assert.ok(result.eligibleNames.includes('browser_navigate'));
  });

  it('invalid phase produces invalid_phase denial and no eligible tools', () => {
    const registry = makeRegistry();
    const result = computeEligibility({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phase: 'ready' as any,
      config: {},
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.deepEqual([...result.eligibleNames], []);
    const invalid = result.denials.find((d) => d.reason === 'invalid_phase');
    assert.ok(invalid);
  });

  it('unknown logical id in config yields unknown_logical_id denial', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: {
            enabled: true,
            allowedPhases: ['coding'],
            logicalIds: ['browser.navigate', 'browser.does_not_exist'],
          },
        },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    const unknown = result.denials.find((d) => d.reason === 'unknown_logical_id');
    assert.ok(unknown);
  });
});

// ---------------------------------------------------------------------------
// Logical-id allowlist
// ---------------------------------------------------------------------------

describe('exposure — logical id allowlist', () => {
  it('narrow allowlist exposes only listed logical ids from the family', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: {
            enabled: true,
            allowedPhases: ['coding'],
            logicalIds: ['browser.navigate'],
          },
        },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.ok(result.eligibleNames.includes('browser_navigate'));
    assert.equal(result.eligibleNames.includes('browser_snapshot'), false);
    const denial = result.denials.find(
      (d) => d.reason === 'logical_id_not_allowlisted' && 'toolName' in d && d.toolName === 'browser_snapshot',
    );
    assert.ok(denial);
  });

  it('empty logicalIds array is not treated as an allowlist', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: {
            enabled: true,
            allowedPhases: ['coding'],
            logicalIds: [],
          },
        },
      },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.ok(result.eligibleNames.includes('browser_navigate'));
    assert.ok(result.eligibleNames.includes('browser_snapshot'));
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('exposure — deterministic output', () => {
  it('two runs on identical inputs produce identical eligibleNames and denials', () => {
    const registry = makeRegistry();
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          browser: { enabled: true, allowedPhases: ['coding'] },
          mcp: { enabled: false, allowedPhases: ['coding'] },
        },
      },
    };
    const input = {
      phase: 'coding' as ToolPhase,
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    };
    const first = computeEligibility(input);
    const second = computeEligibility(input);
    assert.deepEqual([...first.eligibleNames], [...second.eligibleNames]);
    assert.deepEqual([...first.denials], [...second.denials]);
  });
});

// ---------------------------------------------------------------------------
// Prompt-content invariant
// ---------------------------------------------------------------------------

describe('exposure — prompt-content invariant', () => {
  it('a would-mutate advanced descriptor is never eligible without config opt-in', () => {
    // Synthetic mutation-class descriptor plus a config that omits its family:
    // exposure must keep it hidden regardless of any prior tool output.
    const registry = createToolRegistry([
      core('read_file'),
      advanced({
        name: 'ast_rename_symbol',
        family: 'ast',
        cls: 'mutation',
        phases: ['coding'],
      }),
    ]);
    const config: WavemillConfig = {};
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      registry: registry.list(),
    });
    assert.equal(result.eligibleNames.includes('ast_rename_symbol'), false);
    const denial = result.denials.find(
      (d) => 'toolName' in d && d.toolName === 'ast_rename_symbol',
    );
    assert.ok(denial);
    assert.equal(denial.reason, 'family_not_enabled');
  });
});
