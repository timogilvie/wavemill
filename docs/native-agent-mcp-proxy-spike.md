# Native agent — MCP proxy compatibility spike (HOK-3055)

**Status:** spike complete · **Decision:** ADAPT the proxy *pattern*; REJECT
direct in-boundary adoption of `pi-mcp-adapter` at the pinned Pi version.

Backing code (deterministic, offline, no provider credentials):

- `spike/pi-native-agent/mcp-toy-server.mjs` — dependency-free toy stdio MCP
  server (success / slow / secret / malformed / clean-shutdown modes).
- `spike/pi-native-agent/mcp-proxy-harness.ts` — the Wavemill-owned boundary:
  one fixed `mcp_call` provider schema, exposure + phase/path + fail-closed
  network checks *before* dispatch, and Wavemill result normalization after.
- `spike/pi-native-agent/mcp-proxy-spike.test.ts` — 12 fixtures covering every
  acceptance item.

Run: `node --test spike/pi-native-agent/mcp-proxy-spike.test.ts`

---

## Question

Can `pi-mcp-adapter` (or an equivalent proxy) sit behind Wavemill's policy and
provenance boundary *without* loading every MCP tool schema into every provider
turn?

## What the spike proves in code

| Requirement | Fixture | Evidence |
| --- | --- | --- |
| Discovery + one successful proxy call | `discovers server tools and proxies one successful call` | `tools/list` returns the catalog; `echo` round-trips; result tagged untrusted |
| Bounded provider schema as tool count grows | `provider schema is bounded regardless of discovered tool count` | 5 vs 200 discovered tools → **one byte-identical** `mcp_call` schema (`{server,tool,arguments}`) |
| Phase denial before the server is reached | `phase denial short-circuits before the server starts` | `session.started === false`, `dispatchedToServer === 0` |
| Path denial before the server is reached | `path denial short-circuits before the server starts` | `../../etc/passwd` → `path_denied`, server never started |
| Network denial (fail-closed) before the server is reached | `network egress is denied fail-closed before the server starts` | empty policy + egress target → `missing_policy`, server never started |
| Timeout / cancellation | `per-call timeout …`, `AbortSignal cancellation …` | `slow` tool never replies; per-call timeout and `AbortSignal` both yield a stable error result |
| Malformed result | `malformed server payload becomes a stable error result` | non-JSON line → stable `malformed` error, no throw |
| Redaction + cap + provenance | `secret-bearing results …`, `oversized results …` | secrets masked (`[REDACTED…]`), `redaction.redacted`, byte cap enforced, `argsFingerprint` set, tagged `external-untrusted` |
| Guaranteed termination | `server starts lazily and terminates cleanly` | lazy spawn; `terminate()` kills the child (`process.kill(pid,0)` → `ESRCH`), idempotent |
| Wavemill transcript semantics | `proxy results serialize as valid Wavemill transcript records` | result serializes to a `tool_result` `TranscriptEvent` and round-trips through `parseTranscriptJsonl` with full `metadata` |

The boundary reuses the shipped Wavemill modules rather than reimplementing
them: `tools/exposure.ts` (default-off `nativeAgent.advanced.mcp` gate),
`tools/policies.ts` (phase + worktree-path denial), `tools/redaction.ts`,
`provenance.ts`, and the `tools/types.ts` result-metadata shapes. The network
decision mirrors `network-policy.ts`'s fail-closed contract (missing rule →
deny) with an mcp-scoped rule map, because the shared evaluator is typed to the
fixed `WorkflowToolName` union.

## Evaluated package (verified from the npm registry)

| Field | Value |
| --- | --- |
| Package | `pi-mcp-adapter` |
| Latest version | `2.37.0` |
| License | MIT |
| Author / repo | Nico Bailon · `github.com/nicobailon/pi-mcp-adapter` (third-party, **not** `@earendil-works`) |
| Pi peer dependency | `@earendil-works/pi-ai: ^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0` (optional) |
| Notable dependencies | `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/client@2.0.0`, `@napi-rs/keyring` (native OS credential store), `open` (launches a browser), `undici`, `cross-spawn`, `recheck@4.6.0-beta.3` |

The reference SDK `@modelcontextprotocol/sdk` (latest `1.30.1`, MIT) exists too;
the spike deliberately depends on **neither**, and adds no runtime dependency.

## Decision: ADAPT the pattern, REJECT direct in-boundary adoption

**Adapt.** The proxy *pattern* is sound and is the production shape: a single
Wavemill-owned `mcp_call` advanced-family descriptor wrapping a session-scoped
adapter client. Policy/exposure and a fail-closed network decision run before
dispatch; Wavemill normalizes (redaction, cap, provenance, `external-untrusted`,
transcript) after. The provider-facing schema stays bounded no matter how many
tools a server exposes — the core kill criterion for this epic.

**Reject** dropping `pi-mcp-adapter` *inside* the boundary at the pinned Pi
version, on this evidence:

1. **Version incompatibility.** `pi-mcp-adapter@2.37.0` declares its Pi peer as
   `^0.84.1–^0.87.0`; the native runtime pins `@earendil-works/pi-*@0.79.8`. It
   is out of the supported range and cannot be adopted as-is.
2. **Dependency surface conflicts with the boundary.** It bundles
   `@napi-rs/keyring` (reads the OS credential store) and `open` (spawns a
   browser) — capabilities that must never execute inside Wavemill's fail-closed
   network/mutation posture. Its native module and `recheck` beta widen the
   supply-chain and reproducibility risk for CI.
3. **An MCP permission model is not authorization.** Per the task's non-goals, a
   server's or adapter's own permission model does not authorize execution.
   Wavemill must remain the sole authorization point, which the harness
   demonstrates by denying *before* the adapter or server is reached.

## Expected production architecture

- A Wavemill-owned `mcp_call` descriptor in the `mcp` advanced family
  (`exposure: 'opt-in'`, `provenance: 'external-untrusted'`,
  `certificationRequirement: 'workflow'`), already modeled in `tools/types.ts`.
- Eligibility via `computeEligibility` — default-off `nativeAgent.advanced.mcp`,
  enabled per phase only by explicit operator config.
- A session-scoped adapter client behind the descriptor: lazy start on first
  eligible call, session-scoped discovery cache, always terminated in `finally`.
- Pre-dispatch gate: exposure → phase/path (`policies.ts`) → fail-closed network
  (`network-policy.ts`). Post-dispatch: redaction, output cap, provenance
  fingerprint, `external-untrusted` tag, and a `tool_result` transcript record —
  exactly as the native `loop.ts` enriches every tool result.
- If a concrete adapter is later adopted, it must target a Pi-compatible version,
  drop or sandbox the credential-store/browser capabilities, and sit **behind**
  this descriptor as a transport detail — never as a provider-facing tool.

## Known limitations of this spike

- Stdio/local toy server only; no real MCP transport, server list, or
  credentials, and no external network service (by design; CI stays offline).
- The toy server implements a minimal line-delimited JSON protocol, not the full
  MCP handshake/JSON-RPC spec — sufficient to exercise the boundary seams.
- No claim that any MCP server's or adapter's permission model authorizes
  execution; Wavemill is the authorization point.
- Sub-agent fan-out, streaming partial results, and resource/prompt MCP
  primitives are out of scope for this compatibility spike.

## Rollback

Revert the implementation commit and remove the new opt-in `mcp` fixtures and
the `spike/pi-native-agent/mcp-*` files plus this doc. No production config,
credentials, or schema fields are added, so read-only, patch, command,
workflow, and certification behavior remain valid when the feature is absent.
