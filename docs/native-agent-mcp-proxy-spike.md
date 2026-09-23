# Native-agent MCP proxy compatibility spike (HOK-3055)

**Status:** Decision — **adapt** (retain a Wavemill-owned proxy façade; use MCP client patterns as an implementation detail only). MCP remains disabled by default. No production MCP configuration, credentials, or network traffic ships as part of this spike.

**Owner:** native-runtime working group. **Reviewers:** platform, security.

## 1. Problem framing

Wavemill's native runtime must be able to expose *some* MCP servers to a model without giving up its policy, redaction, provenance, and transcript boundary. The tempting shortcut — `pi-mcp-adapter` or any similar package that flat-projects every backing tool into the provider's tool list — has two disqualifying properties:

* **Schema surface grows with the catalog.** Every MCP tool becomes a separate provider-visible descriptor, so a modest server (dozens of tools) inflates every provider turn's tool list.
* **MCP's permission model is not Wavemill's authorization boundary.** Trusting the backing server's own `allowed_ops` sidesteps Wavemill's phase, path, network, and certification gates.

The spike asks: can we sit an MCP client (or an MCP-shaped client) *behind* Wavemill's policy boundary, keep the provider surface constant, and keep every existing invariant honest?

## 2. Approach

Build an isolated, in-process compatibility spike under `spike/pi-native-agent/`:

* [`mock-mcp-server.ts`](../spike/pi-native-agent/mock-mcp-server.ts) — a typed, deterministic toy MCP server with explicit `start / discover / invoke / stop` state, observable counters, a normal tool, a delayed-cancellable tool, a malformed-result mode, a secret-bearing result, and an expandable synthetic catalog knob (`syntheticCatalogSize`).
* [`mcp-adapter.ts`](../spike/pi-native-agent/mcp-adapter.ts) — a Wavemill-owned `McpProxyAdapter`. Exposes exactly one bounded descriptor (`mcp_proxy` with `{tool_name, arguments}`), enforces lazy server startup, caches discovery, validates the requested backing tool, propagates `AbortSignal`, enforces a finite timeout, and converts unknown-tool, timeout, abort, malformed, and terminated-server outcomes into stable structured tool errors. Successful results are capped, redacted, tagged `external-untrusted`, and shaped for `TranscriptWriter`. `dispose()` is always called in test cleanup so no server can leak.
* [`mcp-proxy-spike.test.ts`](../spike/pi-native-agent/mcp-proxy-spike.test.ts) — the deterministic evidence suite.

## 3. Evidence

Run the focused suite:

```bash
node --test spike/pi-native-agent/mcp-proxy-spike.test.ts
```

The suite covers, without touching the network, spawning a process, or reading any credential:

| Scope from HOK-3055 | Fixture |
| --- | --- |
| Deterministic mock session: discovery + one successful proxy call | `lazy lifecycle and discovery > starts the server on first allowed invoke and caches discovery` |
| Phase denial pre-dispatch (server counters unchanged) | `policy gate short-circuits > denies phase when a read-only phase gets a mutation tool` |
| Path denial pre-dispatch | `policy gate short-circuits > denies path when a proxied argument references outside the worktree` |
| Network denial pre-dispatch (default-deny) | `policy gate short-circuits > default-deny network refuses any target outside the allowlist` |
| Exposure denial (family/phase off) | `policy gate short-circuits > denies when the tool is not exposed to the phase` |
| Timeout / cancel + cleanup | `structured error conversion > converts a timeout into a stable tool error and cleans up`, `propagates external abort as an aborted error` |
| Malformed response | `structured error conversion > converts a malformed backing payload into a stable tool error` |
| Unknown tool | `structured error conversion > converts unknown tool names into a stable tool error` |
| Terminated server | `structured error conversion > converts a terminated server into a stable tool error` |
| Provider-facing schema stays bounded as backing catalog grows | `mcp_proxy provider surface stays bounded > exposes a single bounded descriptor regardless of backing catalog size` (128-tool synthetic catalog) |
| Secret redaction on the returned content | `result envelope: caps, redaction, provenance > redacts secrets in the returned content and marks metadata` |
| Output cap enforced with metadata | `result envelope: caps, redaction, provenance > caps large output and records the truncation in metadata` |
| `external-untrusted` provenance | `result envelope: caps, redaction, provenance > always tags trust as external-untrusted` |
| Transcript projection | `transcript projection > emits tool_started and tool_result envelopes compatible with TranscriptWriter` |

