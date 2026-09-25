// ---------------------------------------------------------------------------
// Bounded child-process JSON-RPC/stdio manager for MCP servers.
//
// Wavemill spawns each server lazily on first call, drives it over newline
// framed JSON-RPC 2.0 (MCP stdio transport), enforces per-server startup /
// call / shutdown timeouts, redacts stderr, caps result payload sizes, and
// guarantees no child process outlives `stopAll`.
//
// Nothing in this file reads tool output, prompt content, or process env
// directly: env allowlisting is applied at spawn time using the resolved
// server config.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from './tools/redaction.ts';
import type { McpServerIdentity } from './tools/types.ts';
import type {
  NativeAgentMcpFamilyConfig,
  NativeAgentMcpFamilyDefaults,
  NativeAgentMcpServerConfig,
} from '../config.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpErrorKind =
  | 'startup_timeout'
  | 'rpc_error'
  | 'timeout'
  | 'server_crashed'
  | 'cancelled'
  | 'invalid_response'
  | 'protocol_mismatch'
  | 'over_output_cap'
  | 'tool_not_allowed'
  | 'server_not_allowed';

export interface McpCallSuccess {
  ok: true;
  payload: unknown;
  /** Raw bytes returned to the caller for artifact storage. */
  rawBytes: Uint8Array;
}

export interface McpCallFailure {
  ok: false;
  kind: McpErrorKind;
  message: string;
}

export type McpCallOutcome = McpCallSuccess | McpCallFailure;

export interface McpServerHandle {
  serverName: string;
  identity: McpServerIdentity;
  pid: number | null;
}

