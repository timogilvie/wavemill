// HOK-3150 step 2: replay-safety labels for every tool a native coding arm uses.
//
// Pi-durable's `ToolRegistration.replay` field controls what happens when a
// `kill -9` interrupts a tool execution. `safe` → the tool reruns on reopen
// (same `callId` returns the same intent); `unsafe` (the default) → the model
// receives an `interrupted` result instead, with any output committed before
// the crash preserved.
//
// This table is asserted at arm startup against the actual tool registry so a
// newly added tool cannot silently default to "unsafe" without an entry; an
// unknown name is treated as **unsafe** at startup time rather than at crash
// time, so the arm fails fast on a missing label.

export type ReplayLabel = 'safe' | 'unsafe';

export interface ReplayLabelReason {
  label: ReplayLabel;
  rationale: string;
}

export const REPLAY_LABELS: Readonly<Record<string, ReplayLabelReason>> = Object.freeze({
  // --- read-only tools ---
  read_file: {
    label: 'safe',
    rationale: 'Pure read of worktree files; idempotent.',
  },
  list_files: {
    label: 'safe',
    rationale: 'Directory listing is read-only and idempotent.',
  },
  search_text: {
    label: 'safe',
    rationale: 'Text search is read-only; a rerun on the same tree gives the same hits.',
  },
  read_plan: {
    label: 'safe',
    rationale: 'Reads features/<slug>/plan.md; pure read.',
  },
  read_task_packet: {
    label: 'safe',
    rationale: 'Reads features/<slug>/task-packet{,-details}.md; pure read.',
  },
  intended_files: {
    label: 'safe',
    rationale: 'Reads the intended-files manifest; pure read.',
  },

  // --- git read-only ---
  git_status: { label: 'safe', rationale: 'Read-only git status.' },
  git_diff: { label: 'safe', rationale: 'Read-only diff.' },
  git_diff_stat: { label: 'safe', rationale: 'Read-only diff stat.' },
  git_log: { label: 'safe', rationale: 'Read-only log.' },

  // --- test / format ---
  run_tests: {
    // Judgment call. Technically hermetic test suites are safe (they only
    // read the tree), but test runners frequently write caches, snapshots,
    // generated files, and lock entries. Default to unsafe so a rerun does
    // not quietly re-apply a flaky side effect; expensive to re-run anyway.
    label: 'unsafe',
    rationale:
      'Tests often write caches, snapshots, or lockfiles; expensive to rerun. Recorded as unsafe but could be "safe" for a hermetic suite.',
  },
  run_format: {
    label: 'unsafe',
    rationale: 'Formatter rewrites files; mutating.',
  },

  // --- worktree mutations ---
  apply_patch: {
    label: 'unsafe',
    rationale:
      'Multi-file patch; re-applying either fails on an already-applied hunk or double-applies on a different anchor. Must deliver interrupted → model reconciles via git_status.',
  },

  // --- git write ---
  git_add: {
    label: 'unsafe',
    rationale: 'Index mutation; a rerun after kill may re-stage files the model intended to abandon.',
  },
  git_commit: {
    label: 'unsafe',
    rationale: 'History mutation; a rerun would create duplicate commits.',
  },

  // --- artifact / status / markers ---
  write_artifact: {
    label: 'unsafe',
    rationale: 'Writes files consumed by the monitor (completion artifact, etc.); not idempotent.',
  },
  create_marker: {
    label: 'unsafe',
    rationale: 'Marker files have observable semantics for the monitor; must not reappear by accident.',
  },
  update_status: {
    label: 'unsafe',
    rationale: 'Writes the task status hook consumed by the dashboard.',
  },
});

/**
 * Look up a replay label for a tool. Fail closed: an unknown name is
 * **unsafe** at caller discretion (the harness refuses to launch when a
 * registered tool is missing from this table — see assertReplayLabelsCover).
 */
export function replayLabelFor(name: string): ReplayLabelReason | undefined {
  return REPLAY_LABELS[name];
}

/**
 * Assert the replay-label table covers every tool the arm registered. The
 * arm throws at startup when a registered name has no entry so a new catalog
 * tool can never silently default to "unsafe" through missing labelling.
 */
export function assertReplayLabelsCover(toolNames: readonly string[]): void {
  const unlabeled = toolNames.filter((name) => REPLAY_LABELS[name] === undefined);
  if (unlabeled.length > 0) {
    throw new Error(
      `replay-labels: missing entries for tools: ${unlabeled.join(', ')}. ` +
        'Add entries to REPLAY_LABELS (safe for pure reads, unsafe for anything that mutates state).',
    );
  }
}
