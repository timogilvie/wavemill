import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// These constants are coupled to the prompt surfaces registered in
// docs/prompt-locations.md. If the guard command or fail-closed wording is
// adjusted in any surface, adjust it in all of them and here in lockstep.
const REVIEW_GUARD_TEMPLATE_COMMAND = 'npx tsx {{TOOLS_DIR}}/check-review-scope.ts --repo-dir .';
const SELF_REVIEW_GUARD_COMMAND = 'npx tsx tools/check-review-scope.ts --repo-dir .';
const LEGACY_GUARD_COMMAND = 'npx tsx $tools_dir/check-review-scope.ts --repo-dir .';
const COMMIT_INSTRUCTION = 'git commit -m "fix: Address self-review findings (iteration N)"';

function assertGuardBeforeCommit(content: string, guardCommand: string, label: string): void {
  const guardIndex = content.indexOf(guardCommand);
  const commitIndex = content.indexOf(COMMIT_INSTRUCTION);

  assert.notEqual(guardIndex, -1, `${label} must include the review scope guard command`);
  assert.notEqual(commitIndex, -1, `${label} must include the review-fix commit instruction`);
  assert.ok(guardIndex < commitIndex, `${label} must run the guard before the review-fix commit`);

  const interveningText = content.slice(guardIndex, commitIndex);
  assert.match(
    interveningText,
    /preserve the index, report the violation, and stop/i,
    `${label} must stop instead of committing when the guard fails`,
  );
  assert.match(
    interveningText,
    /No review commit may be created/i,
    `${label} must include the fail-closed no-commit contract`,
  );
  assertExitCodeDistinction(interveningText, label);
}

// Exit 1 (policy violation) fails closed; exit 2 (scope unverified —
// infrastructure) must NOT be treated as a violation, or the arm stalls
// permanently one step before the review verdict (HOK-2889).
function assertExitCodeDistinction(text: string, label: string): void {
  assert.match(
    text,
    /If the guard exits 1/,
    `${label} must scope the fail-closed contract to guard exit 1`,
  );
  assert.match(
    text,
    /exits 2/,
    `${label} must describe guard exit 2 separately from exit 1`,
  );
  assert.match(
    text,
    /exits 2[\s\S]*?(infrastructure, not a violation)/i,
    `${label} must classify guard exit 2 as infrastructure, not a violation`,
  );
  assert.match(
    text,
    /Do not treat exit 2 as a scope violation/i,
    `${label} must forbid treating guard exit 2 as a scope violation`,
  );
  assert.match(
    text,
    /exits 3[\s\S]*?no PR exists yet[\s\S]*?not a violation/i,
    `${label} must describe guard exit 3 (no PR yet) as a non-violation`,
  );
  assert.match(
    text,
    /exits 3[\s\S]*?proceed exactly as for exit 0/i,
    `${label} must allow the pre-PR workflow to proceed on guard exit 3`,
  );
}

test('review-phase prompt requires review scope guard immediately before review-fix commits', () => {
  const content = readFileSync('tools/prompts/review-phase.md', 'utf-8');

  assertGuardBeforeCommit(content, REVIEW_GUARD_TEMPLATE_COMMAND, 'review-phase.md');
});

test('canonical self-review instructions require review scope guard before review-fix commits', () => {
  const content = readFileSync('tools/prompts/self-review-instructions.md', 'utf-8');

  assertGuardBeforeCommit(content, SELF_REVIEW_GUARD_COMMAND, 'self-review-instructions.md');
});

test('legacy generated workflow instructions require review scope guard before review-fix commits', () => {
  const content = readFileSync('shared/lib/agent-adapters.sh', 'utf-8');

  assertGuardBeforeCommit(content, LEGACY_GUARD_COMMAND, 'agent-adapters.sh');
});

test('bugfix command requires review scope guard before review-fix commits', () => {
  const content = readFileSync('commands/bugfix.md', 'utf-8');

  assertGuardBeforeCommit(content, SELF_REVIEW_GUARD_COMMAND, 'bugfix.md');
});

test('workflow command Phase 4 requires review scope guard before review-fix commits', () => {
  const content = readFileSync('commands/workflow.md', 'utf-8');

  const guardIndex = content.indexOf(SELF_REVIEW_GUARD_COMMAND);
  assert.notEqual(guardIndex, -1, 'workflow.md must include the review scope guard command');

  const followingText = content.slice(guardIndex);
  assert.match(
    followingText,
    /preserve the index, report the violation, and stop/i,
    'workflow.md must stop instead of committing when the guard fails',
  );
  assert.match(
    followingText,
    /No review commit may be created/i,
    'workflow.md must include the fail-closed no-commit contract',
  );
  assertExitCodeDistinction(followingText, 'workflow.md');
});

// HOK-3107 prompt-drift regression: agents must never be instructed to add any
// `wm:*` label. The mill (Ready → Tend) owns the entire `wm:*` label namespace.
// This test greps every review/PR-creation prompt surface for an `--add-label
// wm:*` instruction outside of an explicit forbidden-example context and fails
// if any is found.
const MILL_LABEL_PROMPT_SURFACES = [
  'tools/prompts/review-phase.md',
  'shared/lib/agent-adapters.sh',
  'commands/bugfix.md',
  'commands/workflow.md',
];

const AGENT_ADD_LABEL_WM_STAR = /(?:--add-label\s+["'`]?wm:[a-zA-Z0-9_.:-]+|["'`]?wm:[a-zA-Z0-9_.:-]+["'`]?\s+--add-label)/;

function stripForbiddenExamples(content: string): string {
  // The prompt surfaces contain examples INSIDE forbidden-context prose to
  // teach agents what NOT to do (e.g. "MUST NEVER ... `--add-label wm:merging`").
  // Those must not trigger the drift check. Everything else is instruction.
  const lines = content.split('\n');
  let inForbidden = false;
  return lines
    .filter((line) => {
      const heading = line.match(/^#+\s+/);
      if (heading) {
        inForbidden = /FORBIDDEN|forbidden|NEVER|Do NOT|Mill Label/i.test(line);
        return false;
      }
      if (inForbidden) return false;
      // Skip individual bullets that name their own forbidden context inline.
      return !/MUST NEVER|do not add any wm:|do not run `gh pr edit .* --add-label wm:|Agent-applied|owned by the mill|owns every `wm|owns the entire `wm/i.test(line);
    })
    .join('\n');
}

test('HOK-3107: no agent prompt instructs adding any wm:* label', () => {
  for (const surface of MILL_LABEL_PROMPT_SURFACES) {
    const content = readFileSync(surface, 'utf-8');
    const filtered = stripForbiddenExamples(content);
    const match = AGENT_ADD_LABEL_WM_STAR.exec(filtered);
    assert.equal(
      match,
      null,
      `${surface} must not instruct agents to add any wm:* label — the mill (Ready → Tend) owns them. `
        + `Matched: ${match?.[0] ?? ''}`,
    );
  }
});
