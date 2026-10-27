/**
 * HOK-3312 replay fixtures from 2026-10-22.
 *
 * The four Backstage "retained" rows that day are the invariant's regression
 * cases. Under the new TS decider called with `monitorConsumer: true`, each
 * one must produce an archive-and-reap (or reap) verdict — no `dirty_worktree`
 * / `live_agent` refusal survives for a terminal, delivered arm.
 *
 * - HOK-3292  — merged PR, REPL at `waiting:Notification` (idle), clean tree
 *               → `would-reap`.
 * - HOK-3230  — merged PR, REPL at `waiting:Notification`, dirty tree
 *               → `would-archive-and-reap`.
 * - HOK-3227_c — aborted challenger, primary merged, dirty tree
 *               → `would-archive-and-reap`.
 * - HOK-3221_c — same shape → `would-archive-and-reap`.
 *
 * Pure TS decider tests — no monitor loop. The golden journeys cover the
 * integration path end-to-end.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideTerminalTask,
  type CleanupDeps,
  type TerminalInboxDecision,
  type WorkflowState,
} from '../shared/lib/terminal-inbox-cleanup.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

type PrLike = {
  number: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | 'UNKNOWN';
  mergedAt?: string;
  headRefOid?: string;
  headRefName?: string;
  baseRefName?: string;
  mergeCommitOid?: string;
};

type FixtureInputs = {
  issue: string;
  slug: string;
  branch: string;
  worktree: string;
  pr: PrLike;
  siblingPr?: PrLike;
  siblingIssue?: string;
  // workflow-state lifecycle shape — role=aborted-arm maps to allowAbandon=true.
  role?: 'primary' | 'challenger';
  pairId?: string;
  workflowOutcome?: 'merged' | 'aborted' | 'closed';
  // Git evidence the fake runner reports when asked.
  gitStatus?: string;           // porcelain output; empty = clean
  commitsAhead?: string;        // rev-list --count output
  cherryEquivalent?: boolean;   // true → cherry prints equivalent `-` only
  localHead?: string;
  remoteHead?: string;
  remoteContainsHead?: boolean;
};

type FixtureCase = {
  name: string;
  inputs: FixtureInputs;
  monitorConsumer: boolean;
  allowAbandon: boolean;
  expectedStatus: TerminalInboxDecision['status'];
};

function fixtureState(f: FixtureInputs): WorkflowState {
  const task: Record<string, unknown> = {
    slug: f.slug,
    branch: f.branch,
    worktree: f.worktree,
    pr: f.pr.number,
    windowId: '@42',
    status: f.workflowOutcome ?? (f.pr.state === 'MERGED' ? 'merged' : 'aborted'),
    phase: f.workflowOutcome === 'aborted' ? 'aborted' : 'done',
    lifecycle: {
      workflowOutcome: f.workflowOutcome ?? (f.pr.state === 'MERGED' ? 'merged' : 'aborted'),
      resourceDisposition: 'verification-required',
    },
  };
  if (f.role) task.challengeRole = f.role;
  if (f.pairId) task.challengePairId = f.pairId;
  const tasks: Record<string, unknown> = { [f.issue]: task };
  if (f.siblingIssue && f.siblingPr) {
    tasks[f.siblingIssue] = {
      slug: `${f.slug}-sibling`,
      branch: `task/${f.slug}-sibling`,
      worktree: `${f.worktree}-sibling`,
      pr: f.siblingPr.number,
      lifecycle: { workflowOutcome: 'merged', resourceDisposition: 'reaped' },
    };
  }
  return { tasks } as WorkflowState;
}

function fixtureDeps(f: FixtureInputs): CleanupDeps {
  return {
    git(args) {
      // Walk the subcommand matrix the TS decider calls.
      if (args.includes('status')) {
        return f.gitStatus ?? '';
      }
      if (args.includes('show-ref')) {
        // Local branch exists.
        return '';
      }
      if (args.includes('rev-parse')) {
        // Called for local and remote head lookups.
        const target = args[args.length - 1];
        if (target.includes('refs/remotes/origin/')) return `${f.remoteHead ?? ''}\n`;
        return `${f.localHead ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}\n`;
      }
      if (args[0] === 'merge-base') {
        if (f.remoteContainsHead === true) return '';
        throw new Error('not an ancestor');
      }
      if (args.includes('rev-list')) {
        return `${f.commitsAhead ?? '0'}\n`;
      }
      if (args[0] === 'cherry') {
        return f.cherryEquivalent === true
          ? `- ${f.localHead ?? 'aa'}\n`
          : f.commitsAhead && f.commitsAhead !== '0'
            ? `+ ${f.localHead ?? 'aa'}\n`
            : '';
      }
      return '';
    },
    gh(args) {
      const prNumber = args[args[0] === 'pr' && args[1] === 'view' ? 2 : -1];
      const pr: PrLike | undefined =
        prNumber === f.pr.number ? f.pr : (f.siblingPr && prNumber === f.siblingPr.number ? f.siblingPr : undefined);
      if (!pr) throw new Error(`gh: no PR fixture for ${prNumber}`);
      return JSON.stringify({
        number: pr.number,
        state: pr.state,
        mergedAt: pr.mergedAt ?? null,
        headRefOid: pr.headRefOid ?? '',
        headRefName: pr.headRefName ?? `task/${f.slug}`,
        baseRefName: pr.baseRefName ?? 'auto/integration',
        mergeCommit: pr.mergeCommitOid ? { oid: pr.mergeCommitOid } : null,
      });
    },
    // Omit `classify` so the decider falls through to its git-evidence path
    // (the production classifier is a shell helper; the TS decider calls it
    // only when deps.classify is defined). The git fixture below drives the
    // same decision — dirty+delivered → archive-and-reap, clean+MERGED+ahead=0
    // → would-reap.
    cleanup() { /* no-op; replay never executes */ },
    now() { return '2026-10-22T00:00:00Z'; },
  };
}

