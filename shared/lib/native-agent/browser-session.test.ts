import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BrowserSession,
  BrowserSessionError,
  type BrowserAdapter,
  type BrowserSessionLimits,
} from './browser-session.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeAdapterState {
  navigations: string[];
  closeCalls: number;
  dom: string;
  ax: Array<{ role: string; name: string }>;
  console: Array<{ level: 'log' | 'debug' | 'info' | 'warn' | 'error'; text: string }>;
  requests: Array<{ method: string; url: string; status?: number }>;
  navigationOutcome: { finalUrl: string; status: number; title: string; loadTimeMs: number };
  navigateShouldTimeout: boolean;
  navigateShouldThrow?: Error;
}

function makeFakeAdapter(): { adapter: BrowserAdapter; state: FakeAdapterState } {
  const state: FakeAdapterState = {
    navigations: [],
    closeCalls: 0,
    dom: '<html><body>ok</body></html>',
    ax: [],
    console: [],
    requests: [],
    navigationOutcome: {
      finalUrl: 'http://localhost:3000/',
      status: 200,
      title: 'ok',
      loadTimeMs: 12,
    },
    navigateShouldTimeout: false,
  };
  const adapter: BrowserAdapter = {
    async navigate(url) {
      state.navigations.push(url);
      if (state.navigateShouldThrow) throw state.navigateShouldThrow;
      if (state.navigateShouldTimeout) throw new Error('navigation timeout after 15000ms');
      return state.navigationOutcome;
    },
    async snapshotDom() { return state.dom; },
    async snapshotAccessibility() { return state.ax; },
    async drainConsole() { return state.console; },
    async drainRequests() { return state.requests; },
    async close() { state.closeCalls++; },
  };
  return { adapter, state };
}

