import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { buildWorkflowState } from '../../tests/lib/task-builder.ts';
import {
  ATTENTION_KIND_RANK,
  deriveAttentionItems,
  gatherAttentionInputs,
  openRouterWarningCachePath,
  parseEscalationBasis,
  readNonTaskAttentionInputs,
  writeAttentionProjection,
  type AttentionFreeItemInput,
  type AttentionIncidentInput,
  type AttentionInputs,
  type AttentionItem,
  type AttentionTaskInput,
} from './attention.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const PASS = NOW - 500;

let root: string;
let worktrees: string;
let stateDir: string;

function featureDir(slug: string): string {
  const dir = join(worktrees, slug, 'features', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, name: string, body: unknown): void {
  writeFileSync(join(dir, name), typeof body === 'string' ? body : `${JSON.stringify(body)}\n`);
}

function marker(basis: string, reason: string, headSha = 'a'.repeat(40), writtenAt = '2026-11-05T10:00:00Z') {
  return {
    schemaVersion: 1,
    kind: 'ready-attention',
    headSha,
    writtenAt,
    reason,
    detail: { escalationBasis: basis },
    condition: { head: headSha, expiresOn: ['head', 'operator-event'] },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** An approval request that passed the HOK-3253 inputs gate. */
function seedAwaitingPlan(fd: string): void {
  const packet = '# Task packet\nDo the thing.\n';
  write(fd, 'task-packet.md', packet);
  write(fd, 'plan.md', '# Plan\n');
  write(fd, '.planning-result.json', { status: 'awaiting_user' });
  write(fd, '.plan-packet-hash', { packetHash: sha256(packet), packetKind: 'single', source: 'preparation' });
}

function incident(fingerprint: string, taskId: string, knownIssueIds: string[]): AttentionIncidentInput['incident'] {
  return {
    fingerprint,
    taskId,
    summary: `incident ${fingerprint}`,
    operatorAction: 'inspect the eval job log',
    firstObservedAt: '2026-11-05T09:00:00Z',
    severity: 'high',
    lifecycle: 'active',
    metadata: { knownIssueIds },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attention-test-'));
  worktrees = join(root, 'worktrees');
  stateDir = join(root, '.wavemill');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const task = (slug: string, phase: string) => ({ slug, phase, worktree: join(worktrees, slug), branch: `task/${slug}` });

/**
 * One task per attention source in the HOK-3423 table, plus the inputs that
 * must NOT produce an item.
 */
function seedWorld(): void {
  const state = buildWorkflowState({
    'HOK-1': task('plan-awaiting', 'planning'),
    'HOK-2': task('plan-rejected', 'planning'),
    'HOK-3': task('coding-blocked', 'coding'),
    'HOK-4': task('review-escalated', 'review'),
    'HOK-5': task('ready-watchdog', 'ready'),
    'HOK-6': task('ready-exhausted', 'ready'),
    'HOK-7': task('coding-prompt', 'coding'),
    'HOK-8': task('coding-hook-error', 'coding'),
    'HOK-9': task('review-retryable', 'review'),
    'HOK-10': task('ready-watchdog-quiet', 'ready'),
    'HOK-11': task('coding-other', 'coding'),
  });
  writeFileSync(join(stateDir, 'workflow-state.json'), JSON.stringify(state));

  seedAwaitingPlan(featureDir('plan-awaiting'));
  write(featureDir('plan-rejected'), '.planning-rejected.json', {
    reason: 'planning_modified_out_of_scope_files',
    outOfScopeFiles: ['src/new-feature.ts'],
    notifiedAt: '2026-11-05T10:00:00Z',
  });
  write(featureDir('coding-blocked'), '.coding-blocked-completion.json', {
    summary: 'coding done; full verification blocked by Docker',
  });
  write(featureDir('review-escalated'), '.needs-attention',
    marker('operator-decision:operator-command-failed', 'Could not launch the manual re-review'));
  write(featureDir('ready-watchdog'), '.needs-attention',
    marker('operator-decision:merge-residue', 'Merge residue in the worktree'));
  write(featureDir('ready-exhausted'), '.needs-attention',
    marker('exhausted:stage-failure-ready', 'Ready failed 3 times; budget exhausted'));
  featureDir('coding-prompt');
  featureDir('coding-hook-error');
  // Retryable first occurrence: a failed stage result, no sentinel, no marker.
  write(featureDir('review-retryable'), '.review-result.json', { status: 'failed', failureCategory: 'native-review-timeout' });
  featureDir('ready-watchdog-quiet');
  featureDir('coding-other');

  writeFileSync(join(stateDir, 'ready-watchdog-state.json'), JSON.stringify({
    updatedAt: '2026-11-05T11:00:00Z',
    // allow-task-literal: ready-watchdog-state.json entries, not workflow-state task records
    tasks: {
      'HOK-5': { classification: 'needs-user', detail: 'Auto-update could not proceed for PR #5: conflict', recoveryCommand: 'git -C wt status', updatedAt: '2026-11-05T11:00:00Z' },
      // The watchdog's private transient counter does not page (HOK-3360).
      'HOK-10': { classification: 'needs-user', detail: 'Transient CI failure budget exhausted', updatedAt: '2026-11-05T11:00:00Z' },
    },
  }));
}

async function project(overrides: Partial<Parameters<typeof gatherAttentionInputs>[0]> = {}) {
  const inputs = await gatherAttentionInputs({
    repoDir: root,
    stateDir,
    session: 'attention-test',
    passStampMs: PASS,
    staleAfterMs: PASS + 70_000,
    nowMs: NOW,
    progressFor: (issue) => {
      if (issue === 'HOK-7') {
        return { agentState: 'working', agentRecord: null, blockingPrompt: { id: 'codex-approval', agent: 'codex', detail: 'approve the command in the pane' } };
      }
      if (issue === 'HOK-8') return { agentState: 'error', agentRecord: { state: 'error', event: 'StopFailure', agent: 'claude', timestamp: NOW / 1000 }, blockingPrompt: null };
      return null;
    },
    incidentsFor: async () => [
      { incident: incident('f'.repeat(64), 'HOK-3', ['HOK-11']), reconciliation: { outcome: 'confirmed_active' } },
      { incident: incident('e'.repeat(64), 'HOK-9', []), reconciliation: { outcome: 'recovered' } },
    ],
    ...overrides,
  });
  return deriveAttentionItems(inputs);
}

const byTask = (items: AttentionItem[], taskId: string) => items.filter((item) => item.taskId === taskId);

describe('deriveAttentionItems — one item per source (HOK-3423)', () => {
  it('produces exactly one item for each source and none for retryable or raw-hook inputs', async () => {
    // protects: the seven private inbox classifiers disagreeing — each source
    // must map to exactly one item, and a failure the policy still retries
    // (raw hook error, first occurrence, a non-paging watchdog row) to none.
    seedWorld();
    const { items } = await project();
    assert.deepEqual(
      items.map((item) => [item.kind, item.taskId ?? item.incidentId]),
      [
        ['approve-plan', 'HOK-1'],
        ['approve-plan', 'HOK-2'],
        ['answer-agent', 'HOK-7'],
        ['resolve-blocked-completion', 'HOK-3'],
        ['operator-decision', 'HOK-4'],
        ['operator-decision', 'HOK-5'],
        ['exhausted', 'HOK-6'],
        ['incident', 'f'.repeat(64)],
      ],
    );
    for (const quiet of ['HOK-8', 'HOK-9', 'HOK-10', 'HOK-11']) {
      assert.deepEqual(byTask(items, quiet), [], `${quiet} must not be in the inbox`);
    }
  });

  it('groups a confirmed_active incident under one item listing every affected task', async () => {
    // protects: one incident affecting two tasks becoming two inbox rows.
    seedWorld();
    const incidentItems = (await project()).items.filter((item) => item.kind === 'incident');
    assert.equal(incidentItems.length, 1);
    assert.deepEqual(incidentItems[0].affectedTaskIds, ['HOK-11', 'HOK-3']);
    assert.equal(incidentItems[0].id, `incident:${'f'.repeat(64)}`);
  });

  it('carries the row text the dashboard used to compute privately', async () => {
    // protects: moving the detail readers into evidence extraction changing
    // what the operator reads in the inbox row.
    seedWorld();
    const { items } = await project();
    const get = (taskId: string) => byTask(items, taskId)[0];
    assert.equal(get('HOK-1').summary, 'Plan ready — waiting for approval');
    assert.equal(
      get('HOK-2').summary,
      'Planning needs attention: edited src/new-feature.ts; reverted. Review plan.md and re-approve. Agent notified.',
    );
    assert.equal(
      get('HOK-3').summary,
      'HOK-3 needs attention: coding done; full verification blocked by Docker. Type "advance HOK-3" to launch review.',
    );
    assert.deepEqual(get('HOK-3').commands.map((c) => c.argv), [['advance', 'HOK-3']]);
    assert.equal(get('HOK-5').decisionCode, 'merge-residue');
    assert.deepEqual(
      get('HOK-5').evidence.map((e) => e.source),
      ['.needs-attention', 'ready-watchdog-state.json'],
    );
    assert.equal(get('HOK-6').bucket, 'stage-failure-ready');
    assert.deepEqual(get('HOK-6').condition, { head: 'a'.repeat(40), expiresOn: ['head', 'operator-event'] });
  });

  it('uses the uncommitted-output artifact and skips an auto-advanced blocked completion', async () => {
    // protects: the HOK-2894 uncommitted-output handoff and the auto-advance
    // suppression that coding_blocked_completion_detail encoded.
    writeFileSync(join(stateDir, 'workflow-state.json'), JSON.stringify(buildWorkflowState({
      'HOK-20': task('uncommitted', 'coding'),
      'HOK-21': task('auto-advanced', 'coding'),
    })));
    write(featureDir('uncommitted'), '.coding-uncommitted-output.json', { summary: 'coding output not committed', action: 'Commit it, then retry review.' });
    const auto = featureDir('auto-advanced');
    write(auto, '.coding-blocked-completion.json', { summary: 'blocked' });
    write(auto, '.coding-auto-advance.json', { at: 'now' });
    const { items } = await project({ incidentsFor: async () => [] });
    assert.deepEqual(items.map((item) => [item.taskId, item.summary]), [
      ['HOK-20', 'HOK-20 needs attention: coding output not committed. Commit it, then retry review.'],
    ]);
  });
});

describe('deriveAttentionItems — blocked-completion row text', () => {
  const summaryFor = (blocked: { summary: string | null; atMs: number }) => deriveAttentionItems({
    passStampMs: PASS, staleAfterMs: PASS, nowMs: NOW, incidents: [],
    tasks: [{
      taskId: 'HOK-1642',
      task: { slug: 'c', phase: 'coding', status: 'active', worktree: '/wt', windowId: undefined },
      featureDir: '/wt/features/c', progress: null, needsAttention: null, planning: null, readyWatchdog: null,
      blockedCompletion: { autoAdvanced: false, uncommitted: null, blocked },
    }],
  }).items[0].summary;

  it('falls back to the generic summary and truncates long summaries at 80 characters', () => {
    // protects: the coding_blocked_completion_detail text contract moving into
    // the projection (fallback summary, 77+"..." truncation).
    assert.equal(summaryFor({ summary: null, atMs: 1 }),
      'HOK-1642 needs attention: coding done; verification blocked. Type "advance HOK-1642" to launch review.');
    assert.equal(summaryFor({ summary: 'x'.repeat(120), atMs: 1 }),
      `HOK-1642 needs attention: ${'x'.repeat(77)}.... Type "advance HOK-1642" to launch review.`);
    assert.equal(summaryFor({ summary: 'coding blocked: Codex model at capacity', atMs: 1 }),
      'HOK-1642 needs attention: coding blocked: Codex model at capacity. Type "advance HOK-1642" to launch review.');
  });
});

describe('deriveAttentionItems — conditions expire items without a clear call', () => {
  it('drops approve-plan once the operator approves, and when the packet changes under the binding', async () => {
    // protects: a plan approval item outliving its condition (HOK-2916 latch
    // shape) — approval (operator event) and a regenerated packet (HOK-3253).
    seedWorld();
    const fd = join(worktrees, 'plan-awaiting', 'features', 'plan-awaiting');
    assert.equal(byTask((await project()).items, 'HOK-1').length, 1);

    write(fd, 'task-packet.md', '# Task packet\nRegenerated.\n');
    assert.deepEqual(byTask((await project()).items, 'HOK-1'), []);

    seedAwaitingPlan(fd);
    write(fd, '.plan-approved', '');
    assert.deepEqual(byTask((await project()).items, 'HOK-1'), []);
  });

  it('drops an escalation item once the reconciler has expired its marker (new head)', async () => {
    // protects: the inbox holding an escalation after HOK-3172 expired it —
    // the next projection simply finds no marker.
    seedWorld();
    assert.equal(byTask((await project()).items, 'HOK-6').length, 1);
    rmSync(join(worktrees, 'ready-exhausted', 'features', 'ready-exhausted', '.needs-attention'));
    assert.deepEqual(byTask((await project()).items, 'HOK-6'), []);
  });

  it('ignores a marker without an escalation basis and an unknown operator-decision code', async () => {
    // protects: paging on a marker the HOK-3360 escalation step did not write.
    writeFileSync(join(stateDir, 'workflow-state.json'), JSON.stringify(buildWorkflowState({
      'HOK-30': task('legacy-marker', 'ready'),
      'HOK-31': task('unknown-code', 'ready'),
    })));
    write(featureDir('legacy-marker'), '.needs-attention', 'Ready failed\n');
    write(featureDir('unknown-code'), '.needs-attention', marker('operator-decision:not-a-code', 'invented'));
    assert.deepEqual((await project({ incidentsFor: async () => [] })).items, []);
  });
});

function pureTask(taskId: string, overrides: Partial<AttentionTaskInput> = {}): AttentionTaskInput {
  return {
    taskId,
    task: { slug: taskId.toLowerCase(), phase: 'ready', status: 'active', worktree: '/wt', windowId: undefined },
    featureDir: `/wt/features/${taskId.toLowerCase()}`,
    progress: null,
    needsAttention: null,
    planning: null,
    blockedCompletion: null,
    readyWatchdog: null,
    ...overrides,
  };
}

function escalated(taskId: string, basis: string, writtenAt: string): AttentionTaskInput {
  return pureTask(taskId, { needsAttention: { payload: { ...marker(basis, `${taskId} ${basis}`), writtenAt } as never } });
}

describe('deriveAttentionItems — fixed precedence', () => {
  it('orders by kind precedence, then age, then id', () => {
    // protects: each renderer ordering the inbox its own way.
    const inputs: AttentionInputs = {
      passStampMs: PASS,
      staleAfterMs: PASS + 1,
      nowMs: NOW,
      tasks: [
        escalated('HOK-50', 'policy-terminal:terminal', '2026-11-05T08:00:00Z'),
        escalated('HOK-51', 'exhausted:stage-failure-review', '2026-11-05T09:00:00Z'),
        escalated('HOK-53', 'exhausted:stage-failure-ready', '2026-11-05T07:00:00Z'),
        escalated('HOK-52', 'exhausted:stage-failure-ready', '2026-11-05T07:00:00Z'),
        escalated('HOK-54', 'operator-decision:merge-residue', '2026-11-05T11:00:00Z'),
        pureTask('HOK-55', {
          task: { slug: 'c', phase: 'coding', status: 'active', worktree: '/wt', windowId: '@9' },
          blockedCompletion: { autoAdvanced: false, uncommitted: null, blocked: { summary: 'x', atMs: NOW - 10 } },
        }),
        pureTask('HOK-56', { progress: { agentState: 'approval-needed', agentRecord: null, blockingPrompt: null } }),
      ],
      incidents: [{ incident: incident('a'.repeat(64), 'HOK-50', []), reconciliation: { outcome: 'confirmed_active' } }],
    };
    const projection = deriveAttentionItems(inputs);
    assert.deepEqual(projection.items.map((item) => item.taskId ?? 'incident'), [
      'HOK-56', 'HOK-55', 'HOK-54', 'HOK-52', 'HOK-53', 'HOK-51', 'HOK-50', 'incident',
    ]);
    assert.equal(projection.items[6].kind, 'policy-terminal');
    assert.equal(projection.items[1].paneTarget, '@9');
    assert.deepEqual(Object.keys(ATTENTION_KIND_RANK), [
      'approve-plan', 'answer-agent', 'resolve-blocked-completion', 'operator-decision', 'exhausted', 'policy-terminal', 'incident',
      'queue-health', 'backstage-health', 'openrouter', 'malformed-challenge',
    ]);
  });

  it('suppresses a superseded ready-gate refusal while the relaunched agent works', () => {
    // protects: the HOK-2915 stale "Review verdict does not pass readiness
    // gate" marker pinning the inbox while review is running again.
    const working = { agentState: 'working' as const, agentRecord: null, blockingPrompt: null };
    const item = (agent: AttentionTaskInput['progress']) => deriveAttentionItems({
      passStampMs: PASS, staleAfterMs: PASS, nowMs: NOW, incidents: [],
      tasks: [pureTask('HOK-60', {
        task: { slug: 's', phase: 'review', status: 'active', worktree: '/wt', windowId: undefined },
        progress: agent,
        needsAttention: { payload: marker('policy-terminal:terminal', 'Review verdict does not pass readiness gate: blocked') as never },
      })],
    }).items;
    assert.deepEqual(item(working), []);
    assert.equal(item(null).length, 1);
  });

  it('parses only the three HOK-3360 escalation bases', () => {
    assert.deepEqual(parseEscalationBasis('exhausted:stage-failure-ready'), { kind: 'exhausted', arg: 'stage-failure-ready' });
    assert.deepEqual(parseEscalationBasis('policy-terminal:terminal'), { kind: 'policy-terminal', arg: 'terminal' });
    assert.equal(parseEscalationBasis('retryable:x'), null);
    assert.equal(parseEscalationBasis('exhausted:'), null);
    assert.equal(parseEscalationBasis(undefined), null);
  });
});

describe('deriveAttentionItems — non-task signals are free items (HOK-3424)', () => {
  const free = (kind: AttentionFreeItemInput['kind'], key: string, sinceMs: number): AttentionFreeItemInput => ({
    kind,
    key,
    summary: `${kind} ${key}`,
    sinceMs,
    evidence: [{ source: `${kind}.json`, summary: key }],
  });

  it('sorts free items after incidents, by kind precedence, with no taskId', () => {
    // protects: a free item appearing as task-owned work (the Observer's push
    // is task-scoped and must never claim it) or jumping the queue ahead of a
    // task blocked on a human.
    const projection = deriveAttentionItems({
      passStampMs: PASS,
      staleAfterMs: PASS + 1,
      nowMs: NOW,
      tasks: [escalated('HOK-70', 'exhausted:stage-failure-ready', '2026-11-05T11:00:00Z')],
      incidents: [{ incident: incident('a'.repeat(64), 'HOK-71', []), reconciliation: { outcome: 'confirmed_active' } }],
      freeItems: [
        free('openrouter', 'credits-exhausted', NOW - 10),
        free('malformed-challenge', 'HOK-80_c', NOW - 20),
        free('backstage-health', 'tend', NOW - 30),
        free('queue-health', 'degraded-inference', NOW - 40),
      ],
    });
    assert.deepEqual(projection.items.map((item) => item.kind), [
      'exhausted', 'incident', 'queue-health', 'backstage-health', 'openrouter', 'malformed-challenge',
    ]);
    for (const item of projection.items.filter((entry) => (ATTENTION_KIND_RANK[entry.kind] ?? 0) >= 7)) {
      assert.equal(item.taskId, undefined);
      assert.equal(item.id, `${item.kind}:${item.summary.split(' ')[1]}`);
    }
  });

  it('reads the four signals from the one file each already owns', () => {
    // protects: the dashboard header readers coming back — queue health,
    // backstage health, the OpenRouter cache and malformed challenge stubs
    // each have exactly one reader and it is here.
    const session = `attention-free-${process.pid}-${Date.now()}`;
    const warnPath = openRouterWarningCachePath(session);
    try {
      write(stateDir, 'queue-health.json', {
        currentAlertProjection: {
          status: 'degraded-inference',
          summary: 'Queue inference failing: 3 consecutive attempts',
          nextAction: 'use_explicit_edges_only',
          episode: { startedAt: '2026-11-05T10:00:00Z' },
        },
      });
      write(stateDir, 'backstage-health.json', {
        services: { tend: { status: 'degraded' }, observer: { status: 'healthy', progressState: 'stalled' } },
      });
      writeFileSync(warnPath,
        '\nOpenRouter credits exhausted - challenge coverage disabled, top up at https://openrouter.ai/credits\n');
      const state = buildWorkflowState({
        'HOK-80_c': { challengePairId: 'pair-80', challengeRole: 'challenger' },
      }, { bare: true });

      const inputs = readNonTaskAttentionInputs({ stateDir, session, state });
      assert.deepEqual(inputs.map((input) => input.kind), [
        'queue-health', 'backstage-health', 'openrouter', 'malformed-challenge',
      ]);
      assert.equal(inputs[0].summary, 'Queue inference failing: 3 consecutive attempts');
      assert.equal(inputs[0].sinceMs, Date.parse('2026-11-05T10:00:00Z'));
      assert.equal(inputs[1].summary, 'backstage unhealthy — tend: degraded │ observer: alive-not-progressing');
      assert.equal(inputs[2].summary,
        'OpenRouter credits exhausted - challenge coverage disabled, top up at https://openrouter.ai/credits');
      assert.equal(inputs[3].summary,
        'challenge pair entry HOK-80_c has no slug: arm is hidden but may still be running; repair state (HOK-2926)');
      assert.deepEqual(inputs[3].affectedTaskIds, ['HOK-80_c']);

      const projection = deriveAttentionItems({
        passStampMs: PASS,
        staleAfterMs: PASS + 1,
        nowMs: NOW,
        tasks: [],
        incidents: [],
        freeItems: inputs,
      });
      assert.deepEqual(projection.items.map((item) => item.id), [
        'queue-health:degraded-inference',
        'backstage-health:tend,observer',
        `openrouter:${createHash('sha256').update(inputs[2].summary).digest('hex').slice(0, 12)}`,
        'malformed-challenge:HOK-80_c',
      ]);
    } finally {
      rmSync(warnPath, { force: true });
    }
  });

  it('reports nothing when the four signals are healthy or absent', () => {
    // protects: healthy services paging the operator, and a missing
    // queue-health.json read as degradation.
    const session = `attention-free-quiet-${process.pid}-${Date.now()}`;
    const warnPath = openRouterWarningCachePath(session);
    rmSync(warnPath, { force: true });
    write(stateDir, 'queue-health.json', { status: 'healthy' });
    write(stateDir, 'backstage-health.json', {
      services: { tend: { status: 'healthy' }, observer: { status: 'disabled' } },
    });
    assert.deepEqual(
      readNonTaskAttentionInputs({ stateDir, session, state: buildWorkflowState({}) }),
      [],
    );
  });
});

describe('writeAttentionProjection', () => {
  it('stamps the pass and stale deadline the readers compare against', () => {
    // protects: a reader showing "nothing needs you" from a projection it
    // cannot date.
    const out = join(root, '.wavemill', 'attention.json');
    writeAttentionProjection(out, deriveAttentionItems({ passStampMs: PASS, staleAfterMs: PASS + 70_000, nowMs: NOW, tasks: [], incidents: [] }));
    const written = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.passStampMs, PASS);
    assert.equal(written.staleAfterMs, PASS + 70_000);
    assert.deepEqual(written.items, []);
  });
});
