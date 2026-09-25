# Native agent MCP client bridge

The MCP tool bridge lets the native runtime invoke tools exported by an
external Model Context Protocol (MCP) server. The bridge is **opt-in per
repo**, per phase, per (server, tool) pair. Zero servers are available by
default.

## Contract

1. **Exposure, policy, provenance, redaction, transcript identity** stay with
   Wavemill. The MCP proxy path never bypasses the exposure engine
   (`tools/exposure.ts`) or the per-call policy layer (`tools/policies.ts`).
2. **Provider proxy identity** and **logical server/tool identity** are
   recorded independently in the transcript so replay is stable even when the
   live server is gone.
3. **Result payloads** are stored as content-addressed artifacts; only a short
   text summary plus the model-visible content blocks appear inline.
4. **Trust tier**: MCP results carry `sourceKind: mcp_result` → `untrusted`.
   The shared injection scan applies automatically.

## Configuration

Add `nativeAgent.advanced.mcp` to `.wavemill-config.json`:

```jsonc
{
  "nativeAgent": {
    "advanced": {
      "mcp": {
        "enabled": true,
        "allowedPhases": ["coding"],
        // Optional narrow allowlist. When omitted, every (server, tool) pair
        // declared under `servers` becomes eligible.
        "logicalIds": ["mcp.linear.get_issue"],
        "defaults": {
          "startupTimeoutMs": 5000,
          "callTimeoutMs": 15000,
          "shutdownTimeoutMs": 3000,
          "maxOutputBytes": 65536,
          "failureThreshold": 3
        },
        "servers": {
          "linear": {
            "providerProxy": "pi-mcp-proxy",
            "command": "npx",
            "args": ["@wavemill/linear-mcp"],
            "envAllowlist": ["LINEAR_MCP_TOKEN"],
            "tools": ["get_issue", "list_projects"],
            "class": "read-only"
          }
        }
      }
    }
  }
}
```

Every server declares:

| Field | Required | Notes |
|-------|----------|-------|
| `providerProxy` | ✔ | Wavemill-side proxy identifier (recorded in transcripts). |
| `command`, `args` | ✔ | Server executable and argv. `args` may be empty. |
| `envAllowlist` | ✔ | Process-env variables that survive the spawn allowlist. |
| `tools` | ✔ | Non-empty list of logical tool names. Wildcards forbidden. |
| `class` | – | `read-only` (default) or `mutation`. |
| `startupTimeoutMs`, `callTimeoutMs`, `shutdownTimeoutMs`, `maxOutputBytes`, `failureThreshold` | – | Per-server overrides for family defaults. |

## Descriptor identity

Each (server, tool) pair produces one Wavemill `ToolDescriptor`:

- `metadata.name` = `mcp__<serverName>__<toolName>`
- `metadata.logicalId` = `mcp.<serverName>.<toolName>`
- `metadata.family` = `mcp`
- `metadata.provenance` = `external-untrusted`
- `metadata.certificationRequirement` = `workflow`
- `metadata.policy.pathMode` = `none`, `.network` = `allowlisted`,
  `.redactionProfile` = `secrets`.

## Error taxonomy

Failures come back as a normalized `McpCallOutcome`:

| Kind | Cause |
|------|-------|
| `startup_timeout` | `initialize` did not complete inside `startupTimeoutMs`. Child is killed. |
| `rpc_error` | Server returned a JSON-RPC error object. |
| `timeout` | Call did not respond inside `callTimeoutMs`. Client sends `notifications/cancelled`. |
| `server_crashed` | Child exited unexpectedly. Next call respawns lazily. |
| `cancelled` | Caller `AbortSignal` fired, or `stopServer`/`stopAll` ran. |
| `over_output_cap` | Payload exceeded `maxOutputBytes`. Payload is dropped, not returned. |
| `tool_not_allowed` | Logical tool is not in the server's `tools` array. |
| `server_not_allowed` | Server name is not configured. |
| `invalid_response`, `protocol_mismatch` | Reserved for future MCP protocol enforcement. |

The `message` field is always redacted through the shared secret profile.

## Lifecycle

- Servers are spawned **lazily** on first call.
- `stopAll(reason)` is called on both normal loop completion and error paths.
- `stopServer` is invoked automatically after `failureThreshold` consecutive
  failures (default 3). The next call respawns.
- Every child process gets `SIGTERM` first, then `SIGKILL` after
  `shutdownTimeoutMs`.

## Rollback

The bridge is inert until a repo sets `nativeAgent.advanced.mcp.enabled: true`
and declares at least one server with a non-empty `tools` array. Removing the
config entry disables the family at next launch; there is no persisted state
to clean up.
