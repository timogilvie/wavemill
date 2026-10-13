// HOK-3151 §3.3-3.4: forkChallengePair (atomic pair creation) and
// materializeArmWorktree (idempotent git worktree add).

import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Harness, Conversation, AgentChange } from '@earendil-works/pi-durable';
import { arm, pair, patchState, initializeConversationDocs } from './fork-docs.js';

export interface ArmConfig {
  model: string;
  cwd: string;
  extensions?: any[];
}

export interface ForkPairOptions {
  parentConvId: string;
  atEntryId: string;
  pairId: string;
  forkCommit: string;
  primary: ArmConfig;
  challenger: ArmConfig;
}

export interface ForkPairResult {
  primaryConvId: string;
  challengerConvId: string;
  wasExisting: boolean;
  constraints: string[];
}

/**
 * Fork a challenge pair: create both coding arms from the parent conversation
 * at the fork entry, in one atomic commit. Idempotent by pairId.
 *
 * §3.3: tries to use tx.forkConversation + configure for single-commit atomicity.
 * Falls back to conversation.fork if the transaction API is unavailable, and
 * records [constraint] pair not single-commit.
 */
export async function forkChallengePair(
  harness: Harness,
  options: ForkPairOptions,
): Promise<ForkPairResult> {
  const {
    parentConvId,
    atEntryId,
    pairId,
    forkCommit,
    primary,
    challenger,
  } = options;
  const constraints: string[] = [];

  // Check if pair already exists (idempotent)
  const parent = await harness.conversation(parentConvId);
  const existingPair = await parent.read(pair);
  if (existingPair && existingPair.pairId === pairId) {
    return {
      primaryConvId: existingPair.primaryConvId,
      challengerConvId: existingPair.challengerConvId,
      wasExisting: true,
      constraints,
    };
  }

  // Try single-commit atomic path via tx.forkConversation + configure
  try {
    const result = await parent.commit(async (tx) => {
      // Fork both arms
      const primaryFork = await tx.forkConversation(parentConvId, atEntryId, {
        ownership: { kind: 'ownerless' },
      });
      const challengerFork = await tx.forkConversation(parentConvId, atEntryId, {
        ownership: { kind: 'ownerless' },
      });

      // Configure agents (model + cwd + extensions)
      // NOTE: @earendil-works/pi-durable 1.0.4 types say configure exists but
      // it may not be exported. If this throws, we fall back to conversation.fork.
      const configure = (tx as any).configure;
      if (typeof configure !== 'function') {
        throw new Error('configure not available');
      }

      const primaryAgent: AgentChange = {
        model: primary.model,
        cwd: primary.cwd,
        extensions: primary.extensions,
      };
      const challengerAgent: AgentChange = {
        model: challenger.model,
        cwd: challenger.cwd,
        extensions: challenger.extensions,
      };

      await configure(tx, primaryFork.id, primaryAgent);
      await configure(tx, challengerFork.id, challengerAgent);

      // Initialize docs
      initializeConversationDocs(tx, primaryFork.id);
      initializeConversationDocs(tx, challengerFork.id);

      // Write arm metadata
      tx.write(arm, primaryFork.id, {
        role: 'primary',
        pairId,
        model: primary.model,
      });
      tx.write(arm, challengerFork.id, {
        role: 'challenger',
        pairId,
        model: challenger.model,
      });

      // Write pair record (session scope)
      tx.write(pair, pairId, {
        pairId,
        primaryConvId: primaryFork.id,
        challengerConvId: challengerFork.id,
        forkEntryId: atEntryId,
        forkCommit,
        createdAt: Date.now(),
      });

      return {
        primaryConvId: primaryFork.id,
        challengerConvId: challengerFork.id,
      };
    });

    return {
      primaryConvId: result.primaryConvId,
      challengerConvId: result.challengerConvId,
      wasExisting: false,
      constraints,
    };
  } catch (err: any) {
    // Fall back to separate conversation.fork calls
    constraints.push('pair not single-commit');

    const primaryAgent: AgentChange = {
      model: primary.model,
      cwd: primary.cwd,
      extensions: primary.extensions,
    };
    const challengerAgent: AgentChange = {
      model: challenger.model,
      cwd: challenger.cwd,
      extensions: challenger.extensions,
    };

    const primaryFork = await parent.fork(atEntryId, {
      ownership: { kind: 'ownerless' },
      agent: primaryAgent,
      init: async (tx, convId) => {
        initializeConversationDocs(tx, convId);
        tx.write(arm, convId, {
          role: 'primary',
          pairId,
          model: primary.model,
        });
      },
    });

    const challengerFork = await parent.fork(atEntryId, {
      ownership: { kind: 'ownerless' },
      agent: challengerAgent,
      init: async (tx, convId) => {
        initializeConversationDocs(tx, convId);
        tx.write(arm, convId, {
          role: 'challenger',
          pairId,
          model: challenger.model,
        });
      },
    });

    // Write pair record separately (not atomic with the forks)
    await parent.commit((tx) => {
      tx.write(pair, pairId, {
        pairId,
        primaryConvId: primaryFork.id,
        challengerConvId: challengerFork.id,
        forkEntryId: atEntryId,
        forkCommit,
        createdAt: Date.now(),
      });
    });

    return {
      primaryConvId: primaryFork.id,
      challengerConvId: challengerFork.id,
      wasExisting: false,
      constraints,
    };
  }
}

/**
 * Idempotent git worktree creation keyed by conversation id.
 * §3.4: if dir exists and HEAD is at or after forkCommit, reuse it.
 * Otherwise create a new worktree at forkCommit. Updates app.patch-state.worktree.
 */
export async function materializeArmWorktree(
  conv: Conversation,
  repoPath: string,
  forkCommit: string,
  worktreeDir: string,
): Promise<void> {
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  // Check if worktree already exists and is valid
  if (existsSync(worktreeDir)) {
    try {
      const head = git(['rev-parse', 'HEAD'], worktreeDir);
      const isDescendant = git(
        ['merge-base', '--is-ancestor', forkCommit, head],
        worktreeDir,
      );
      // If HEAD is at or after forkCommit, reuse
      if (isDescendant !== undefined) {
        await conv.commit((tx) => {
          const state = tx.read(patchState, conv.id) || {
            appliedPatches: [],
            headSha: '',
          };
          tx.write(patchState, conv.id, {
            ...state,
            worktree: worktreeDir,
          });
        });
        return;
      }
    } catch {
      // merge-base fails if not descendant; fall through to recreate
    }
  }

  // Create worktree directory if needed
  await mkdir(path.dirname(worktreeDir), { recursive: true });

  // Add worktree at forkCommit
  execFileSync('git', ['worktree', 'add', '--detach', worktreeDir, forkCommit], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  // Record in app.patch-state
  await conv.commit((tx) => {
    const state = tx.read(patchState, conv.id) || {
      appliedPatches: [],
      headSha: '',
    };
    tx.write(patchState, conv.id, {
      ...state,
      worktree: worktreeDir,
    });
  });
}
