import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LinearIssue } from './linear.ts';
import type { CreateIssuesResult, IssueCreationSpec } from './plan-decomposer.ts';
import {
  SIZE_OVERRIDE_LABEL,
  SIZE_OVERRIDE_LOG,
  SPLIT_LABEL,
  TaskSplitError,
  acceptSplitProposal,
  overrideSizeHold,
  type TaskSplitDeps,
} from './task-split.ts';
import {
  evaluateTaskSize,
  parseSizeSection,
  renderSizeSection,
  type TaskSizeEstimate,
  type TaskSizeLimits,
  type TaskSizeSlice,
} from './task-size.ts';

const limits: TaskSizeLimits = {
  enabled: true,
  maxAddedLines: 800,
  maxFiles: 12,
  coreFiles: ['shared/lib/wavemill-monitor.sh'],
  anchorCoreFile: 'shared/lib/wavemill-monitor.sh',
  maxCoreCompanions: 2,
};

const estimate: TaskSizeEstimate = {
  addedLines: 1200,
  files: ['shared/lib/a.ts', 'shared/lib/b.ts'],
  coreFiles: [],
  linesSource: 'llm',
};

const slices: TaskSizeSlice[] = [
  { title: 'Slice A', scope: 'First half.', files: ['shared/lib/a.ts'], estimatedAddedLines: 400 },
  { title: 'Slice B', scope: 'Second half.', files: ['shared/lib/b.ts'], estimatedAddedLines: 500 },
  { title: 'Slice C', scope: 'Wire it up.', files: [], estimatedAddedLines: 300 },
];

/** An oversized packet description with a trailing footer, as expansion writes it. */
function oversizedDescription(): string {
  const verdict = evaluateTaskSize(estimate, limits);
  return `${renderSizeSection(estimate, verdict, slices)}\n\nGenerated with [Claude Code](https://claude.com/claude-code)`;
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'uuid-parent',
    identifier: 'HOK-500',
    title: 'Big task',
    description: oversizedDescription(),
    state: { id: 'state-1', name: 'Backlog' },
    labels: { nodes: [{ id: 'lbl-feature', name: 'feature' }] },
    team: { id: 'team-1', name: 'Hokusai', key: 'HOK' },
    project: { id: 'proj-1', name: 'Wavemill' },
    priority: 2,
    ...overrides,
  };
}

interface Recorded {
  specs?: IssueCreationSpec[];
  options?: Parameters<TaskSplitDeps['createIssuesWithDependencies']>[1];
  labelIds?: string[];
  description?: string;
  comment?: string;
}

function fakeDeps(issue: LinearIssue, recorded: Recorded, createdIds = ['HOK-501', 'HOK-502', 'HOK-503']): Partial<TaskSplitDeps> {
  return {
    getIssue: async () => issue,
    createIssuesWithDependencies: async (specs, options): Promise<CreateIssuesResult> => {
      recorded.specs = specs;
      recorded.options = options;
      return {
        specs,
        created: createdIds.map((identifier, index) => ({
          id: `uuid-${index + 1}`,
          identifier,
          title: specs[index]?.title ?? identifier,
        })),
      };
    },
    getOrCreateLabel: async (name) => ({ id: `lbl-${name}`, name }),
    addLabelsToIssue: async (_issueId, labelIds) => {
      recorded.labelIds = labelIds;
      return { success: true };
    },
    updateIssue: async (_issueId, input) => {
      recorded.description = input.description;
      return { success: true };
    },
    createComment: async (_issueId, body) => {
      recorded.comment = body;
      return {};
    },
  };
}