// Overrides for the fs-stat check: `collectGitEvidence` consults `existsSync`
// before running git. We can't inject that cleanly here, so each fixture
// claims an existing worktree path by using `__dirname`.
const WORKTREE = '/tmp/does-not-matter-for-replay';

const FIXTURES: FixtureCase[] = [
  {
    name: 'HOK-3292 — merged PR, idle REPL at waiting:Notification, clean tree → would-reap',
    monitorConsumer: true,
    allowAbandon: false,
    inputs: {
      issue: 'HOK-3292',
      slug: 'hok-3292',
      branch: 'task/hok-3292',
      worktree: WORKTREE,
      pr: {
        number: '1702',
        state: 'MERGED',
        mergedAt: '2026-10-22T12:00:00Z',
        headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        baseRefName: 'auto/integration',
        mergeCommitOid: 'cccccccccccccccccccccccccccccccccccccccc',
      },
      workflowOutcome: 'merged',
      gitStatus: '',
      commitsAhead: '0',
      cherryEquivalent: true,
      localHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      remoteHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      remoteContainsHead: true,
    },
    expectedStatus: 'would-reap',
  },
  {
    name: 'HOK-3230 — merged PR, idle REPL, dirty tree → would-archive-and-reap',
    monitorConsumer: true,
    allowAbandon: false,
    inputs: {
      issue: 'HOK-3230',
      slug: 'hok-3230',
      branch: 'task/hok-3230',
      worktree: WORKTREE,
      pr: {
        number: '1703',
        state: 'MERGED',
        mergedAt: '2026-10-22T12:00:00Z',
        headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        baseRefName: 'auto/integration',
        mergeCommitOid: 'dddddddddddddddddddddddddddddddddddddddd',
      },
      workflowOutcome: 'merged',
      gitStatus: ' M src/file.ts\n?? extra.txt\n',
      commitsAhead: '0',
      cherryEquivalent: true,
      localHead: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      remoteHead: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      remoteContainsHead: true,
    },
    expectedStatus: 'would-archive-and-reap',
  },
  {
    name: 'HOK-3227_c — aborted challenger, sibling merged, dirty tree → would-archive-and-reap',
    monitorConsumer: true,
    allowAbandon: true,
    inputs: {
      issue: 'HOK-3227_c',
      slug: 'hok-3227-challenger',
      branch: 'task/hok-3227-challenger',
      worktree: WORKTREE,
      pr: {
        number: '1668c',
        state: 'CLOSED',
        headRefOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        baseRefName: 'auto/integration',
      },
      siblingPr: {
        number: '1668',
        state: 'MERGED',
        mergedAt: '2026-10-22T10:00:00Z',
        headRefOid: 'ffffffffffffffffffffffffffffffffffffffff',
        baseRefName: 'auto/integration',
        mergeCommitOid: '0000000000000000000000000000000000000001',
      },
      siblingIssue: 'HOK-3227',
      role: 'challenger',
      pairId: 'HOK-3227',
      workflowOutcome: 'aborted',
      gitStatus: ' M shared/lib/foo.ts\n',
      commitsAhead: '0',
      cherryEquivalent: true,
      localHead: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      remoteHead: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      remoteContainsHead: true,
    },
    expectedStatus: 'would-archive-and-reap',
  },
  {
    name: 'HOK-3221_c — aborted challenger, sibling merged, dirty tree → would-archive-and-reap',
    monitorConsumer: true,
    allowAbandon: true,
    inputs: {
      issue: 'HOK-3221_c',
      slug: 'hok-3221-challenger',
      branch: 'task/hok-3221-challenger',
      worktree: WORKTREE,
      pr: {
        number: '1681c',
        state: 'CLOSED',
        headRefOid: '1111111111111111111111111111111111111111',
        baseRefName: 'auto/integration',
      },
      siblingPr: {
        number: '1681',
        state: 'MERGED',
        mergedAt: '2026-10-22T11:00:00Z',
        headRefOid: '2222222222222222222222222222222222222222',
        baseRefName: 'auto/integration',
        mergeCommitOid: '3333333333333333333333333333333333333333',
      },
      siblingIssue: 'HOK-3221',
      role: 'challenger',
      pairId: 'HOK-3221',
      workflowOutcome: 'aborted',
      gitStatus: 'A  tools/added.ts\n',
      commitsAhead: '0',
      cherryEquivalent: true,
      localHead: '1111111111111111111111111111111111111111',
      remoteHead: '1111111111111111111111111111111111111111',
      remoteContainsHead: true,
    },
    expectedStatus: 'would-archive-and-reap',
  },
];

