# Agent instructions

## Root-cause investigations and issues

When investigating a Wavemill failure or writing a bug issue,
read and follow `skills/root-cause-issue/SKILL.md`.

Capture evidence, find all sites making the same decision,
check existing primitives and Linear issues, and prefer
consolidation over another case-specific fix.

## Model execution

Preserve the configured model-to-executor routing: Anthropic models use the
Claude CLI, OpenAI models use the Codex CLI, and other models use their
configured native executor. Use the canonical `resolveModelAgent` resolver.
Fix the failing executor path rather than moving the model or stage to another
executor as a workaround. Do not route Anthropic or OpenAI models through
OpenRouter.

## Worktree identity

Use exact absolute worktree paths with the command's working-directory option
or `git -C`. Never enter a task worktree using a wildcard: the primary and
`-challenger` sibling share a prefix. Verify the worktree and branch before
editing.

## Running-code verification

Before assuming a merged fix is live, verify its code is present in the running
monitor bundle and the checkout that generated it. Branch names and merge
ancestry alone are insufficient, particularly across squash promotions. Restarting
an existing bundle does not establish that it contains newly merged code.

When CI repeats the same failure after remediation, compare the local HEAD,
remote PR HEAD, and CI run's `headSha` before diagnosing the code again. Confirm
the fix was pushed and the failing run tested it.

## Linear issue expansion

Issue expansion updates Linear by default. Preserve `--no-update` as the
explicit opt-out for dry runs and tests; do not require an opt-in `--update`
flag to save expanded task packets.

## Repository invariants and tests

Read the Utilities section of `CLAUDE.md` before changing shared mill behavior,
and follow its Test Registration and Testing Patterns sections for test changes.
Reuse the documented primitives for failure policy, bounded retries, condition
reconciliation, task identity and state writes rather than implementing private
variants. Use schema-validated fixtures and shared fakes; tests must not write
tracked repository files. Incident fixes on the plan-to-merge chain must add or
extend a golden journey.

Keep detailed incident history and recovery recipes in skills or runbooks.
Verify historical workarounds against current code before using them.