describe('acceptSplitProposal', () => {
  // protects: accepting slices must create ordered sub-issues, inherit labels, and record what the parent became
  it('creates ordered slice sub-issues and records the accepted IDs', async () => {
    const recorded: Recorded = {};
    const result = await acceptSplitProposal('HOK-500', { deps: fakeDeps(makeIssue(), recorded) });

    assert.deepEqual(result.parent, { id: 'uuid-parent', identifier: 'HOK-500', title: 'Big task' });
    assert.deepEqual(result.created.map((child) => child.identifier), ['HOK-501', 'HOK-502', 'HOK-503']);

    const specs = recorded.specs!;
    assert.equal(specs.length, 3);
    assert.deepEqual(specs.map((spec) => spec.title), ['Slice A', 'Slice B', 'Slice C']);
    assert.deepEqual(specs.map((spec) => spec.blockedBy ?? []), [[], [0], [1]]);
    assert.deepEqual(specs.map((spec) => spec.labelIds), [['lbl-feature'], ['lbl-feature'], ['lbl-feature']]);
    assert.equal(specs[0].priority, 2);
    assert.match(specs[0].description, /Part of HOK-500/);
    assert.equal(recorded.options!.teamId, 'team-1');
    assert.equal(recorded.options!.projectId, 'proj-1');

    // Parent is labelled wm:split (keeping its existing labels) and §12 now
    // names the created slices while preserving the packet's trailing footer.
    assert.deepEqual(recorded.labelIds, ['lbl-feature', `lbl-${SPLIT_LABEL}`]);
    const parsed = parseSizeSection(recorded.description!);
    assert.deepEqual(parsed!.accepted, ['HOK-501', 'HOK-502', 'HOK-503']);
    assert.match(recorded.description!, /claude\.com\/claude-code/);
    assert.match(recorded.comment!, /HOK-501, HOK-502, HOK-503/);
  });

  // protects: slices inherit the parent's operator hold and can never launch,
  // even though the operator split the task to proceed.
  it('does not inherit launch-state labels', async () => {
    const recorded: Recorded = {};
    const issue = makeIssue({
      labels: {
        nodes: [
          { id: 'lbl-feature', name: 'feature' },
          { id: 'lbl-hold', name: 'wm:hold' },
        ],
      },
    });
    await acceptSplitProposal('HOK-500', { deps: fakeDeps(issue, recorded) });
    assert.deepEqual(recorded.specs!.map((spec) => spec.labelIds), [['lbl-feature'], ['lbl-feature'], ['lbl-feature']]);
  });

  // protects: a second accept must not create a duplicate set of sub-issues
  it('refuses when the task is already split', async () => {
    const recorded: Recorded = {};
    const issue = makeIssue({
      labels: { nodes: [{ id: 'lbl-feature', name: 'feature' }, { id: 'lbl-split', name: SPLIT_LABEL }] },
    });
    await assert.rejects(
      acceptSplitProposal('HOK-500', { deps: fakeDeps(issue, recorded) }),
      (error: Error) => error instanceof TaskSplitError && /already split/.test(error.message),
    );
    assert.equal(recorded.specs, undefined);
  });

  // protects: a task with no recorded estimate is never silently split into nothing
  it('refuses when the packet has no size estimate', async () => {
    const recorded: Recorded = {};
    const issue = makeIssue({ description: 'Just a plain task packet.' });
    await assert.rejects(
      acceptSplitProposal('HOK-500', { deps: fakeDeps(issue, recorded) }),
      (error: Error) => error instanceof TaskSplitError && /no recorded size estimate/.test(error.message),
    );
    assert.equal(recorded.specs, undefined);
  });

  // protects: a failed slice proposal surfaces the remedy instead of creating zero sub-issues
  it('refuses when no slices were proposed', async () => {
    const recorded: Recorded = {};
    const verdict = evaluateTaskSize(estimate, limits);
    const description = `${renderSizeSection(estimate, verdict, [], { slicesUnavailable: true })}\n`;
    await assert.rejects(
      acceptSplitProposal('HOK-500', { deps: fakeDeps(makeIssue({ description }), recorded) }),
      (error: Error) => error instanceof TaskSplitError && /no proposed slices/.test(error.message),
    );
    assert.equal(recorded.specs, undefined);
  });

  // protects: a single proposed slice is not a split
  it('refuses a proposal with fewer than two slices', async () => {
    const recorded: Recorded = {};
    const verdict = evaluateTaskSize(estimate, limits);
    const oneSlice = renderSizeSection(estimate, verdict, [slices[0]]);
    await assert.rejects(
      acceptSplitProposal('HOK-500', { deps: fakeDeps(makeIssue({ description: oneSlice }), recorded) }),
      (error: Error) => error instanceof TaskSplitError && /no proposed slices/.test(error.message),
    );
  });
});

describe('overrideSizeHold', () => {
  // protects: the override is recorded in Linear and in the audit log, with a reason
  it('labels the task and appends one audit row', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'wavemill-size-override-'));
    const recorded: Recorded = {};
    const result = await overrideSizeHold('HOK-500', 'stale estimate', {
      repoDir,
      deps: fakeDeps(makeIssue(), recorded),
      now: () => new Date('2026-11-11T12:00:00Z'),
    });

    assert.equal(result.labelAdded, true);
    assert.deepEqual(recorded.labelIds, ['lbl-feature', `lbl-${SIZE_OVERRIDE_LABEL}`]);
    assert.match(recorded.comment!, /stale estimate/);

    const logPath = path.join(repoDir, SIZE_OVERRIDE_LOG);
    assert.ok(existsSync(logPath));
    const rows = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].issue, 'HOK-500');
    assert.equal(rows[0].reason, 'stale estimate');
    assert.equal(rows[0].at, '2026-11-11T12:00:00.000Z');
    assert.equal(rows[0].estimatedLines, 1200);
    assert.equal(rows[0].oversized, true);
  });

  // protects: an already-overridden task is not re-labelled, re-commented or double-logged
  it('is idempotent when the override label is already present', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'wavemill-size-override-'));
    const recorded: Recorded = {};
    const issue = makeIssue({
      labels: { nodes: [{ id: `lbl-${SIZE_OVERRIDE_LABEL}`, name: SIZE_OVERRIDE_LABEL }] },
    });
    const result = await overrideSizeHold('HOK-500', 'again', { repoDir, deps: fakeDeps(issue, recorded) });

    assert.equal(result.labelAdded, false);
    assert.equal(recorded.labelIds, undefined);
    assert.equal(recorded.comment, undefined);
    assert.equal(existsSync(path.join(repoDir, SIZE_OVERRIDE_LOG)), false);
  });

  // protects: an override on a split parent records a release that can never
  // take effect, so the operator believes the parent will launch.
  it('refuses a parent that is already split', async () => {
    const issue = makeIssue({
      labels: { nodes: [{ id: 'lbl-split', name: SPLIT_LABEL }] },
    });
    await assert.rejects(
      overrideSizeHold('HOK-500', 'launch it anyway', { deps: fakeDeps(issue, {}) }),
      (error: Error) => error instanceof TaskSplitError && /already split/.test(error.message),
    );
  });

  // protects: an override without a reason cannot be audited, so it is refused
  it('requires a reason', async () => {
    await assert.rejects(
      overrideSizeHold('HOK-500', '   ', { deps: fakeDeps(makeIssue(), {}) }),
      (error: Error) => error instanceof TaskSplitError && /needs a reason/.test(error.message),
    );
  });
});
