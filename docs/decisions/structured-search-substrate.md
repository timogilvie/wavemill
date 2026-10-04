# Structured Code Search Substrate (HOK-3059)

**Decision:** Ship the `code_search` advanced-family runtime substrate on top
of the in-process TypeScript compiler API for TS/TSX/JS/JSX/MTS/CTS/MJS/CJS
files, with a deterministic fallback to plain `search_text` for every other
language.

## Context

Epic 10.7 asks for worktree-scoped, read-only structured code search: bounded
symbol / definition / reference / call-site queries with stable result schemas,
recorded language and engine version, staleness detection, cancellation, and
budget enforcement. Everything must be off by default, worktree-scoped, and
tear down cleanly on abort.

The three candidate engines considered were LSP (with a per-worktree language
server), tree-sitter grammars, and the TypeScript compiler API.

## Options

### 1. Language Server Protocol / `pi-langsrv`

Would give rich cross-language coverage (Python, Go, Rust, Java) via existing
mature servers, but requires:

- A long-lived server process per worktree (Wavemill policy forbids daemons
  shared across unrelated worktrees unless isolation is proven).
- Lifecycle wiring for launch, timeout, and hard abort.
- Per-server network policy (some servers phone home for extension updates).
- Grammar / stub distribution work in every mill install.

Effort exceeds the value for a read-only substrate that must default off.

### 2. Tree-sitter with vendored WASM grammars

Deterministic and pure JS at runtime, but the added dependency and one grammar
per supported language expands the install surface for every developer and
mill worker without a phased pay-off. No grammar is currently vendored, so we
would ship the surface with no gain over the default fallback for any
language beyond TS/JS.

### 3. In-process TypeScript compiler API (**chosen**)

`typescript ^5.9.3` is already a top-level dependency:

- Pure JavaScript, in-process, no native builds.
- Cancellable via `AbortSignal` at each iteration boundary and on every
  filesystem read.
- Deterministic across runs — no timestamps, no network, no per-run
  randomness.
- Produces exactly the AST information Epic 10.7 requires: symbol tables,
  definitions, references, call sites.
- Session cleanup dropping the descriptor set discards the language index
  (no shared daemon, no module-level cache, no `/tmp` write).

For every non-TS language, the executor either surfaces
`{ status: 'unsupported_language', language }` or, when the caller passes
`fallback: true`, delegates to the injected `search_text` executor and
returns its verbatim result with `details.fallback: true`.

## Consequences

Adding a second engine later is architecturally straightforward: the
language-index module dispatches by detected language, so a future
tree-sitter or `pi-langsrv` engine can be inserted without changing the tool
contract. Until then, non-TS coverage is served by the deterministic text
search fallback.

## Related

- Plan: `features/native-runtime-epic-10-7-language-intelligence-and-structured-code-search/plan.md`
- Runtime plan catalog: `docs/native-agent-runtime-plan.md`
- Runtime substrate:
  - `shared/lib/native-agent/language-index.ts`
  - `shared/lib/native-agent/tools/code-search.ts`
- Config: `nativeAgent.advanced.code_search` in `wavemill-config.schema.json`.