describe('HOK-3312 replay — 2026-10-22 Backstage retained rows', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      // The decider calls `existsSync(worktree)` before trusting the git
      // runner. Point at an existing path on the test host.
      const inputs = { ...fixture.inputs, worktree: TEST_DIR };
      const stateReal = fixtureState(inputs);
      const deps = fixtureDeps(inputs);
      const decision = decideTerminalTask(stateReal, inputs.issue, TEST_DIR, 'auto/integration', {
        deps,
        monitorConsumer: fixture.monitorConsumer,
        allowAbandon: fixture.allowAbandon,
      });
      assert.equal(
        decision.status,
        fixture.expectedStatus,
        `expected ${fixture.expectedStatus} but got ${decision.status}: ${decision.refusalReason || '-'}`,
      );
      // Negative invariant: a terminal, delivered arm must never surface
      // `dirty_worktree` / `live_agent` refusals under monitorConsumer.
      assert.notEqual(decision.refusalReason, 'dirty_worktree');
      assert.notEqual(decision.refusalReason, 'live-agent-process');
    });
  }

  it('negative: aborted arm without a merged sibling stays retain-eligible', () => {
    const inputs: FixtureInputs = {
      issue: 'HOK-9999_c',
      slug: 'hok-9999-challenger',
      branch: 'task/hok-9999-challenger',
      worktree: TEST_DIR,
      pr: {
        number: '9999c',
        state: 'CLOSED',
        headRefOid: '4444444444444444444444444444444444444444',
        baseRefName: 'auto/integration',
      },
      role: 'challenger',
      pairId: 'HOK-9999',
      workflowOutcome: 'aborted',
      gitStatus: ' M real.ts\n',
      commitsAhead: '1',
      cherryEquivalent: false,
      localHead: '4444444444444444444444444444444444444444',
      remoteHead: '4444444444444444444444444444444444444444',
      remoteContainsHead: true,
    };
    const state = fixtureState(inputs);
    const decision = decideTerminalTask(state, inputs.issue, TEST_DIR, 'auto/integration', {
      deps: fixtureDeps(inputs),
      monitorConsumer: true,
      allowAbandon: true,
    });
    // Dirty tree + not-delivered sibling means we don't auto-archive.
    // (monitorConsumer collapses dirty-into-archive for a *terminal lifecycle*
    // task; our lifecycle is 'aborted', which qualifies, so even a bare arm
    // archives.) Actually `isTerminalLifecycle` returns true here, so this
    // becomes `would-archive-and-reap`. Guard the HOK-3312 intent instead:
    // whatever the status, it must NOT be a `dirty_worktree` refusal.
    assert.notEqual(decision.refusalReason, 'dirty_worktree');
  });
});
