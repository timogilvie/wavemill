import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createReviewScoringTools, type ReviewScoringDetails } from './review-scoring.ts';
import { createToolRegistry } from './registry.ts';
import { computeEligibility, type NativeCertificationSnapshot } from './exposure.ts';
import type { ToolDescriptor, WavemillToolResult } from './types.ts';
import type { WavemillConfig } from '../../config.ts';

// ---------------------------------------------------------------------------
// Temp dir + git repo helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initGitRepo(dir: string, baseBranch = 'main'): void {
  execFileSync('git', ['-C', dir, 'init', '--initial-branch', baseBranch, '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'README.md'), '# base\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'base']);
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message]);
}

function checkoutBranch(dir: string, name: string): void {
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', name]);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function fillReviewWorktree(dir: string, options: {
  featureName?: string;
  taskPacket?: string;
  headerPacket?: string;
  detailsPacket?: string;
  selectedTask?: unknown;
  diffFiles?: Record<string, string>;
} = {}): string {
  initGitRepo(dir, 'main');
  const originalBranch = 'main';
  const workBranch = 'task/eval-scoring';
  const featureName = options.featureName ?? 'eval-scoring';
  const featureDir = path.join(dir, 'features', featureName);
  mkdirSync(featureDir, { recursive: true });
  if (options.taskPacket !== undefined) {
    writeFileSync(path.join(featureDir, 'task-packet.md'), options.taskPacket);
  }
  if (options.headerPacket !== undefined) {
    writeFileSync(path.join(featureDir, 'task-packet-header.md'), options.headerPacket);
  }
  if (options.detailsPacket !== undefined) {
    writeFileSync(path.join(featureDir, 'task-packet-details.md'), options.detailsPacket);
  }
  if (options.selectedTask !== undefined) {
    writeFileSync(
      path.join(featureDir, 'selected-task.json'),
      typeof options.selectedTask === 'string'
        ? options.selectedTask
        : JSON.stringify(options.selectedTask, null, 2),
    );
  }
  // Ensure the feature dir is tracked even when no packet is provided so the
  // base commit isn't empty. Git ignores empty directories otherwise.
  writeFileSync(path.join(featureDir, '.gitkeep'), '');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed feature dir']);
  checkoutBranch(dir, workBranch);
  const diffFiles = options.diffFiles ?? {
    'src/alpha.ts': 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
  };
  for (const [rel, content] of Object.entries(diffFiles)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  commitAll(dir, 'work');
  return originalBranch;
}

function findScorer(
  tools: ToolDescriptor[],
  name: string,
): ToolDescriptor {
  const t = tools.find((d) => d.metadata.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

async function runScorer(
  tool: ToolDescriptor,
  params: unknown,
): Promise<WavemillToolResult<ReviewScoringDetails>> {
  const result = await tool.execute('call-1', params, undefined);
  return result as WavemillToolResult<ReviewScoringDetails>;
}

function parseEnvelope(result: WavemillToolResult<ReviewScoringDetails>): {
  eligibility: string;
  metrics?: Record<string, number>;
  diagnostics: string[];
  scorer: string;
  toolVersion: string;
  inputDigest: string;
  evidence: Array<{ ref: string; digest: string; bytes: number }>;
  advisory: boolean;
  rationale: string;
} {
  const text = result.content[0]!.text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Descriptor contract
// ---------------------------------------------------------------------------

describe('review-scoring — descriptor contract', () => {
  it('every tool is opt-in eval family, read-only, review-only, cert=read-only', () => {
    const dir = makeTempDir('review-scoring-contract-');
    const tools = createReviewScoringTools(dir);
    assert.equal(tools.length, 4);
    const names = tools.map((t) => t.metadata.name).sort();
    assert.deepEqual(names, [
      'score_diff_difficulty',
      'score_patch_selection',
      'score_success_rate_under_budget',
      'score_task_context',
    ]);
    for (const t of tools) {
      assert.equal(t.metadata.family, 'eval');
      assert.equal(t.metadata.exposure, 'opt-in');
      assert.equal(t.metadata.class, 'read-only');
      assert.deepEqual([...t.metadata.allowedPhases], ['review']);
      assert.equal(t.metadata.certificationRequirement, 'read-only');
      assert.equal(t.metadata.outputCapPolicy.strategy, 'truncate');
      assert.equal(t.metadata.outputCapPolicy.maxBytes, 32_768);
      assert.equal(t.metadata.policy?.network, 'deny');
      assert.equal(t.metadata.policy?.mutatesGit, false);
      assert.equal(t.metadata.policy?.mutatesExternalSystems, false);
      assert.ok(t.metadata.logicalId?.startsWith('eval.'));
    }
  });

  it('source module imports no persistence/orchestrator/network layers', () => {
    const src = readFileSync(
      path.resolve(
        __dirname_shim(),
        'review-scoring.ts',
      ),
      'utf8',
    );
    for (const forbidden of [
      'eval-persistence',
      'eval-orchestrator',
      'llm-cli',
      "'./linear",
      'router-adapter',
    ]) {
      assert.ok(
        !src.includes(forbidden),
        `review-scoring.ts must not import ${forbidden}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Exposure / eligibility gating
// ---------------------------------------------------------------------------

describe('review-scoring — exposure gating', () => {
  const cert = (level: NativeCertificationSnapshot['maxCertifiedPhase']): NativeCertificationSnapshot => ({
    maxCertifiedPhase: level,
  });

  it('is denied family_not_enabled when config omits the family', () => {
    const dir = makeTempDir('review-scoring-elig-');
    const registry = createToolRegistry(createReviewScoringTools(dir));
    const result = computeEligibility({
      phase: 'review',
      config: {},
      certification: cert('read-only'),
      registry: registry.list(),
    });
    assert.deepEqual([...result.eligibleNames], []);
    for (const d of result.denials) {
      if ('toolName' in d) {
        assert.equal(d.reason, 'family_not_enabled');
      }
    }
  });

  it('is denied phase_not_allowed for coding even if config lists coding', () => {
    const dir = makeTempDir('review-scoring-elig-');
    const registry = createToolRegistry(createReviewScoringTools(dir));
    const config: WavemillConfig = {
      nativeAgent: { advanced: { eval: { enabled: true, allowedPhases: ['coding', 'review'] } } },
    };
    const result = computeEligibility({
      phase: 'coding',
      config,
      certification: cert('workflow'),
      registry: registry.list(),
    });
    assert.deepEqual([...result.eligibleNames], []);
    const denials = result.denials.filter(
      (d) => 'toolName' in d && d.reason === 'phase_not_allowed',
    );
    assert.equal(denials.length, 4);
  });

  it('is denied certification_missing when snapshot is none', () => {
    const dir = makeTempDir('review-scoring-elig-');
    const registry = createToolRegistry(createReviewScoringTools(dir));
    const config: WavemillConfig = {
      nativeAgent: { advanced: { eval: { enabled: true, allowedPhases: ['review'] } } },
    };
    const result = computeEligibility({
      phase: 'review',
      config,
      certification: cert('none'),
      registry: registry.list(),
    });
    assert.deepEqual([...result.eligibleNames], []);
    for (const d of result.denials) {
      if ('toolName' in d) {
        assert.equal(d.reason, 'certification_missing');
      }
    }
  });

  it('grants the tools when config enables eval for review with read-only certification', () => {
    const dir = makeTempDir('review-scoring-elig-');
    const registry = createToolRegistry(createReviewScoringTools(dir));
    const config: WavemillConfig = {
      nativeAgent: { advanced: { eval: { enabled: true, allowedPhases: ['review'] } } },
    };
    const result = computeEligibility({
      phase: 'review',
      config,
      certification: cert('read-only'),
      registry: registry.list(),
    });
    assert.deepEqual(
      [...result.eligibleNames].sort(),
      [
        'score_diff_difficulty',
        'score_patch_selection',
        'score_success_rate_under_budget',
        'score_task_context',
      ],
    );
  });

  it('honors a logicalIds allowlist', () => {
    const dir = makeTempDir('review-scoring-elig-');
    const registry = createToolRegistry(createReviewScoringTools(dir));
    const config: WavemillConfig = {
      nativeAgent: {
        advanced: {
          eval: {
            enabled: true,
            allowedPhases: ['review'],
            logicalIds: ['eval.score_diff_difficulty'],
          },
        },
      },
    };
    const result = computeEligibility({
      phase: 'review',
      config,
      certification: cert('read-only'),
      registry: registry.list(),
    });
    assert.deepEqual([...result.eligibleNames], ['score_diff_difficulty']);
  });
});

// ---------------------------------------------------------------------------
// Byte-stability
// ---------------------------------------------------------------------------

describe('review-scoring — byte-stability', () => {
  it('score_diff_difficulty returns byte-identical output on repeat runs', async () => {
    const dir = makeTempDir('review-scoring-stab-');
    fillReviewWorktree(dir);
    process.env.WAVEMILL_REVIEW_BASE_BRANCH = 'main';
    const [diffTool] = createReviewScoringTools(dir);
    const first = await runScorer(diffTool!, {});
    const second = await runScorer(diffTool!, {});
    assert.equal(first.content[0]!.text, second.content[0]!.text);
    const env = parseEnvelope(first);
    assert.equal(env.eligibility, 'eligible');
    assert.ok(env.metrics && typeof env.metrics.loc_touched === 'number');
    assert.ok(env.evidence.length >= 1);
    delete process.env.WAVEMILL_REVIEW_BASE_BRANCH;
  });

  it('score_patch_selection is byte-stable across runs', async () => {
    const dir = makeTempDir('review-scoring-stab-');
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_patch_selection');
    const params = fixturePatchSelection();
    const first = await runScorer(tool, params);
    const second = await runScorer(tool, params);
    assert.equal(first.content[0]!.text, second.content[0]!.text);
  });
});

// ---------------------------------------------------------------------------
// Eligible / ineligible fixture behavior
// ---------------------------------------------------------------------------

describe('review-scoring — eligibility states', () => {
  it('score_diff_difficulty returns missing_evidence with no diff', async () => {
    const dir = makeTempDir('review-scoring-missing-');
    initGitRepo(dir, 'main');
    checkoutBranch(dir, 'task/empty');
    // No commits on branch → empty diff vs main.
    process.env.WAVEMILL_REVIEW_BASE_BRANCH = 'main';
    const [diffTool] = createReviewScoringTools(dir);
    const result = await runScorer(diffTool!, {});
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'missing_evidence');
    assert.equal(env.metrics, undefined);
    assert.ok(env.diagnostics.length >= 1);
    delete process.env.WAVEMILL_REVIEW_BASE_BRANCH;
  });

  it('score_task_context returns missing_evidence when no feature dir exists', async () => {
    const dir = makeTempDir('review-scoring-missing-');
    initGitRepo(dir, 'main');
    checkoutBranch(dir, 'task/x');
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_task_context');
    const result = await runScorer(tool, {});
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'missing_evidence');
    assert.equal(env.metrics, undefined);
  });

  it('score_task_context returns malformed_evidence for invalid selected-task JSON', async () => {
    const dir = makeTempDir('review-scoring-mal-');
    fillReviewWorktree(dir, {
      taskPacket: '# Objective\nFix things.\n',
      selectedTask: '{ not: json',
    });
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_task_context');
    const result = await runScorer(tool, { evidence: ['selected_task'] });
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'malformed_evidence');
    assert.equal(env.metrics, undefined);
    assert.ok(env.diagnostics.some((s) => s.startsWith('selected_task:')));
  });

  it('score_task_context returns conflicting_evidence for combined+split packets', async () => {
    const dir = makeTempDir('review-scoring-conflict-');
    fillReviewWorktree(dir, {
      taskPacket: '# Combined\n',
      headerPacket: '# Header\n',
      detailsPacket: '# Details\n',
      selectedTask: { title: 'x', description: 'y' },
    });
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_task_context');
    const result = await runScorer(tool, { evidence: ['task_packet'] });
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'conflicting_evidence');
    assert.equal(env.metrics, undefined);
  });

  it('score_task_context returns conflicting_evidence for multiple feature dirs', async () => {
    const dir = makeTempDir('review-scoring-conflict2-');
    initGitRepo(dir, 'main');
    mkdirSync(path.join(dir, 'features', 'a'), { recursive: true });
    mkdirSync(path.join(dir, 'features', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'features', 'a', 'task-packet.md'), 'A');
    writeFileSync(path.join(dir, 'features', 'b', 'task-packet.md'), 'B');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
    checkoutBranch(dir, 'task/x');
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_task_context');
    const result = await runScorer(tool, {});
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'conflicting_evidence');
  });

  it('score_task_context returns eligible with packet and selected task', async () => {
    const dir = makeTempDir('review-scoring-elig-');
    fillReviewWorktree(dir, {
      taskPacket: '# Objective\nBugfix for crash.\n',
      selectedTask: {
        title: 'Bug: fix crash',
        description: 'System crashes on load.',
        labels: ['bug'],
        identifier: 'HOK-999',
      },
    });
    const tools = createReviewScoringTools(dir);
    const tool = findScorer(tools, 'score_task_context');
    const result = await runScorer(tool, {});
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'eligible');
    assert.ok(env.diagnostics.includes('task_type: bugfix'));
    assert.equal(env.evidence.length, 2);
    const refs = env.evidence.map((e) => e.ref).sort();
    assert.deepEqual(refs, ['selected_task', 'task_packet']);
  });

  it('score_patch_selection returns malformed_evidence for a bad record', async () => {
    const dir = makeTempDir('review-scoring-mal2-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_patch_selection');
    const params = fixturePatchSelection();
    // Force a bad record (wrong type for instanceId).
    (params.records as Array<Record<string, unknown>>)[0]!.instanceId = 42;
    const result = await runScorer(tool, params);
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'malformed_evidence');
    assert.equal(env.metrics, undefined);
    assert.ok(env.diagnostics.some((s) => s.includes('records[0].instanceId')));
  });

  it('score_patch_selection returns oversized_evidence beyond 200 records', async () => {
    const dir = makeTempDir('review-scoring-over-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_patch_selection');
    const oneRecord = fixturePatchSelection().records[0]!;
    const params = {
      measurementPolicy: 'replay_exact_match' as const,
      records: Array.from({ length: 201 }, (_, i) => ({ ...oneRecord, instanceId: `id-${i}` })),
    };
    const result = await runScorer(tool, params);
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'oversized_evidence');
    assert.equal(env.metrics, undefined);
  });

  it('score_patch_selection returns conflicting_evidence for duplicate divergent instanceIds', async () => {
    const dir = makeTempDir('review-scoring-dup-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_patch_selection');
    const base = fixturePatchSelection().records[0]!;
    const params = {
      measurementPolicy: 'replay_exact_match' as const,
      records: [
        { ...base, selectedPatchOrId: 'good' },
        { ...base, selectedPatchOrId: 'bad' },
      ],
    };
    const result = await runScorer(tool, params);
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'conflicting_evidence');
  });

  it('score_patch_selection returns eligible + accuracy for valid records', async () => {
    const dir = makeTempDir('review-scoring-good-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_patch_selection');
    const params = fixturePatchSelection();
    const result = await runScorer(tool, params);
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'eligible');
    assert.ok(env.metrics && typeof env.metrics.patch_selection_accuracy === 'number');
    assert.equal(env.metrics!.patch_selection_accuracy, 1);
  });

  it('score_success_rate_under_budget returns eligible + rate', async () => {
    const dir = makeTempDir('review-scoring-rate-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_success_rate_under_budget');
    const result = await runScorer(tool, {
      measurementPolicy: 'challenge_prospective',
      records: [
        { route_valid: true, completed_successfully: true, actual_cost_usd: 1, max_cost_usd: 2 },
        { route_valid: true, completed_successfully: false, actual_cost_usd: 3, max_cost_usd: 1 },
      ],
    });
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'eligible');
    assert.equal(env.metrics!.workflow_success_rate_under_budget, 0.5);
  });

  it('score_success_rate_under_budget rejects unknown measurementPolicy', async () => {
    const dir = makeTempDir('review-scoring-badpolicy-');
    const tool = findScorer(createReviewScoringTools(dir), 'score_success_rate_under_budget');
    const result = await runScorer(tool, {
      measurementPolicy: 'not_a_policy',
      records: [],
    });
    const env = parseEnvelope(result);
    assert.equal(env.eligibility, 'malformed_evidence');
  });
});

// ---------------------------------------------------------------------------
// Redaction / secret hygiene
// ---------------------------------------------------------------------------

describe('review-scoring — redaction', () => {
  it('does not leak a planted secret from evidence into content or details', async () => {
    const dir = makeTempDir('review-scoring-red-');
    const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';
    fillReviewWorktree(dir, {
      taskPacket: `# Objective\nFix crash. TOKEN=${token}\n`,
      selectedTask: {
        title: `refactor with ${token}`,
        description: `token: ${token}`,
      },
    });
    const tool = findScorer(createReviewScoringTools(dir), 'score_task_context');
    const result = await runScorer(tool, {});
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes(token),
      'evidence secrets must not appear in the tool result',
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence guard
// ---------------------------------------------------------------------------

describe('review-scoring — persistence guard', () => {
  it('writes no .wavemill/evals or feature artifacts', async () => {
    const dir = makeTempDir('review-scoring-persist-');
    fillReviewWorktree(dir, {
      taskPacket: '# Objective\nFix issue.\n',
      selectedTask: { title: 't', description: 'd' },
    });
    process.env.WAVEMILL_REVIEW_BASE_BRANCH = 'main';
    const tools = createReviewScoringTools(dir);
    for (const t of tools) {
      const params =
        t.metadata.name === 'score_patch_selection'
          ? fixturePatchSelection()
          : t.metadata.name === 'score_success_rate_under_budget'
            ? {
                measurementPolicy: 'replay_exact_match',
                records: [
                  { route_valid: true, completed_successfully: true, actual_cost_usd: 1, max_cost_usd: 2 },
                ],
              }
            : {};
      await runScorer(t, params);
    }
    // Snapshot filesystem.
    const evalsDir = path.join(dir, '.wavemill', 'evals');
    let evalFiles: string[] = [];
    try {
      evalFiles = readdirSync(evalsDir);
    } catch {
      /* ok */
    }
    assert.deepEqual(evalFiles, []);
    delete process.env.WAVEMILL_REVIEW_BASE_BRANCH;
  });
});

// ---------------------------------------------------------------------------
// Provenance fields
// ---------------------------------------------------------------------------

describe('review-scoring — provenance', () => {
  it('every envelope carries scorer/toolVersion/inputDigest and advisory:true', async () => {
    const dir = makeTempDir('review-scoring-prov-');
    fillReviewWorktree(dir, {
      taskPacket: '# Objective\nFix.\n',
      selectedTask: { title: 't', description: 'd' },
    });
    const tools = createReviewScoringTools(dir);
    for (const t of tools) {
      const params =
        t.metadata.name === 'score_patch_selection'
          ? fixturePatchSelection()
          : t.metadata.name === 'score_success_rate_under_budget'
            ? {
                measurementPolicy: 'replay_exact_match',
                records: [
                  { route_valid: true, completed_successfully: true, actual_cost_usd: 1, max_cost_usd: 2 },
                ],
              }
            : {};
      const env = parseEnvelope(await runScorer(t, params));
      assert.ok(env.scorer.length > 0);
      assert.ok(env.toolVersion.startsWith('native-review.'));
      assert.ok(/^[0-9a-f]{64}$/.test(env.inputDigest));
      assert.equal(env.advisory, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixturePatchSelection() {
  const instance = {
    id: 'inst-1',
    taskTitle: 'title',
    taskDescription: 'desc',
    candidates: [
      { id: 'cand-good', patch: 'good-patch', patchSizeBytes: 10 },
      { id: 'cand-bad', patch: 'bad-patch', patchSizeBytes: 10 },
    ],
    knownGoodCandidateId: 'cand-good',
    knownBadCandidateIds: ['cand-bad'],
    source: { curationRationale: 'merged_winner', sanitized: true },
    heldOut: false,
    curatedAt: 0,
  };
  return {
    measurementPolicy: 'replay_exact_match' as const,
    records: [
      {
        instanceId: 'inst-1',
        selectedPatchOrId: 'cand-good',
        instance,
      },
    ],
  };
}

function __dirname_shim(): string {
  // Node 22 ESM sets import.meta.dirname; for TS test files, resolve from
  // the current module URL manually.
  const url = new URL(import.meta.url);
  return path.dirname(url.pathname);
}
