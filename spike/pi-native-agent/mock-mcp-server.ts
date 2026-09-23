// ---------------------------------------------------------------------------
// Deterministic, in-process toy MCP server for the HOK-3055 compatibility spike.
//
// It intentionally exposes only what the proxy adapter needs: an explicit
// start/discover/invoke/stop lifecycle, observable counters, a normal tool, a
// delayed cancellable tool, a malformed-response mode, a secret-bearing
// result, and a synthetic-catalog expansion knob for cardinality tests.
//
// It carries no network sockets, subprocess, or credentials. Wavemill's proxy
// remains the authority for policy, redaction, caps, provenance, and
// transcript records; this file only models the *server side* of an MCP-like
// contract.
// ---------------------------------------------------------------------------

export type MockToolResult =
  | { kind: 'text'; text: string }
  | { kind: 'malformed'; payload: unknown };

export interface MockTool {
  name: string;
  description: string;
  invoke(args: Record<string, unknown>, signal: AbortSignal): Promise<MockToolResult>;
}

export interface MockServerCounters {
  startCalls: number;
  discoverCalls: number;
  invokeCalls: number;
  stopCalls: number;
}

export interface MockMcpServerOptions {
  /** How many synthetic tools to add on top of the fixed set. */
  syntheticCatalogSize?: number;
  /** Milliseconds to delay `slow_echo`. */
  slowEchoDelayMs?: number;
}

type ServerState = 'stopped' | 'starting' | 'ready';

/**
 * In-process MCP-like server. Not thread-safe; a single caller (the adapter)
 * owns it. State transitions are strict: invoking or discovering before
 * `start()` throws, and any call after `stop()` throws.
 */
export class MockMcpServer {
  private state: ServerState = 'stopped';
  private readonly tools: Map<string, MockTool> = new Map();
  private readonly opts: Required<MockMcpServerOptions>;
  public readonly counters: MockServerCounters = {
    startCalls: 0,
    discoverCalls: 0,
    invokeCalls: 0,
    stopCalls: 0,
  };

  constructor(options: MockMcpServerOptions = {}) {
    this.opts = {
      syntheticCatalogSize: options.syntheticCatalogSize ?? 0,
      slowEchoDelayMs: options.slowEchoDelayMs ?? 50,
    };
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`MockMcpServer: cannot start from state=${this.state}`);
    }
    this.state = 'starting';
    this.counters.startCalls += 1;
    this.installTools();
    this.state = 'ready';
  }

  async discover(): Promise<Array<{ name: string; description: string }>> {
    this.assertReady('discover');
    this.counters.discoverCalls += 1;
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MockToolResult> {
    this.assertReady('invoke');
    this.counters.invokeCalls += 1;
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`MockMcpServer: unknown tool "${name}"`);
    }
    return tool.invoke(args, signal);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.counters.stopCalls += 1;
    this.tools.clear();
    this.state = 'stopped';
  }

  isRunning(): boolean {
    return this.state === 'ready';
  }

  private assertReady(op: string): void {
    if (this.state !== 'ready') {
      throw new Error(`MockMcpServer: cannot ${op} from state=${this.state}`);
    }
  }

  private installTools(): void {
    const slowDelay = this.opts.slowEchoDelayMs;

    this.tools.set('echo', {
      name: 'echo',
      description: 'Echo the "message" argument back verbatim.',
      async invoke(args) {
        const message = typeof args.message === 'string' ? args.message : '';
        return { kind: 'text', text: `echo:${message}` };
      },
    });

    this.tools.set('slow_echo', {
      name: 'slow_echo',
      description: 'Echo after a small delay; cancellable via AbortSignal.',
      async invoke(args, signal) {
        const message = typeof args.message === 'string' ? args.message : '';
        return await new Promise<MockToolResult>((resolvePromise, rejectPromise) => {
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolvePromise({ kind: 'text', text: `slow:${message}` });
          }, slowDelay);
          const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            const reason = signal.reason instanceof Error
              ? signal.reason
              : new Error('aborted');
            rejectPromise(reason);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      },
    });

    this.tools.set('malformed_result', {
      name: 'malformed_result',
      description: 'Return a payload that does not match the declared shape.',
      async invoke() {
        return { kind: 'malformed', payload: { unexpected: 42 } };
      },
    });

    this.tools.set('leak_secret', {
      name: 'leak_secret',
      description: 'Return a message containing secret-shaped substrings.',
      async invoke() {
        // Deliberately crafted to match wavemill redaction rules.
        const text = [
          'Here is your api key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
          'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        ].join(' ');
        return { kind: 'text', text };
      },
    });

    this.tools.set('big_result', {
      name: 'big_result',
      description: 'Return a large text blob to exercise output caps.',
      async invoke() {
        return { kind: 'text', text: 'x'.repeat(4096) };
      },
    });

    for (let i = 0; i < this.opts.syntheticCatalogSize; i += 1) {
      const syntheticName = `synthetic_tool_${i}`;
      this.tools.set(syntheticName, {
        name: syntheticName,
        description: `Synthetic tool #${i} for cardinality tests.`,
        async invoke() {
          return { kind: 'text', text: `synthetic:${i}` };
        },
      });
    }
  }
}
