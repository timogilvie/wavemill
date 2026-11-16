# Model input: one builder, one diff reader

**Rule.** A PR change enters a model prompt only through
`buildBudgetedChangeInput` (`shared/lib/review-input-budget.ts`). A PR's diff is
read only through `fetchPrDiff` (`shared/lib/pr-diff-provider.ts`). Never call
`gh pr diff` anywhere else, and never add a prompt byte or character cap: how
much fits a model is the transport adapter's answer, and a change that does not
fit is the adapter's typed `context-window-exceeded`.

Guard: `tools/check-model-input.ts`.
Patterns: `gh-pr-diff-outside-reader` (TS and shell), `prompt-byte-cap` (TS).

## Why

Review, eval and challenge comparison each put a diff into a model prompt. When
each site decided for itself what to include and when the prompt was "too big",
they diverged, and the eval site — which asked GitHub for the diff and capped it
by bytes — grew a 3.8 MB judge prompt that no adapter was asked about. The
model CLI failed three times with an empty message and the mill retried the
identical prompt, parking an otherwise green PR (incident 2026-11-15, HOK-3493).

The builder is pure and deterministic (no clocks, no randomness, sorted
iteration, and no file I/O unless a caller passes `readFile`). Eval and
comparison pass none, so their change input depends only on the diff and the
budget — the acceptance test that both see byte-identical input for the same PR
and budget holds by construction.

## How to comply

- **Building a prompt that carries a change.** Fill your template with the
  change slot empty to get `reservedPrompt`, then call `buildBudgetedChangeInput`
  with it and your model's `TransportAdapter`. Put the returned `text` in the
  slot. When several changes share one prompt, pass `parts` so the budget is
  split evenly rather than by relative size (a proportional split would let one
  arm's rendering depend on another's).
- **Refusing an over-budget change.** When the result is not `withinBudget`,
  call `adapter.preflight(prompt)` and throw `ChangeInputRefusedError(refusal)`.
  Its `adapterError.policyKind` is the failure reason to record; the failure
  policy already treats `context-window-exceeded` as terminal. Do not cut the
  change and do not retry it.
- **Reading a diff.** Call `fetchPrDiff(pr, repoDir, deps)`. It tries local git
  first (which honours `.gitattributes -diff`, so a generated file arrives as
  git's `Binary files … differ` line) and falls back to `gh pr diff` only when
  the local objects cannot be fetched.

## Exceptions

A justified exception is one line suppressed with
`// allow-model-input: <reason>` (use `#` in shell), or a ratcheting entry in
`tools/model-input-allowlist.txt` with a `# reason`. The allowlist only shrinks.
