/**
 * HOK-3373: the settled-attempt preflight guard fires on each bypass shape
 * and stays quiet on the sanctioned seams.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkGuardSource } from './lib/source-guard.ts';
import { SETTLED_ATTEMPT_GUARD } from '../shared/lib/settled-attempt-guard.ts';

const findings = (file: string, text: string) => checkGuardSource(SETTLED_ATTEMPT_GUARD, file, text).map((f) => f.pattern);

describe('settled-attempt guard', () => {
  // protects: a new shell writer reopening a settled run by writing state without the seam.
  it('fires on a raw shell write of the state file', () => {
    assert.deepEqual(findings('shared/lib/x.sh', `jq '.tasks[$i].phase = "aborted"' "$STATE_FILE" > "$STATE_FILE"\n`), ['state-write-bypass']);
    assert.deepEqual(findings('shared/lib/x.sh', `mv "$tmp" "$STATE_FILE"\n`), ['state-write-bypass']);
    assert.deepEqual(findings('shared/lib/x.sh', `state_mutate "$STATE_FILE" '.tasks[$i].phase = "aborted"' --arg i "$i"\n`), []);
  });

  // protects: a TS writer bypassing mutateWorkflowState.
  it('fires on a TS writeFileSync of the state path', () => {
    assert.deepEqual(findings('tools/x.ts', 'writeFileSync(statePath, JSON.stringify(state));\n'), ['state-write-bypass']);
    assert.deepEqual(findings('tools/x.ts', "await mutateWorkflowState(statePath, (s) => s);\n"), []);
  });

  // protects: a new site resetting delivered work in Linear (the cleanup_on_exit Backlog flips).
  it('fires on a Linear state write outside the renderer', () => {
    assert.deepEqual(findings('shared/lib/x.sh', '      linear_set_state "$issue" "Backlog" 2>/dev/null || true\n'), ['linear-state-write']);
    assert.deepEqual(findings('tools/x.ts', "await setIssueState(id, 'Backlog');\n"), ['linear-state-write']);
    assert.deepEqual(findings('shared/lib/x.sh', '# linear_set_state "$issue" "Backlog" in prose\n'), []);
  });

  // protects: git falling through a dead worktree to the main checkout (HOK-2595 touch set).
  it('fires on a task-path git -C or mkdir outside the resolver', () => {
    assert.deepEqual(findings('shared/lib/x.sh', 'git -C "$wt_dir" diff --name-only\n'), ['task-path-probe']);
    assert.deepEqual(findings('shared/lib/x.sh', 'mkdir -p "$state_dir"\n'), ['task-path-probe']);
    assert.deepEqual(findings('tools/x.ts', "execArgvCommand('git', ['-C', worktree, 'diff']);\n"), ['task-path-probe']);
    assert.deepEqual(findings('shared/lib/x.sh', 'git -C "$REPO_DIR" worktree prune\n'), []);
    assert.deepEqual(findings('shared/lib/x.sh', 'task_dir_ensure "$state_dir" || return 1\n'), []);
  });

  // protects: an explicit, reasoned exception being impossible to express.
  it('honours the suppression marker', () => {
    assert.deepEqual(findings('shared/lib/x.sh', '# allow-settled-attempt: resolved registered above\ngit -C "$wt_dir" diff\n'), []);
  });
});