18/18 tests pass on Node 22.22.2. The suite is registered in `tests/run-unit-tests.sh`; `npx tsx tools/check-test-registration.ts` passes.

## 4. Package / license note

The spike deliberately implements the client half in-process (`mock-mcp-server.ts` doubles as an MCP-shaped stub) rather than depending on an external MCP client package. The scope-in items required us to prove *the pattern*: lazy lifecycle, discovery caching, a bounded provider surface, and Wavemill-owned policy/redaction. Nothing in the exercise depends on a specific MCP client library, so binding to one now would be premature.

Concrete implication for production: whichever MCP client we later adopt (a Pi-hosted `pi-mcp-adapter`, the official `@modelcontextprotocol/sdk`, or a custom typed client) must be the *implementation detail* of a Wavemill façade with the same shape as `McpProxyAdapter`. The chosen package's name, version, and license will be recorded in the follow-up implementation ticket alongside the final production seam. The spike itself introduces no new runtime dependency.

## 5. Known limitations of the spike

* The mock server is in-process; it does not exercise stdio-based framing, socket lifetime, or subprocess crashes. Production must add a real-transport regression suite.
* The synthetic catalog exists only to prove that the provider surface is constant; it does not model MCP server discovery latency or partial-catalog failure modes.
* Malformed-payload handling collapses every shape mismatch to `malformed_result`. Production should partition parse errors from semantic errors so operators can debug.
* Network policy is applied with a locally passed target string; the production seam must derive the target from the request the MCP client actually issues, not from arguments the model supplies.
* Cancellation is cooperative through `AbortSignal`; a hung backing tool that ignores it is bounded only by the proxy timeout, not by a process reaper. Production must add reaping for out-of-process servers.
* No credential handling is included. That is deliberate; the follow-up ticket must add a Wavemill-managed credential-injection path with a separate security review.

## 6. Decision — adapt

We **adapt** rather than adopt any MCP client wholesale. The production architecture is:

* The provider always sees a Wavemill descriptor (`mcp_proxy` or family variants), never a per-tool projection of the backing server. The `mcp` advanced family stays `opt-in`, `external-untrusted`, and `workflow`-certification-gated by default.
* Discovery, tool validation, argument shaping, timeout, cancellation, redaction, output caps, and provenance tagging live inside the Wavemill-owned adapter. The backing MCP client is a swappable dependency.
* Phase, path, and network policy are evaluated **before** the adapter is touched (`evaluateProxyPolicy` in the spike). The MCP server's own permissioning is treated as a defense-in-depth hint, never as authorization.
* All configuration remains default-off. Enabling MCP requires an explicit `nativeAgent.advanced.mcp` config change and a certified model, per HOK-3053.
* Production MCP server configuration and credentials are deferred to a separate contract + security review; this ticket lands only the compatibility spike, the decision, and the guardrails that make it safe to build on.

Reject the alternative of embedding a package that turns every MCP tool into a first-class provider-visible descriptor: that would bypass every guardrail the spike is designed to preserve.

## 7. Rollback

Revert the spike commit. Because the only additions are `spike/pi-native-agent/*`, `docs/native-agent-mcp-proxy-spike.md`, and one line in `tests/run-unit-tests.sh`, existing read-only, patch, command, workflow, and certification behavior remains valid when the spike is absent.
