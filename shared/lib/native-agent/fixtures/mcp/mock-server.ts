// ---------------------------------------------------------------------------
// Deterministic mock MCP server.
//
// Newline-framed JSON-RPC 2.0 over stdio. No real network, no credentials.
// Scenarios are picked via `--scenario <name>` on argv or the WAVEMILL_MCP_SCENARIO
// env variable. See `scenarios.ts` for the full list.
//
// Intentionally kept to Node built-ins so it can be spawned by `process.exec`
// via `node --loader tsx ...` from unit tests without extra tooling.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OVERSIZE_BYTES,
  DEFAULT_SLOW_DELAY_MS,
  FAKE_SECRET_LITERAL,
  INJECTION_EXCERPT,
  type McpMockScenario,
} from './scenarios.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseArgs(argv: string[]): { scenario: McpMockScenario; slowDelayMs: number; oversizeBytes: number } {
  let scenario: McpMockScenario = 'success';
  let slowDelayMs = DEFAULT_SLOW_DELAY_MS;
  let oversizeBytes = DEFAULT_OVERSIZE_BYTES;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario' && argv[i + 1]) {
      scenario = argv[i + 1] as McpMockScenario;
      i++;
    } else if (arg === '--slow-delay-ms' && argv[i + 1]) {
      slowDelayMs = Number(argv[i + 1]);
      i++;
    } else if (arg === '--oversize-bytes' && argv[i + 1]) {
      oversizeBytes = Number(argv[i + 1]);
      i++;
    }
  }
  const envScenario = process.env.WAVEMILL_MCP_SCENARIO as McpMockScenario | undefined;
  if (envScenario) scenario = envScenario;
  const envSlow = process.env.WAVEMILL_MCP_SLOW_DELAY_MS;
  if (envSlow) slowDelayMs = Number(envSlow);
  const envOversize = process.env.WAVEMILL_MCP_OVERSIZE_BYTES;
  if (envOversize) oversizeBytes = Number(envOversize);
  return { scenario, slowDelayMs, oversizeBytes };
}

function writeResponse(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function handleRequest(
  req: JsonRpcRequest,
  opts: { scenario: McpMockScenario; slowDelayMs: number; oversizeBytes: number },
): void {
  const { scenario, slowDelayMs, oversizeBytes } = opts;
  const id = req.id ?? null;

  if (req.method === 'initialize') {
    if (scenario === 'crash-on-init') {
      // Deliberately silent — never reply to initialize. The client must trip
      // its startupTimeoutMs.
      return;
    }
    writeResponse({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock', version: '0.0.1' },
      },
    });
    return;
  }

  if (req.method === 'tools/list') {
    writeResponse({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } },
          { name: 'noop', description: 'No-op tool', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }

  if (req.method === 'tools/call') {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolName = params.name ?? '';
    const args = params.arguments ?? {};

    if (scenario === 'crash-mid-call') {
      // Simulate a server crash by exiting the process; the client sees EOF on
      // stdout and normalizes to `server_crashed`.
      process.exit(2);
      return;
    }

    if (scenario === 'secret-leaker') {
      // Leak a fake API key into stderr *and* into the payload text. The
      // client must redact both before they land in the outcome message or the
      // stored artifact.
      process.stderr.write(`token=${FAKE_SECRET_LITERAL}\n`);
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Result contains ${FAKE_SECRET_LITERAL}` }],
        },
      });
      return;
    }

    if (scenario === 'oversize') {
      const filler = 'x'.repeat(oversizeBytes);
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: filler }],
        },
      });
      return;
    }

    if (scenario === 'injection-attempt') {
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: INJECTION_EXCERPT }],
        },
      });
      return;
    }

    const respond = (): void => {
      writeResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ tool: toolName, echoed: args }) }],
        },
      });
    };

    if (scenario === 'slow') {
      setTimeout(respond, slowDelayMs);
    } else {
      respond();
    }
    return;
  }

  if (req.method === 'notifications/cancelled') {
    // Fire-and-forget notification; no reply expected.
    return;
  }

  // Unknown method → JSON-RPC error.
  writeResponse({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${req.method}` },
  });
}

function runMockServer(): void {
  const opts = parseArgs(process.argv.slice(2));
  let buffer = '';

  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        writeResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `parse error: ${(err as Error).message}` },
        });
        continue;
      }
      handleRequest(req, opts);
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Spawn helper for tests
// ---------------------------------------------------------------------------

export interface SpawnMockMcpServerOptions {
  scenario: McpMockScenario;
  slowDelayMs?: number;
  oversizeBytes?: number;
}

/**
 * Spawn the mock server as a child process via `tsx` so tests can drive it
 * end-to-end without a bundling step. Returns the child process; the caller
 * is responsible for `kill`ing it (or letting `stopAll` do that).
 */
export function spawnMockMcpServer(opts: SpawnMockMcpServerOptions): ChildProcess {
  const scriptPath = fileURLToPath(import.meta.url);
  const args: string[] = [
    '--import',
    'tsx',
    scriptPath,
    '--scenario',
    opts.scenario,
  ];
  if (opts.slowDelayMs !== undefined) {
    args.push('--slow-delay-ms', String(opts.slowDelayMs));
  }
  if (opts.oversizeBytes !== undefined) {
    args.push('--oversize-bytes', String(opts.oversizeBytes));
  }
  return spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
}

// Auto-run when invoked directly (as an entry-point script).
const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  runMockServer();
}
