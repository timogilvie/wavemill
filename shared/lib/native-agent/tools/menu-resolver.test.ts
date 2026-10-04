import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WavemillConfig } from '../../config.ts';
import { computeValueDigest } from '../session-stream.ts';
import {
  createLaunchMenuProvider,
  formatMenuDenials,
  resolveTurnMenu,
} from './menu-resolver.ts';
import type { NativeCertificationSnapshot } from './exposure.ts';
import type {
  ToolDescriptor,
  ToolFamilyId,
  ToolMetadata,
  ToolPhase,
} from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coreDescriptor(
  name: string,
  phases: readonly ToolPhase[] = ['planning', 'coding', 'review'],
): ToolDescriptor {
  return {
    metadata: {
      name,
      description: `${name} description`,
      class: 'read-only',
      allowedPhases: phases,
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
    },
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
    async execute() {
      return { content: [{ type: 'text' as const, text: name }], details: undefined };
    },
  };
}

function advancedDescriptor(options: {
  name: string;
  family: ToolFamilyId;
  logicalId?: string;
  phases?: readonly ToolPhase[];
  cls?: ToolMetadata['class'];
}): ToolDescriptor {
  return {
    metadata: {
      name: options.name,
      description: `${options.name} description`,
      class: options.cls ?? 'read-only',
      allowedPhases: options.phases ?? ['planning', 'coding', 'review'],
      executionMode: 'parallel',
      outputCapPolicy: { strategy: 'none' },
      family: options.family,
      logicalId: options.logicalId,
    },
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
    },
    async execute() {
      return { content: [{ type: 'text' as const, text: options.name }], details: undefined };
    },
  };
}

function baseDescriptors(): ToolDescriptor[] {
  return [
    coreDescriptor('read_file'),
    coreDescriptor('list_files'),
    coreDescriptor('run_tests', ['coding']),
    advancedDescriptor({ name: 'browser_navigate', family: 'browser', logicalId: 'browser.navigate' }),
    advancedDescriptor({ name: 'mcp_call', family: 'mcp', logicalId: 'mcp.call' }),
  ];
}

function snapshot(
  maxCertifiedPhase: NativeCertificationSnapshot['maxCertifiedPhase'] = 'workflow',
): NativeCertificationSnapshot {
  return { maxCertifiedPhase };
}

// ---------------------------------------------------------------------------
// Byte-stability and digest determinism
// ---------------------------------------------------------------------------

