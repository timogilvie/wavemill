# Model transport (HOK-3460)

**Rule:** never implement a model CLI transport — spawning `claude` or
`codex`, building their argv, parsing their stdout/JSONL, classifying their
errors, or writing their env knobs — outside `shared/lib/model-adapters/`.

## Why

A transport fact implemented in two places drifts. Before HOK-3460, `llm-cli`
spawned the CLIs, parsed Claude envelopes and Codex JSONL, classified errors
and decided vendor compatibility, while `model-adapters/` held a second copy of
the same facts (and delegated back into `llm-cli`, an import cycle). Fixes
landed in one copy and were silently missing from the other.

## Where a transport lives

- `shared/lib/model-adapters/cli-process.ts` — one process runner: spawn,
  stdin, timeout, activity timeout, abort, slow-call notification.
- `shared/lib/model-adapters/claude-cli-adapter.ts` — the claude CLI transport:
  argv, env, isolation flags, session ownership, stdout interpretation,
  vendor compatibility.
- `shared/lib/model-adapters/codex-cli-adapter.ts` — the codex CLI transport:
  `codex exec --json` argv/env, JSONL parse, ownership resolution, vendor
  compatibility.
- `shared/lib/model-adapters/cli-error-classifier.ts` — the shared error
  classifier and the `retryPolicyFor` ladder/retry translation.
- `shared/lib/model-adapters/claude-cli-output.ts` — the single Claude stdout
  interpreter.

## Use instead

Callers ask for an adapter (`adapterForProvider` / `resolveModelAdapter`) and
`invoke` it. They receive text, usage/cost, reported-model identity, session
refs and typed `AdapterError`s. They never spawn a model CLI or parse its
output themselves.

`review-engine.ts` implements `TransportAdapter` with a thin policy wrapper
(`ReviewCliAdapter`): it decides whether a pinned reviewer may fall back and
which `cliFlags` the review asks for, then delegates to `callLLM`. It implements
no transport — no spawn, argv, parse or classify.

## Guard

`tools/check-model-transport.ts` (wired into `test:preflight`) flags:

- spawning the literal `claude`/`codex` binary
- `--output-format json|stream-json` command strings and the
  `'--output-format'` argv token
- `'exec', '--json'` argv
- codex JSONL event literals (`turn.completed`, `item.completed`,
  `agent_message`, `thread.started`)
- writes to `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
- a private `classify*LLMError` function

`shared/lib/model-adapters/` is exempt. A justified exception goes in
`tools/model-transport-allowlist.txt` with a `# reason` and a ratcheting count,
or on one line as `// allow-model-transport: <reason>`.
