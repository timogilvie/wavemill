import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearConfigCache } from './config.ts';
import { getManifest, openManifest } from './resource-manifest.ts';
import { getResource, listResources } from './resource-registry.ts';
import {
  loadRuntimeResource,
  loadRuntimeResourceSync,
  resolveRuntimeResource,
} from './resource-retrieval.ts';

let repoDir: string;
const originalSession = process.env.WAVEMILL_SESSION;
const originalPhase = process.env.WAVEMILL_PHASE;

function writeRepoFile(relativePath: string, content: string): string {
  const fullPath = join(repoDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

describe('resource-retrieval', () => {
  beforeEach(() => {
    repoDir = join(
      tmpdir(),
      `resource-retrieval-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(repoDir, { recursive: true });
    clearConfigCache(repoDir);
    writeRepoFile('.wavemill/project-context.md', '# Project Context');
    writeRepoFile('.wavemill/context/frontend.md', '# Frontend Subsystem');
    writeRepoFile('.wavemill/context/concepts/progressive-disclosure.md', '# Concept');
    writeRepoFile('.wavemill-config.json', '{}');
  });

  afterEach(() => {
    clearConfigCache(repoDir);
    delete process.env.WAVEMILL_SESSION;
    delete process.env.WAVEMILL_PHASE;
    if (originalSession) {
      process.env.WAVEMILL_SESSION = originalSession;
    }
    if (originalPhase) {
      process.env.WAVEMILL_PHASE = originalPhase;
    }
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resolves phase prompts by stage without loading content', () => {
    const resolved = resolveRuntimeResource({
      kind: 'prompt',
      role: 'phase-instructions',
      stage: 'coding',
      repoDir,
    });

    assert.match(resolved.path, /tools\/prompts\/coding-phase\.md$/);
    assert.equal(resolved.content, undefined);
    assert.equal(resolved.resource, null);
    assert.equal(resolved.ref, null);
    assert.equal(resolved.contract.stability, 'stable');
  });

  it('loads initiative planner prompts by operating mode', async () => {
    const normal = await loadRuntimeResource({
      kind: 'prompt',
      role: 'initiative-planner',
      operatingMode: 'normal',
      repoDir,
    });
    const constrained = await loadRuntimeResource({
      kind: 'prompt',
      role: 'initiative-planner',
      operatingMode: 'constrained',
      repoDir,
    });
    const survival = await loadRuntimeResource({
      kind: 'prompt',
      role: 'initiative-planner',
      operatingMode: 'survival',
      repoDir,
    });

    assert.match(normal.path, /initiative-planner\.md$/);
    assert.match(constrained.path, /initiative-planner-compressed\.md$/);
    assert.match(survival.path, /initiative-planner-compressed\.md$/);
    assert.match(normal.content!, /STEP 1 -- Understand and Scope/);
    assert.match(constrained.content!, /Return ONLY raw JSON/);
    assert.match(survival.content!, /Produce 1-2 milestones/);
  });

  it('loads scoped reviewer prompts in constrained and survival modes', () => {
    const generalNormal = loadRuntimeResourceSync({
      kind: 'prompt',
      role: 'reviewer',
      persona: 'general',
      operatingMode: 'normal',
      repoDir,
    });
    const generalScoped = loadRuntimeResourceSync({
      kind: 'prompt',
      role: 'reviewer',
      persona: 'general',
      operatingMode: 'constrained',
      repoDir,
    });
    const security = loadRuntimeResourceSync({
      kind: 'prompt',
      role: 'reviewer',
      persona: 'security',
      operatingMode: 'survival',
      repoDir,
    });

    assert.match(generalNormal.path, /review-general\.md$/);
    assert.match(generalScoped.path, /review-general-scoped\.md$/);
    assert.match(generalScoped.content!, /needs_stronger_reviewer/);
    assert.match(security.path, /review-security\.md$/);
  });

  it('loads memory and policy resources with typed metadata', () => {
    const projectContext = loadRuntimeResourceSync({
      kind: 'memory',
      role: 'project-context',
      repoDir,
    });
    const subsystem = loadRuntimeResourceSync({
      kind: 'memory',
      role: 'subsystem-spec',
      id: 'frontend',
      repoDir,
    });
    const concept = loadRuntimeResourceSync({
      kind: 'memory',
      role: 'concept-page',
      id: 'progressive-disclosure',
      repoDir,
    });
    const policy = loadRuntimeResourceSync({
      kind: 'policy',
      role: 'wavemill-config',
      repoDir,
    });

    assert.match(projectContext.path, /\.wavemill\/project-context\.md$/);
    assert.equal(projectContext.resource?.metadata?.resourceClass, 'memory');
    assert.equal(projectContext.resource?.metadata?.memoryRole, 'project-context');
    assert.equal(subsystem.resource?.metadata?.subsystemId, 'frontend');
    assert.equal(concept.resource?.metadata?.conceptId, 'progressive-disclosure');
    assert.equal(policy.resource?.type, 'agent-config');
    assert.equal(policy.resource?.metadata?.resourceClass, 'policy');
  });

  it('records prompt usage in the session manifest and registry with contract metadata', () => {
    process.env.WAVEMILL_SESSION = 'session-typed-prompt';
    process.env.WAVEMILL_PHASE = 'review';
    openManifest('session-typed-prompt', { workflowType: 'feature', repoDir });

    const prompt = loadRuntimeResourceSync({
      kind: 'prompt',
      role: 'reviewer',
      persona: 'general',
      operatingMode: 'constrained',
      repoDir,
    });

    assert.ok(prompt.ref);
    const resource = getResource(prompt.ref!.id, prompt.ref!.version, repoDir);
    assert.equal(resource?.metadata?.resourceClass, 'prompt');
    assert.equal(resource?.metadata?.role, 'reviewer');
    assert.equal(resource?.metadata?.persona, 'general');
    assert.equal(resource?.metadata?.operatingMode, 'constrained');

    const manifest = getManifest('session-typed-prompt', repoDir);
    assert.ok(manifest?.phases.review.some((ref) => ref.id === prompt.ref!.id));

    const promptRegistry = readFileSync(join(repoDir, '.wavemill', 'evals', 'prompt-registry.jsonl'), 'utf-8');
    assert.match(promptRegistry, /review-general-scoped/);
  });

  it('deduplicates repeated typed resource loads by content', () => {
    loadRuntimeResourceSync({
      kind: 'memory',
      role: 'subsystem-spec',
      id: 'frontend',
      repoDir,
    });
    loadRuntimeResourceSync({
      kind: 'memory',
      role: 'subsystem-spec',
      id: 'frontend',
      repoDir,
    });

    assert.equal(listResources({ type: 'memory' }, repoDir).length, 1);
  });

  it('returns content with null resource metadata when the registry is disabled', () => {
    writeFileSync(join(repoDir, '.wavemill-config.json'), JSON.stringify({
      registry: { enabled: false },
    }, null, 2), 'utf-8');
    clearConfigCache(repoDir);

    const prompt = loadRuntimeResourceSync({
      kind: 'prompt',
      role: 'issue-writer',
      repoDir,
    });

    assert.match(prompt.content!, /Linear issue/);
    assert.equal(prompt.resource, null);
    assert.equal(prompt.ref, null);
  });

  it('throws clear errors for invalid selectors and unsupported versioning controls', async () => {
    await assert.rejects(
      () => loadRuntimeResource({
        kind: 'memory',
        role: 'subsystem-spec',
        id: '',
        repoDir,
      }),
      /requires a non-empty id/,
    );

    await assert.rejects(
      () => loadRuntimeResource({
        kind: 'prompt',
        role: 'issue-writer',
        stability: 'canary',
        repoDir,
      }),
      /Unsupported stability channel "canary"/,
    );

    await assert.rejects(
      () => loadRuntimeResource({
        kind: 'prompt',
        role: 'eval-judge',
        version: 'v2',
        repoDir,
      }),
      /Explicit version selection is not supported yet/,
    );

    await assert.rejects(
      () => loadRuntimeResource({
        kind: 'memory',
        role: 'subsystem-spec',
        id: 'missing',
        repoDir,
      }),
      /Backing file not found for memory:subsystem-spec/,
    );
  });
});