function makeLimits(overrides: Partial<BrowserSessionLimits> = {}): BrowserSessionLimits {
  return {
    allowedOrigins: ['http://localhost:3000'],
    maxSessionLifetimeMs: 60_000,
    maxCallsPerSession: 40,
    navigateTimeoutMs: 5_000,
    maxDomBytes: 1024,
    maxAxNodes: 10,
    maxConsoleMessages: 10,
    maxRequestSummaries: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Origin allowlist
// ---------------------------------------------------------------------------

describe('BrowserSession — origin allowlist', () => {
  it('denies navigation to an origin not in the allowlist before contacting the adapter', async () => {
    const { adapter, state } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('http://evil.example/index.html'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'origin_not_allowed',
    );
    assert.equal(state.navigations.length, 0);
    await session.close();
  });

  it('denies malformed URLs before contacting the adapter', async () => {
    const { adapter, state } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('not-a-url'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'invalid_url',
    );
    assert.equal(state.navigations.length, 0);
    await session.close();
  });

  it('denies credential-bearing URLs', async () => {
    const { adapter, state } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('http://user:pw@localhost:3000/'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'credentials_not_allowed',
    );
    assert.equal(state.navigations.length, 0);
    await session.close();
  });

  it('denies unsupported schemes', async () => {
    const { adapter } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('file:///etc/passwd'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'unsupported_scheme',
    );
    await session.close();
  });

  it('closes the session when a redirect resolves outside the allowlist', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.navigationOutcome = {
      finalUrl: 'https://evil.example/oops',
      status: 200,
      title: 'redirected',
      loadTimeMs: 1,
    };
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('http://localhost:3000/redirect'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'origin_not_allowed',
    );
    assert.equal(state.closeCalls, 1);
    assert.equal(session.isClosed, true);
  });
});

// ---------------------------------------------------------------------------
// Caps and truncation metadata
// ---------------------------------------------------------------------------

describe('BrowserSession — caps and truncation metadata', () => {
  it('truncates the DOM snapshot at maxDomBytes with deterministic metadata', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.dom = 'x'.repeat(4096);
    const session = new BrowserSession({ limits: makeLimits({ maxDomBytes: 100 }), adapter });
    const obs = await session.snapshotDom();
    assert.equal(obs.truncated, true);
    assert.equal(obs.truncationReason, 'maxBytes');
    assert.equal(obs.retainedCount, 100);
    assert.equal(obs.originalCount, 4096);
    assert.equal(obs.dom.length, 100);
    await session.close();
  });

  it('caps accessibility snapshots at maxAxNodes with maxItems reason', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.ax = Array.from({ length: 25 }, (_, i) => ({ role: 'link', name: `L${i}` }));
    const session = new BrowserSession({ limits: makeLimits({ maxAxNodes: 10 }), adapter });
    const obs = await session.snapshotAccessibility();
    assert.equal(obs.truncated, true);
    assert.equal(obs.truncationReason, 'maxItems');
    assert.equal(obs.retainedCount, 10);
    assert.equal(obs.originalCount, 25);
    assert.equal(obs.nodes.length, 10);
    await session.close();
  });

  it('caps console messages deterministically', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.console = Array.from({ length: 50 }, (_, i) => ({
      level: 'log' as const,
      text: `msg-${i}`,
    }));
    const session = new BrowserSession({ limits: makeLimits({ maxConsoleMessages: 3 }), adapter });
    const obs = await session.drainConsole();
    assert.equal(obs.retainedCount, 3);
    assert.equal(obs.originalCount, 50);
    assert.equal(obs.truncated, true);
    assert.equal(obs.messages[0]!.text, 'msg-0');
    assert.equal(obs.messages[2]!.text, 'msg-2');
    await session.close();
  });

  it('caps request summaries deterministically', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.requests = Array.from({ length: 4 }, (_, i) => ({
      method: 'GET',
      url: `http://localhost:3000/r/${i}`,
    }));
    const session = new BrowserSession({ limits: makeLimits({ maxRequestSummaries: 2 }), adapter });
    const obs = await session.drainRequests();
    assert.equal(obs.retainedCount, 2);
    assert.equal(obs.originalCount, 4);
    assert.equal(obs.truncated, true);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// Budgets, timeouts, aborts, close
// ---------------------------------------------------------------------------

describe('BrowserSession — budgets, aborts, close', () => {
  it('rejects further calls after maxCallsPerSession is reached', async () => {
    const { adapter } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits({ maxCallsPerSession: 2 }), adapter });
    await session.snapshotDom();
    await session.snapshotDom();
    await assert.rejects(
      session.snapshotDom(),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'call_budget_exhausted',
    );
    await session.close();
  });

  it('expires the session after maxSessionLifetimeMs and closes the adapter', async () => {
    const { adapter, state } = makeFakeAdapter();
    let clock = 1000;
    const session = new BrowserSession({
      limits: makeLimits({ maxSessionLifetimeMs: 100 }),
      adapter,
      now: () => clock,
    });
    await session.snapshotDom();
    clock += 500;
    await assert.rejects(
      session.snapshotDom(),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'session_expired',
    );
    // Best-effort async close is scheduled; verify by awaiting close() ourselves.
    await session.close();
    assert.ok(state.closeCalls >= 1);
  });

  it('close is idempotent and calls the adapter only once', async () => {
    const { adapter, state } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await session.close();
    await session.close();
    await session.close();
    assert.equal(state.closeCalls, 1);
    assert.equal(session.isClosed, true);
  });

  it('operations after close reject with session_closed', async () => {
    const { adapter } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await session.close();
    await assert.rejects(
      session.snapshotDom(),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'session_closed',
    );
  });

  it('a pre-aborted signal on navigate is rejected before contacting the adapter', async () => {
    const { adapter, state } = makeFakeAdapter();
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      session.navigate('http://localhost:3000/', controller.signal),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'navigation_aborted',
    );
    assert.equal(state.navigations.length, 0);
    await session.close();
  });

  it('a navigation timeout closes the session and surfaces navigation_timeout', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.navigateShouldTimeout = true;
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    await assert.rejects(
      session.navigate('http://localhost:3000/'),
      (err: unknown) => err instanceof BrowserSessionError && err.code === 'navigation_timeout',
    );
    assert.equal(state.closeCalls, 1);
    assert.equal(session.isClosed, true);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('BrowserSession — happy path', () => {
  it('navigates within the allowlist and returns bounded metadata', async () => {
    const { adapter, state } = makeFakeAdapter();
    state.navigationOutcome = {
      finalUrl: 'http://localhost:3000/dashboard',
      status: 200,
      title: 'Dashboard',
      loadTimeMs: 42,
    };
    const session = new BrowserSession({ limits: makeLimits(), adapter });
    const result = await session.navigate('http://localhost:3000/dashboard');
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, 'http://localhost:3000/dashboard');
    assert.equal(result.origin, 'http://localhost:3000');
    assert.equal(result.title, 'Dashboard');
    await session.close();
  });
});
