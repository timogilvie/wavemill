// HOK-3151 §3.2: app state docs with explicit fork rules.
// Shared planning prefix (plan + packet) uses fork: "asOf" to inherit the parent
// value at the fork point. Per-arm state (patch-state, arm) starts fresh via
// fork: "initial". The pair record (scope: "session") is written once in the
// creating commit.

import { defineDoc } from '@earendil-works/pi-durable';
import type { TransactionContext } from '@earendil-works/pi-durable';

export interface PlanDoc {
  text: string;
  hash: string;
}

export interface TaskPacketDoc {
  text: string;
  hash: string;
}

export interface PatchStateDoc {
  appliedPatches: string[];
  headSha: string;
  worktree?: string; // Set by materializeArmWorktree after the fork commit
}

export interface ArmDoc {
  role: 'primary' | 'challenger';
  pairId: string;
  model: string;
  worktree?: string;
}

export interface PairDoc {
  pairId: string;
  primaryConvId: string;
  challengerConvId: string;
  forkEntryId: string;
  forkCommit: string;
  createdAt: number;
}

// Plan: inherited at fork point via asOf
export const plan = defineDoc<PlanDoc>({
  key: 'app.plan',
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
});

// Task packet: inherited at fork point via asOf
export const taskPacket = defineDoc<TaskPacketDoc>({
  key: 'app.task-packet',
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
});

// Patch state: starts fresh per arm
export const patchState = defineDoc<PatchStateDoc>({
  key: 'app.patch-state',
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
});

// Arm metadata: written in the fork commit's init callback
export const arm = defineDoc<ArmDoc>({
  key: 'app.arm',
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
});

// Pair record: written in the creating commit (session scope)
export const pair = defineDoc<PairDoc>({
  key: 'app.pair',
  scope: 'session',
});

/**
 * conversationCreated hook: initialize default docs for every conversation.
 * Called in every creating/forking commit.
 */
export function initializeConversationDocs(
  tx: TransactionContext,
  convId: string,
): void {
  // Default patch state: empty
  tx.write(patchState, convId, {
    appliedPatches: [],
    headSha: '',
  });
  // Arm and plan/packet are written by callers as needed
}