export interface McpClientSnapshot {
  servers: Array<{
    serverName: string;
    started: boolean;
    identity?: McpServerIdentity;
    pid?: number | null;
    consecutiveFailures: number;
  }>;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface McpClient {
  ensureStarted(serverName: string): Promise<McpServerHandle>;
  callTool(serverName: string, toolName: string, args: unknown, opts: McpCallOptions): Promise<McpCallOutcome>;
  stopServer(serverName: string, opts?: { reason: string }): Promise<void>;
  stopAll(reason: string): Promise<void>;
  snapshot(): McpClientSnapshot;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ResolvedServerConfig {
  serverName: string;
  providerProxy: string;
  command: string;
  args: string[];
  envAllowlist: string[];
  tools: string[];
  class: 'read-only' | 'mutation';
  startupTimeoutMs: number;
  callTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxOutputBytes: number;
  failureThreshold: number;
}

interface PendingRpc {
  id: number;
  resolve: (payload: unknown) => void;
  reject: (err: McpCallFailure) => void;
  timer: NodeJS.Timeout | null;
}

interface ServerRuntime {
  config: ResolvedServerConfig;
  child?: ChildProcess;
  identity?: McpServerIdentity;
  nextRpcId: number;
  pending: Map<number, PendingRpc>;
  buffer: string;
  starting?: Promise<McpServerHandle>;
  stopping?: Promise<void>;
  consecutiveFailures: number;
  crashed: boolean;
  killedByClient: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const FAMILY_DEFAULTS: Required<NativeAgentMcpFamilyDefaults> = Object.freeze({
  startupTimeoutMs: 5_000,
  callTimeoutMs: 15_000,
  shutdownTimeoutMs: 3_000,
  maxOutputBytes: 64 * 1024,
  failureThreshold: 3,
});

function resolveServerConfig(
  serverName: string,
  server: NativeAgentMcpServerConfig,
  familyDefaults: NativeAgentMcpFamilyDefaults | undefined,
): ResolvedServerConfig {
  const startupTimeoutMs = server.startupTimeoutMs ?? familyDefaults?.startupTimeoutMs ?? FAMILY_DEFAULTS.startupTimeoutMs;
  const callTimeoutMs = server.callTimeoutMs ?? familyDefaults?.callTimeoutMs ?? FAMILY_DEFAULTS.callTimeoutMs;
  const shutdownTimeoutMs =
    server.shutdownTimeoutMs ?? familyDefaults?.shutdownTimeoutMs ?? FAMILY_DEFAULTS.shutdownTimeoutMs;
  const maxOutputBytes = server.maxOutputBytes ?? familyDefaults?.maxOutputBytes ?? FAMILY_DEFAULTS.maxOutputBytes;
  const failureThreshold =
    server.failureThreshold ?? familyDefaults?.failureThreshold ?? FAMILY_DEFAULTS.failureThreshold;
  return {
    serverName,
    providerProxy: server.providerProxy,
    command: server.command,
    args: [...server.args],
    envAllowlist: [...server.envAllowlist],
    tools: [...server.tools],
    class: server.class ?? 'read-only',
    startupTimeoutMs,
    callTimeoutMs,
    shutdownTimeoutMs,
    maxOutputBytes,
    failureThreshold,
  };
}

function normalizeErrorMessage(message: string): string {
  const result = redactSecrets(message);
  return result.text;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateMcpClientOptions {
  family: NativeAgentMcpFamilyConfig | undefined;
  /**
   * Optional overrides for tests: process env baseline that seeds each spawn,
   * plus a `now()` clock. Production callers pass nothing.
   */
  processEnv?: NodeJS.ProcessEnv;
  /** Optional logger for stderr redaction outputs (defaults to console.warn). */
  logStderr?: (serverName: string, redactedLine: string) => void;
}

export function createMcpClient(opts: CreateMcpClientOptions): McpClient {
  const family = opts.family;
  const processEnv = opts.processEnv ?? process.env;
  const logStderr = opts.logStderr ?? ((serverName, line) => {
    console.warn(`[mcp:${serverName}] ${line}`);
  });

  const servers = new Map<string, ServerRuntime>();

  if (family?.servers) {
    for (const [serverName, serverConfig] of Object.entries(family.servers)) {
      servers.set(serverName, {
        config: resolveServerConfig(serverName, serverConfig, family.defaults),
        nextRpcId: 1,
        pending: new Map(),
        buffer: '',
        consecutiveFailures: 0,
        crashed: false,
        killedByClient: false,
      });
    }
  }

  const buildEnv = (allowlist: string[]): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      PATH: processEnv.PATH,
      HOME: processEnv.HOME,
    };
    for (const key of allowlist) {
      if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
        env[key] = processEnv[key];
      }
    }
    return env;
  };

  const sendRpc = (runtime: ServerRuntime, method: string, params?: unknown): number => {
    if (!runtime.child?.stdin) {
      throw new Error('server not started');
    }
    const id = runtime.nextRpcId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    runtime.child.stdin.write(message + '\n');
    return id;
  };

  const sendNotification = (runtime: ServerRuntime, method: string, params?: unknown): void => {
    if (!runtime.child?.stdin || runtime.child.stdin.destroyed) return;
    try {
      const message = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
      runtime.child.stdin.write(message + '\n');
    } catch {
      // Ignore: server may already be dead.
    }
  };

  const rejectAllPending = (runtime: ServerRuntime, failure: McpCallFailure): void => {
    for (const pending of runtime.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(failure);
    }
    runtime.pending.clear();
  };

  const attachRuntimeHandlers = (runtime: ServerRuntime): void => {
    const child = runtime.child!;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      runtime.buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = runtime.buffer.indexOf('\n')) !== -1) {
        const line = runtime.buffer.slice(0, newlineIndex).trim();
        runtime.buffer = runtime.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message: {
          id?: number | string | null;
          result?: unknown;
          error?: { code: number; message: string };
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || message.id === null) continue;
        const pending = runtime.pending.get(message.id as number);
        if (!pending) continue;
        runtime.pending.delete(message.id as number);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) {
          pending.reject({
            ok: false,
            kind: 'rpc_error',
            message: normalizeErrorMessage(message.error.message),
          });
          continue;
        }
        pending.resolve(message.result);
      }
    });

    child.stderr?.setEncoding('utf8');
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, idx);
        stderrBuf = stderrBuf.slice(idx + 1);
        if (!line.trim()) continue;
        const { text } = redactSecrets(line);
        logStderr(runtime.config.serverName, text);
      }
    });

    child.on('exit', () => {
      const wasKilled = runtime.killedByClient;
      runtime.crashed = !wasKilled;
      const failure: McpCallFailure = {
        ok: false,
        kind: wasKilled ? 'cancelled' : 'server_crashed',
        message: wasKilled ? 'server stopped by client' : 'server exited unexpectedly',
      };
      rejectAllPending(runtime, failure);
      runtime.child = undefined;
      runtime.identity = undefined;
    });

    child.on('error', (err) => {
      rejectAllPending(runtime, {
        ok: false,
        kind: 'server_crashed',
        message: normalizeErrorMessage((err as Error).message),
      });
    });
  };

  const startServer = async (runtime: ServerRuntime): Promise<McpServerHandle> => {
    if (runtime.starting) return runtime.starting;
    if (runtime.child && runtime.identity) {
      return {
        serverName: runtime.config.serverName,
        identity: runtime.identity,
        pid: runtime.child.pid ?? null,
      };
    }
    runtime.crashed = false;
    runtime.killedByClient = false;
    runtime.buffer = '';
    runtime.consecutiveFailures = 0;

    const promise = new Promise<McpServerHandle>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(runtime.config.command, runtime.config.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildEnv(runtime.config.envAllowlist),
        });
      } catch (err) {
        reject({
          ok: false,
          kind: 'server_crashed',
          message: normalizeErrorMessage((err as Error).message),
        } as McpCallFailure);
        return;
      }
      runtime.child = child;
      attachRuntimeHandlers(runtime);

      const startupTimer = setTimeout(() => {
        runtime.killedByClient = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject({
          ok: false,
          kind: 'startup_timeout',
          message: `initialize did not complete within ${runtime.config.startupTimeoutMs}ms`,
        } as McpCallFailure);
      }, runtime.config.startupTimeoutMs);

      const initId = runtime.nextRpcId++;
      const initPending: PendingRpc = {
        id: initId,
        timer: null,
        resolve: (result) => {
          clearTimeout(startupTimer);
          const serverInfo = ((result as { serverInfo?: McpServerIdentity })?.serverInfo) ?? {
            name: runtime.config.serverName,
            version: '0.0.0',
          };
          runtime.identity = { name: serverInfo.name, version: serverInfo.version };
          resolve({
            serverName: runtime.config.serverName,
            identity: runtime.identity,
            pid: child.pid ?? null,
          });
        },
        reject: (failure) => {
          clearTimeout(startupTimer);
          reject(failure);
        },
      };
      runtime.pending.set(initId, initPending);

      try {
        child.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: initId,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'wavemill-native', version: '1' },
            },
          }) + '\n',
        );
      } catch (err) {
        clearTimeout(startupTimer);
        runtime.pending.delete(initId);
        reject({
          ok: false,
          kind: 'server_crashed',
          message: normalizeErrorMessage((err as Error).message),
        } as McpCallFailure);
      }
    });

    runtime.starting = promise
      .catch(async (failure) => {
        // Ensure the child is not left running on any startup failure.
        try {
          runtime.child?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        runtime.child = undefined;
        throw failure;
      })
      .finally(() => {
        runtime.starting = undefined;
      });
    return runtime.starting;
  };

  const stopServer = async (serverName: string, reason?: string): Promise<void> => {
    const runtime = servers.get(serverName);
    if (!runtime) return;
    if (runtime.stopping) return runtime.stopping;
    if (!runtime.child) return;
    const child = runtime.child;
    runtime.killedByClient = true;

    runtime.stopping = new Promise<void>((resolve) => {
      const settle = (): void => {
        rejectAllPending(runtime, {
          ok: false,
          kind: 'cancelled',
          message: `server stopped: ${reason ?? 'requested'}`,
        });
        runtime.child = undefined;
        runtime.identity = undefined;
        resolve();
      };

      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        settle();
      };

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, runtime.config.shutdownTimeoutMs);

      child.once('exit', () => {
        clearTimeout(killTimer);
        finish();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        // If SIGTERM cannot be sent, force-kill immediately.
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        clearTimeout(killTimer);
        finish();
      }
    }).finally(() => {
      runtime.stopping = undefined;
    });

    return runtime.stopping;
  };

  const callTool = async (
    serverName: string,
    toolName: string,
    args: unknown,
    options: McpCallOptions,
  ): Promise<McpCallOutcome> => {
    const runtime = servers.get(serverName);
    if (!runtime) {
      return {
        ok: false,
        kind: 'server_not_allowed',
        message: `server not configured: ${serverName}`,
      };
    }
    if (!runtime.config.tools.includes(toolName)) {
      return {
        ok: false,
        kind: 'tool_not_allowed',
        message: `tool not allowlisted: ${serverName}/${toolName}`,
      };
    }
    if (options.signal?.aborted) {
      return { ok: false, kind: 'cancelled', message: 'call aborted before dispatch' };
    }

    try {
      await startServer(runtime);
    } catch (startupFailure) {
      return startupFailure as McpCallFailure;
    }
    if (options.signal?.aborted) {
      return { ok: false, kind: 'cancelled', message: 'call aborted during startup' };
    }

    return new Promise<McpCallOutcome>((resolve) => {
      let settled = false;
      const finalize = (outcome: McpCallOutcome): void => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        if (outcome.ok) {
          runtime.consecutiveFailures = 0;
        } else {
          runtime.consecutiveFailures += 1;
          if (
            runtime.config.failureThreshold > 0 &&
            runtime.consecutiveFailures >= runtime.config.failureThreshold
          ) {
            void stopServer(runtime.config.serverName, 'failure_threshold_exceeded');
          }
        }
        resolve(outcome);
      };

      let rpcId: number;
      try {
        rpcId = sendRpc(runtime, 'tools/call', { name: toolName, arguments: args });
      } catch (err) {
        finalize({
          ok: false,
          kind: 'server_crashed',
          message: normalizeErrorMessage((err as Error).message),
        });
        return;
      }

      const timer = setTimeout(() => {
        runtime.pending.delete(rpcId);
        sendNotification(runtime, 'notifications/cancelled', { requestId: rpcId });
        finalize({
          ok: false,
          kind: 'timeout',
          message: `call timed out after ${options.timeoutMs}ms`,
        });
      }, options.timeoutMs);

      const onAbort = (): void => {
        runtime.pending.delete(rpcId);
        sendNotification(runtime, 'notifications/cancelled', { requestId: rpcId });
        finalize({ ok: false, kind: 'cancelled', message: 'call aborted' });
      };

      const cleanupSignal = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      runtime.pending.set(rpcId, {
        id: rpcId,
        timer,
        resolve: (payload) => {
          const serialized = JSON.stringify(payload ?? null);
          const bytes = encodeUtf8(serialized);
          if (bytes.byteLength > options.maxOutputBytes) {
            finalize({
              ok: false,
              kind: 'over_output_cap',
              message: `payload exceeded ${options.maxOutputBytes} bytes`,
            });
            return;
          }
          finalize({ ok: true, payload, rawBytes: bytes });
        },
        reject: (failure) => {
          finalize(failure);
        },
      });
    });
  };

  const stopAll = async (reason: string): Promise<void> => {
    const promises: Array<Promise<void>> = [];
    for (const runtime of servers.values()) {
      if (runtime.child) {
        promises.push(stopServer(runtime.config.serverName, reason));
      }
    }
    await Promise.all(promises);
  };

  const snapshot = (): McpClientSnapshot => ({
    servers: [...servers.values()].map((runtime) => ({
      serverName: runtime.config.serverName,
      started: Boolean(runtime.child),
      identity: runtime.identity,
      pid: runtime.child?.pid ?? null,
      consecutiveFailures: runtime.consecutiveFailures,
    })),
  });

  return {
    ensureStarted: async (serverName: string) => {
      const runtime = servers.get(serverName);
      if (!runtime) {
        throw Object.assign(new Error(`server not configured: ${serverName}`), {
          kind: 'server_not_allowed' satisfies McpErrorKind,
        });
      }
      return startServer(runtime);
    },
    callTool,
    stopServer: (serverName, opts) => stopServer(serverName, opts?.reason),
    stopAll,
    snapshot,
  };
}