describe('resolveTurnMenu — digest byte-stability', () => {
  it('returns the identical canonical + digest for two calls with identical inputs', () => {
    const config: WavemillConfig = {};
    const a = resolveTurnMenu({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    const b = resolveTurnMenu({
      phase: 'coding',
      config,
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    assert.equal(a.toolMenu.digest, b.toolMenu.digest);
    assert.equal(a.toolMenu.canonical, b.toolMenu.canonical);
    assert.equal(a.providerTools.digest, b.providerTools.digest);
    assert.equal(a.providerTools.canonical, b.providerTools.canonical);
  });

  it('canonicalizes keys — descriptor field order in `metadata` does not affect the digest', () => {
    const canonicalDescriptors: ToolDescriptor[] = [
      {
        metadata: {
          name: 'read_file',
          description: 'read_file description',
          class: 'read-only',
          allowedPhases: ['planning', 'coding', 'review'],
          executionMode: 'parallel',
          outputCapPolicy: { strategy: 'none' },
        },
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['path'],
        },
        async execute() {
          return { content: [{ type: 'text' as const, text: 'read_file' }], details: undefined };
        },
      },
    ];

    const scrambledDescriptors: ToolDescriptor[] = [
      {
        metadata: {
          outputCapPolicy: { strategy: 'none' },
          executionMode: 'parallel',
          allowedPhases: ['planning', 'coding', 'review'],
          class: 'read-only',
          description: 'read_file description',
          name: 'read_file',
        },
        parameters: {
          properties: {
            limit: { type: 'number' },
            path: { type: 'string' },
          },
          required: ['path'],
          type: 'object',
        },
        async execute() {
          return { content: [{ type: 'text' as const, text: 'read_file' }], details: undefined };
        },
      },
    ];

    const a = resolveTurnMenu({
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: canonicalDescriptors,
    });
    const b = resolveTurnMenu({
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: scrambledDescriptors,
    });
    assert.equal(a.toolMenu.digest, b.toolMenu.digest);
    assert.equal(a.providerTools.digest, b.providerTools.digest);
  });

  it('digest matches computeValueDigest of the canonical entries', () => {
    const result = resolveTurnMenu({
      phase: 'coding',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    const logicalEntries = JSON.parse(result.toolMenu.canonical);
    const providerEntries = JSON.parse(result.providerTools.canonical);
    assert.equal(computeValueDigest(logicalEntries), result.toolMenu.digest);
    assert.equal(computeValueDigest(providerEntries), result.providerTools.digest);
  });
});

// ---------------------------------------------------------------------------
// Denial + certification pass-through
// ---------------------------------------------------------------------------

describe('resolveTurnMenu — denials pass-through', () => {
  it('certification insufficient → advanced tools denied, core-only menu', () => {
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: { browser: { enabled: true, allowedPhases: ['coding'] } },
      },
    };
    const result = resolveTurnMenu({
      phase: 'coding',
      config,
      certification: snapshot('patch'),
      descriptors: baseDescriptors(),
    });
    const names = result.logical.map((meta) => meta.name);
    assert.deepEqual(names, ['read_file', 'list_files', 'run_tests']);
    assert.equal(result.providerTools.toolCount, 3);

    const browserDenial = result.denials.find(
      (d) => 'toolName' in d && d.toolName === 'browser_navigate',
    );
    assert.ok(browserDenial, 'expected browser_navigate denial');
    assert.equal(browserDenial.reason, 'certification_missing');
  });

  it('empty menu — all denied because certification is none — still emits digests', () => {
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: { browser: { enabled: true, allowedPhases: ['coding'] } },
      },
    };
    const result = resolveTurnMenu({
      phase: 'coding',
      config,
      certification: snapshot('none'),
      descriptors: [
        advancedDescriptor({ name: 'browser_navigate', family: 'browser', logicalId: 'browser.navigate' }),
      ],
    });
    assert.equal(result.logical.length, 0);
    assert.equal(result.provider.length, 0);
    assert.equal(result.toolMenu.digest.length, 64);
    assert.equal(result.providerTools.digest.length, 64);
    // Empty-menu canonical form is stable.
    assert.equal(result.toolMenu.canonical, '[]');
    assert.equal(result.providerTools.canonical, '[]');
  });
});

// ---------------------------------------------------------------------------
// Terminal synthesis override
// ---------------------------------------------------------------------------

describe('resolveTurnMenu — terminal synthesis override', () => {
  it('overrideProviderTools: [] → providerTools reflects empty schema list, toolMenu still full', () => {
    const config: WavemillConfig = {};
    const full = resolveTurnMenu({
      phase: 'planning',
      config,
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    const terminal = resolveTurnMenu({
      phase: 'planning',
      config,
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
      overrideProviderTools: [],
    });
    assert.equal(terminal.toolMenu.digest, full.toolMenu.digest);
    assert.notEqual(terminal.providerTools.digest, full.providerTools.digest);
    assert.equal(terminal.providerTools.toolCount, 0);
    assert.equal(terminal.provider.length, 0);
  });
});

// ---------------------------------------------------------------------------
// createLaunchMenuProvider
// ---------------------------------------------------------------------------

describe('createLaunchMenuProvider', () => {
  it('non-terminal turns return the same menu; terminal-synthesis re-resolves with empty provider', () => {
    const provider = createLaunchMenuProvider({
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    const a = provider.menuProvider.resolveForTurn({ turnIndex: 0, terminalSynthesis: false });
    const b = provider.menuProvider.resolveForTurn({ turnIndex: 5, terminalSynthesis: false });
    assert.equal(a.toolMenu.digest, b.toolMenu.digest);
    assert.equal(a.providerTools.digest, b.providerTools.digest);

    const terminal = provider.menuProvider.resolveForTurn({ turnIndex: 6, terminalSynthesis: true });
    assert.equal(terminal.providerTools.toolCount, 0);
    assert.equal(terminal.providerTools.canonical, '[]');
    assert.equal(terminal.toolMenu.digest, a.toolMenu.digest);
  });

  it('providerToolsForContext is a mutable snapshot ready to seat in AgentContext.tools', () => {
    const provider = createLaunchMenuProvider({
      phase: 'coding',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    });
    // "coding" allowedPhases for read_file/list_files/run_tests all include coding.
    assert.equal(provider.providerToolsForContext.length, provider.initialMenu.provider.length);
    const beforeLength = provider.providerToolsForContext.length;
    provider.providerToolsForContext.pop();
    // Popping the returned snapshot does not affect the frozen menu record.
    assert.equal(provider.providerToolsForContext.length, beforeLength - 1);
    assert.equal(provider.initialMenu.provider.length, beforeLength);
  });
});

// ---------------------------------------------------------------------------
// Denial log formatting
// ---------------------------------------------------------------------------

describe('formatMenuDenials', () => {
  it('renders every denial reason without secrets or PII', () => {
    const result = resolveTurnMenu({
      phase: 'coding',
      config: {
        nativeAgent: {
          advanced: {
            browser: { enabled: true, allowedPhases: ['coding'] },
          },
        },
      },
      certification: snapshot('read-only'),
      descriptors: baseDescriptors(),
    });
    const formatted = formatMenuDenials(result.denials);
    assert.match(formatted, /certification_missing/);
    assert.match(formatted, /family=browser/);
    assert.match(formatted, /logicalId=browser\.navigate/);
  });

  it('empty denial list → empty string', () => {
    assert.equal(formatMenuDenials([]), '');
  });
});

// ---------------------------------------------------------------------------
// Deterministic fixtures
//
// These fixtures are generated from `resolveTurnMenu` and committed to disk so
// downstream review and integration tests can pin against byte-stable menu
// artifacts. Regenerate with `WAVEMILL_UPDATE_MENU_FIXTURES=1 node --test
// shared/lib/native-agent/tools/menu-resolver.test.ts`.
// ---------------------------------------------------------------------------

const FIXTURES_DIR = new URL('../fixtures/menu/', import.meta.url).pathname;

interface MenuFixtureSpec {
  name: string;
  phase: ToolPhase;
  config: WavemillConfig;
  certification: NativeCertificationSnapshot;
  descriptors: ToolDescriptor[];
  overrideProviderTools?: [];
}

function fixtures(): MenuFixtureSpec[] {
  return [
    {
      name: 'planning-menu',
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    },
    {
      name: 'coding-menu',
      phase: 'coding',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    },
    {
      name: 'review-menu',
      phase: 'review',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    },
    {
      name: 'text-only-turn-menu',
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
    },
    {
      name: 'empty-menu',
      phase: 'coding',
      config: {
        nativeAgent: {
          advanced: { browser: { enabled: true, allowedPhases: ['coding'] } },
        },
      },
      certification: snapshot('none'),
      descriptors: [
        advancedDescriptor({ name: 'browser_navigate', family: 'browser', logicalId: 'browser.navigate' }),
      ],
    },
    {
      name: 'terminal-synthesis',
      phase: 'planning',
      config: {},
      certification: snapshot('workflow'),
      descriptors: baseDescriptors(),
      overrideProviderTools: [],
    },
  ];
}

describe('menu fixtures', () => {
  const shouldUpdate = process.env.WAVEMILL_UPDATE_MENU_FIXTURES === '1';

  for (const spec of fixtures()) {
    it(`${spec.name} — byte-stable against fixture`, () => {
      const resolved = resolveTurnMenu({
        phase: spec.phase,
        config: spec.config,
        certification: spec.certification,
        descriptors: spec.descriptors,
        overrideProviderTools: spec.overrideProviderTools,
      });
      const artifact = {
        phase: spec.phase,
        toolMenu: {
          digest: resolved.toolMenu.digest,
          toolNames: resolved.toolMenu.toolNames,
          canonical: JSON.parse(resolved.toolMenu.canonical),
        },
        providerTools: {
          digest: resolved.providerTools.digest,
          toolCount: resolved.providerTools.toolCount,
          toolNames: resolved.providerTools.toolNames,
          canonical: JSON.parse(resolved.providerTools.canonical),
        },
        denials: resolved.denials,
      };
      const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
      const path = join(FIXTURES_DIR, `${spec.name}.json`);
      if (shouldUpdate || !existsSync(path)) {
        mkdirSync(FIXTURES_DIR, { recursive: true });
        writeFileSync(path, serialized, 'utf-8');
      }
      const onDisk = readFileSync(path, 'utf-8');
      assert.equal(
        serialized,
        onDisk,
        `Fixture drift for ${spec.name}. Regenerate with WAVEMILL_UPDATE_MENU_FIXTURES=1.`,
      );
    });
  }
});
