// ---------------------------------------------------------------------------
// Toy local MCP-style server for the HOK-3055 proxy compatibility spike.
//
// Deterministic, dependency-free (node builtins only), and stdio-only. It
// speaks a minimal line-delimited JSON-RPC-ish protocol so the spike harness
// can exercise the proxy seams a real MCP adapter would sit behind WITHOUT
// installing pi-mcp-adapter, @modelcontextprotocol/*, or opening any socket.
//
// Protocol (one JSON object per line on stdin, one JSON line per response on
// stdout):
//
//   -> {"id":1,"method":"initialize"}
//   <- {"id":1,"result":{"serverInfo":{"name":"toy-mcp","version":"0.0.0"}}}
//
//   -> {"id":2,"method":"tools/list"}
//   <- {"id":2,"result":{"tools":[{name,description,inputSchema}, ...]}}
//
//   -> {"id":3,"method":"tools/call","params":{"name":"echo","arguments":{...}}}
//   <- {"id":3,"result":{"content":[{"type":"text","text":"..."}],"callSeq":1}}
//
// Tool behaviors (selected by tool name) cover every failure mode the spike
// must prove:
//   echo           -> success; echoes JSON arguments
//   slow           -> waits arguments.ms (default 60_000) before replying, so
//                     the harness can prove per-call timeout / AbortSignal
//   emit_secret    -> returns a result that embeds fake credentials, so the
//                     harness can prove redaction runs on external content
//   emit_malformed -> writes a non-JSON line to stdout, so the harness can
//                     prove malformed payloads become a stable error result
//
// The server counts every `tools/call` it actually receives in `callSeq` and
// returns it on each response. The harness relies on the fact that a denied
// call is never written to this process's stdin, so `callSeq` never advances
// for blocked requests — the deterministic proof that policy runs before the
// server is reached.
//
// SIGTERM / SIGINT / stdin end -> clean exit(0). The harness always terminates
// the child in a finally block, so no toy server outlives its session.
// ---------------------------------------------------------------------------

import { createInterface } from 'node:readline';

const TOOL_COUNT = clampToolCount(process.env.TOY_MCP_TOOL_COUNT);
let callSeq = 0;
const pendingTimers = new Set();

function clampToolCount(raw) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return Math.min(parsed, 500);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// Discovery payload. The count is configurable so the spike can prove the
// provider-facing proxy schema stays bounded as the underlying tool count
// grows (3 vs 200 discovered tools -> one fixed mcp_call schema either way).
function listTools() {
  const named = ['echo', 'slow', 'emit_secret', 'emit_malformed'].map((name) => ({
    name,
    description: `toy tool: ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  }));
  const filler = [];
  for (let i = named.length; i < TOOL_COUNT; i++) {
    filler.push({
      name: `filler_${i}`,
      description: `filler tool #${i} used only to inflate the discovered catalog`,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    });
  }
  return [...named, ...filler].slice(0, Math.max(TOOL_COUNT, named.length));
}

function callTool(name, args) {
  callSeq++;
  switch (name) {
    case 'echo':
      return { result: { content: [{ type: 'text', text: JSON.stringify(args ?? {}) }], callSeq } };
    case 'emit_secret':
      // Fake, obviously-non-real credentials so redaction has something to hit.
      return {
        result: {
          content: [
            {
              type: 'text',
              text:
                'connected with token sk-abcdEFGH1234567890ijklmnopqrst ' +
                'and Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
            },
          ],
          details: { apiKey: 'sk-abcdEFGH1234567890ijklmnopqrst', host: 'toy.local' },
          callSeq,
        },
      };
    case 'slow': {
      const ms = Number.isFinite(args?.ms) ? Number(args.ms) : 60_000;
      // Intentionally do NOT reply until the timer fires. The harness aborts /
      // times out well before this, proving cancellation is enforced by
      // Wavemill rather than by waiting on the server.
      const id = currentRequestId;
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        send({ id, result: { content: [{ type: 'text', text: 'slow-done' }], callSeq } });
      }, ms);
      pendingTimers.add(timer);
      return undefined; // reply deferred
    }
    case 'emit_malformed':
      // Write a line that is not valid JSON. The harness parser must turn this
      // into a stable error result rather than throwing.
      process.stdout.write('this is not valid json }{\n');
      return undefined;
    default:
      return { error: { code: 'unknown_tool', message: `unknown tool: ${name}` } };
  }
}

let currentRequestId = null;

function handle(request) {
  currentRequestId = request.id ?? null;
  switch (request.method) {
    case 'initialize':
      return { id: request.id, result: { serverInfo: { name: 'toy-mcp', version: '0.0.0' } } };
    case 'tools/list':
      return { id: request.id, result: { tools: listTools() } };
    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {};
      const outcome = callTool(name, args);
      if (outcome === undefined) return undefined; // deferred / side-channel
      return { id: request.id, ...outcome };
    }
    default:
      return { id: request.id, error: { code: 'unknown_method', message: `unknown method: ${request.method}` } };
  }
}

function shutdown() {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    send({ error: { code: 'parse_error', message: 'invalid request json' } });
    return;
  }
  const response = handle(request);
  if (response !== undefined) send(response);
});
rl.on('close', shutdown);
